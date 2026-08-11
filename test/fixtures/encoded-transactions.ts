/**
 * Deterministic EvmV1 encoded-transaction fixtures for AttestLine tests.
 *
 * The encoding replicates, byte-for-byte, the format produced by the official
 * proof builder / `@gluwa/usc-sdk` `abiEncode` for legacy (type 0) transactions:
 *
 *   abi.encode(uint8 txType, bytes[] chunks)
 *     chunks[0] = abi.encode(uint64 nonce, uint64 gasLimit, address from,
 *                            bool toIsNull, address to, uint256 value, bytes data)
 *     chunks[1] = abi.encode(uint128 gasPrice, uint256 v, bytes32 r, bytes32 s)
 *     chunks[2] = abi.encode(uint8 status, uint64 gasUsed,
 *                            tuple(address,bytes32[],bytes)[] logs, bytes bloom)
 *
 * The Merkle proofs use the canonical Keccak scheme of the Creditcoin block
 * prover (see `@gluwa/usc-sdk` `KeccakMerkleTree`):
 *
 *   leaf  = keccak256(0x00 ‖ txBytes)
 *   inner = keccak256(0x01 ‖ left ‖ right)   (right padded with ZERO_HASH)
 *
 * and the sibling path encodes the transaction index LSB-first
 * (sibling[i].isLeft == true  ⇒ bit i of the index is 1).
 *
 * Everything here is pure and deterministic — no network access.
 */
import { AbiCoder, getAddress, keccak256, solidityPacked, toUtf8Bytes, zeroPadValue } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** keccak256("CreditActivityRecorded(address,uint256)") */
export const CREDIT_ACTIVITY_EVENT_SIGNATURE = keccak256(
  toUtf8Bytes("CreditActivityRecorded(address,uint256)")
);

/** keccak256("TransactionVerified(uint64,uint64,uint64)") */
export const TRANSACTION_VERIFIED_EVENT_SIGNATURE = keccak256(
  toUtf8Bytes("TransactionVerified(uint64,uint64,uint64)")
);

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const coder = AbiCoder.defaultAbiCoder();

/** Dummy "transactions" that fill the rest of the attested block. */
const DUMMY_LEAVES: string[] = [
  keccak256(toUtf8Bytes("attestline.fixture.dummy.0")),
  keccak256(toUtf8Bytes("attestline.fixture.dummy.1")),
  keccak256(toUtf8Bytes("attestline.fixture.dummy.2")),
  keccak256(toUtf8Bytes("attestline.fixture.dummy.3")),
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LogLike {
  address: string;
  topics: string[];
  data: string;
}

export interface BuildEncodedTxParams {
  /** Address that emits the CreditActivityRecorded log (must match AttestLine.sourceContract). */
  sourceContract: string;
  /** Indexed account in the event (must match msg.sender at request time). */
  account: string;
  /** Attested amount (wei). */
  amount: bigint;
  /** Receipt status; 1 = success (default). Set 0 to build a failed-transaction fixture. */
  receiptStatus?: number;
  /** Source-chain sender of the transaction (defaults to `account`). */
  txFrom?: string;
  /** Source-chain recipient of the transaction (defaults to `sourceContract`). */
  txTo?: string;
  /** Override the receipt logs entirely (e.g. empty, or a foreign event). */
  logs?: LogLike[];
  nonce?: number;
  gasLimit?: number;
  gasPrice?: bigint;
  gasUsed?: number;
}

export interface EncodedTxFixture {
  chainKey: number;
  blockHeight: number;
  leafIndex: number;
  txIndex: number;
  encodedTx: string;
  merkleRoot: string;
  siblings: { hash: string; isLeft: boolean }[];
  lowerEndpointDigest: string;
  continuityRoots: string[];
  /** The raw receipt log the encoded tx carries (for client-side pre-validation). */
  log: LogLike;
  sourceContract: string;
  account: string;
  amount: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keccak Merkle tree (mirrors @gluwa/usc-sdk KeccakMerkleTree)
// ─────────────────────────────────────────────────────────────────────────────

export function hashLeaf(leaf: string): string {
  return keccak256(solidityPacked(["uint8", "bytes"], [0, leaf]));
}

export function hashInner(left: string, right: string): string {
  return keccak256(solidityPacked(["uint8", "bytes32", "bytes32"], [1, left, right]));
}

export interface MerkleProofData {
  root: string;
  siblings: { hash: string; isLeft: boolean }[];
}

/** Build a Merkle proof for `leafIndex` over `leaves` (LSB-first sibling path). */
export function buildMerkleProof(leaves: string[], leafIndex: number): MerkleProofData {
  if (leaves.length === 0) {
    throw new Error("buildMerkleProof: no leaves");
  }
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`buildMerkleProof: leafIndex ${leafIndex} out of range`);
  }
  const levels: string[][] = [leaves.map(hashLeaf)];
  let current = levels[0];
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashInner(current[i], current[i + 1] ?? ZERO_HASH));
    }
    levels.push(next);
    current = next;
  }

  const root = levels[levels.length - 1][0];
  let idx = leafIndex;
  const siblings: { hash: string; isLeft: boolean }[] = [];
  for (let level = 0; level < levels.length - 1; level++) {
    const siblingOffset = 1 - (idx % 2);
    const siblingIndex = idx + 2 * siblingOffset - 1;
    siblings.push({
      hash: levels[level][siblingIndex] ?? ZERO_HASH,
      isLeft: siblingOffset === 0,
    });
    idx = Math.floor(idx / 2);
  }
  return { root, siblings };
}

// ─────────────────────────────────────────────────────────────────────────────
// EvmV1 (type 0) encoder — mirrors @gluwa/usc-sdk encoding/abi/v1
// ─────────────────────────────────────────────────────────────────────────────

export function buildEncodedTransaction(params: BuildEncodedTxParams): { encodedTx: string; log: LogLike } {
  const sourceContract = getAddress(params.sourceContract);
  const account = getAddress(params.account);
  const from = getAddress(params.txFrom ?? params.account);
  const to = getAddress(params.txTo ?? params.sourceContract);
  const amount = params.amount;

  const log: LogLike = params.logs
    ? params.logs[0]
    : {
        address: sourceContract,
        topics: [CREDIT_ACTIVITY_EVENT_SIGNATURE, zeroPadValue(account, 32)],
        data: coder.encode(["uint256"], [amount]),
      };

  const logs = params.logs ?? [log];

  // Chunk 1: common transaction fields.
  const common = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [
      BigInt(params.nonce ?? 7),
      BigInt(params.gasLimit ?? 100_000),
      from,
      false,
      to,
      0n,
      coder.encode(["uint256"], [amount]), // recordActivity(uint256) calldata
    ]
  );

  // Chunk 2: type-0 (legacy) specific fields.
  const type0 = coder.encode(
    ["uint128", "uint256", "bytes32", "bytes32"],
    [BigInt(params.gasPrice ?? 1_000_000_000n), 27n, ZERO_HASH, ZERO_HASH]
  );

  // Chunk 3: receipt fields.
  const receipt = coder.encode(
    ["uint8", "uint64", "tuple(address,bytes32[],bytes)[]", "bytes"],
    [
      params.receiptStatus ?? 1,
      BigInt(params.gasUsed ?? 21_000),
      logs.map((l) => [getAddress(l.address), l.topics, l.data]),
      "0x",
    ]
  );

  const encodedTx = coder.encode(["uint8", "bytes[]"], [0, [common, type0, receipt]]);
  return { encodedTx, log };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full fixture: encoded tx + merkle proof over a 4-tx block
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildFixtureParams extends BuildEncodedTxParams {
  chainKey?: number;
  blockHeight?: number;
  leafIndex?: number;
}

/**
 * Build a complete, deterministic proof fixture: an EvmV1-encoded transaction
 * carrying a CreditActivityRecorded event, plus a Merkle proof (root + siblings)
 * placing it inside a 4-transaction attested block, plus a plausible continuity
 * proof. The sibling path yields `txIndex == leafIndex`.
 */
export function buildFixture(params: BuildFixtureParams): EncodedTxFixture {
  const chainKey = params.chainKey ?? 1;
  const blockHeight = params.blockHeight ?? 1_000_000;
  const leafIndex = params.leafIndex ?? 1;

  const { encodedTx, log } = buildEncodedTransaction(params);

  const leaves = DUMMY_LEAVES.slice();
  leaves[leafIndex] = encodedTx;
  const { root, siblings } = buildMerkleProof(leaves, leafIndex);

  return {
    chainKey,
    blockHeight,
    leafIndex,
    txIndex: leafIndex,
    encodedTx,
    merkleRoot: root,
    siblings,
    lowerEndpointDigest: "0x" + "ab".repeat(32),
    continuityRoots: ["0x" + "cd".repeat(32)],
    log,
    sourceContract: getAddress(params.sourceContract),
    account: getAddress(params.account),
    amount: params.amount,
  };
}
