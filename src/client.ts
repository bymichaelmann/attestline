/**
 * AttestLineClient — a TypeScript client for the AttestLine ASC.
 *
 * Wraps the @gluwa/usc-sdk (proof builder + ChainInfo precompile provider) and
 * the AttestLine contract (TypeChain) to provide the end-to-end flow:
 *
 *   1. record activity on the source chain (CreditActivity.recordActivity)
 *   2. wait for the block to be attested on Creditcoin
 *   3. generate a proof of inclusion from the proof builder service
 *   4. decode the attested CreditActivityRecorded event
 *   5. submit requestCreditLine / draw / repay transactions
 *
 * All network I/O goes through the providers/signers supplied by the caller;
 * nothing here reads secrets or configuration directly.
 */
import {
  AbiCoder,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type JsonRpcApiProvider,
  type Signer,
  type TransactionReceipt,
} from "ethers";
import { chainInfo, proofProvider } from "@gluwa/usc-sdk";
import { AttestLine__factory, LineToken__factory, type AttestLine, type LineToken } from "../typechain-types";
import type { CreditLineView, DecodedCreditActivity, ProofWithActivity } from "./types";

/** keccak256("CreditActivityRecorded(address,uint256)") — must match contracts/CreditActivity.sol. */
export const CREDIT_ACTIVITY_EVENT_SIGNATURE = keccak256(
  toUtf8Bytes("CreditActivityRecorded(address,uint256)")
);

export interface AttestLineClientOptions {
  /** JSON-RPC provider for the Creditcoin network (contract reads + ChainInfo precompile). */
  creditcoinProvider: JsonRpcApiProvider;
  /** JSON-RPC provider for the source chain (transaction lookups). */
  sourceProvider: JsonRpcApiProvider;
  /** Proof builder service URL (e.g. https://prover.cc3-testnet.creditcoin.network). */
  proofBuilderUrl: string;
  /** Chain key of the source chain on Creditcoin (1 = Ethereum Sepolia). */
  chainKey: number;
  /** Address of the deployed AttestLine contract. */
  attestLineAddress: string;
  /** Address of the deployed LineToken contract. */
  lineTokenAddress: string;
  /** Address of the source-chain CreditActivity contract. */
  sourceContractAddress: string;
  /** Poll interval for waitUntilHeightAttested (default 15s). */
  proofPollIntervalMs?: number;
  /** Timeout for waitUntilHeightAttested (default 15m). */
  proofTimeoutMs?: number;
  /** Optional pre-built contract instances (used for unit tests / DI). */
  attestLineContract?: AttestLine;
  lineTokenContract?: LineToken;
}

const coder = AbiCoder.defaultAbiCoder();

/**
 * Decode a CreditActivityRecorded event from an EvmV1 ABI-encoded transaction
 * (the format attested by the block prover). Mirrors EvmV1Decoder's layout:
 * abi.encode(uint8 txType, bytes[] chunks) with the receipt in the last chunk.
 */
export function decodeCreditActivityFromEncodedTx(
  txBytes: string,
  eventSignature: string = CREDIT_ACTIVITY_EVENT_SIGNATURE
): { account: string; amount: bigint; emitter: string } {
  const [txType, chunks] = coder.decode(["uint8", "bytes[]"], txBytes);
  const type = Number(txType);
  if (type > 4) {
    throw new Error(`Unsupported transaction type: ${type}`);
  }
  const receiptChunkIndex = type <= 2 ? 2 : 3;
  const [, , logs] = coder.decode(
    ["uint8", "uint64", "tuple(address,bytes32[],bytes)[]", "bytes"],
    chunks[receiptChunkIndex]
  );
  for (const log of logs) {
    const [address, topics, data] = log as [string, string[], string];
    if (topics.length > 0 && topics[0].toLowerCase() === eventSignature.toLowerCase()) {
      if (topics.length !== 2) {
        throw new Error("Invalid CreditActivityRecorded topics");
      }
      return {
        account: getAddress("0x" + topics[1].slice(26)),
        amount: BigInt(data),
        emitter: getAddress(address),
      };
    }
  }
  throw new Error("No CreditActivityRecorded event found in encoded transaction");
}

/**
 * Decode a CreditActivityRecorded event from a standard (non-encoded) receipt.
 */
export function decodeCreditActivityFromReceipt(
  receipt: TransactionReceipt,
  eventSignature: string = CREDIT_ACTIVITY_EVENT_SIGNATURE
): { account: string; amount: bigint; emitter: string } {
  for (const log of receipt.logs) {
    if (log.topics.length > 0 && log.topics[0].toLowerCase() === eventSignature.toLowerCase()) {
      if (log.topics.length !== 2) {
        throw new Error("Invalid CreditActivityRecorded topics");
      }
      return {
        account: getAddress("0x" + log.topics[1].slice(26)),
        amount: BigInt(log.data),
        emitter: getAddress(log.address),
      };
    }
  }
  throw new Error("No CreditActivityRecorded event found in receipt");
}

export class AttestLineClient {
  readonly proofBuilder: proofProvider.service.ProofBuilder;
  readonly chainInfoProvider: chainInfo.PrecompileChainInfoProvider;
  readonly attestLine: AttestLine;
  readonly lineToken: LineToken;

  readonly chainKey: number;
  readonly sourceContractAddress: string;

  private readonly sourceProvider: JsonRpcApiProvider;
  private readonly proofPollIntervalMs: number;
  private readonly proofTimeoutMs: number;

  constructor(options: AttestLineClientOptions) {
    this.chainKey = options.chainKey;
    this.sourceContractAddress = options.sourceContractAddress;
    this.sourceProvider = options.sourceProvider;
    this.proofPollIntervalMs = options.proofPollIntervalMs ?? 15_000;
    this.proofTimeoutMs = options.proofTimeoutMs ?? 900_000; // 15 minutes

    this.proofBuilder = new proofProvider.service.ProofBuilder(
      options.chainKey,
      options.proofBuilderUrl
    );
    this.chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(options.creditcoinProvider);
    this.attestLine =
      options.attestLineContract ??
      AttestLine__factory.connect(options.attestLineAddress, options.creditcoinProvider);
    this.lineToken =
      options.lineTokenContract ??
      LineToken__factory.connect(options.lineTokenAddress, options.creditcoinProvider);
  }

  // ── Chain info ─────────────────────────────────────────────────────────────

  /** Chains attested on Creditcoin (from the ChainInfo precompile). */
  getSupportedChains(): Promise<chainInfo.ChainInfo[]> {
    return this.chainInfoProvider.getSupportedChains();
  }

  // ── Proof building ─────────────────────────────────────────────────────────

  /**
   * Wait for the source transaction's block to be attested on Creditcoin,
   * generate a proof of inclusion, and decode the attested activity event.
   */
  async buildProof(txHash: string): Promise<ProofWithActivity> {
    const tx = await this.sourceProvider.getTransaction(txHash);
    if (!tx) {
      throw new Error(`Transaction ${txHash} does not exist on the source chain`);
    }
    if (tx.blockNumber === null) {
      throw new Error(`Transaction ${txHash} is not yet mined on the source chain`);
    }
    const blockNumber = tx.blockNumber;

    // Wait for the block to be attested AND available in the proof builder cache.
    await this.proofBuilder.waitUntilHeightAttested(
      this.chainKey,
      blockNumber,
      this.proofPollIntervalMs,
      this.proofTimeoutMs
    );

    const result = await this.proofBuilder.getProof(txHash);
    if (!result.success || !result.data) {
      throw new Error(`Proof generation failed: ${result.error ?? "unknown error"}`);
    }

    const proof = result.data;
    const decoded = decodeCreditActivityFromEncodedTx(proof.txBytes);

    const activity: DecodedCreditActivity = {
      account: decoded.account,
      amount: decoded.amount,
      txHash,
      blockNumber,
      emitter: decoded.emitter,
    };

    return { proof, activity };
  }

  // ── Credit line operations ─────────────────────────────────────────────────

  /**
   * Request a credit line for the signer, proving an attested
   * CreditActivityRecorded transaction on the source chain.
   *
   * Fast-fails before waiting for attestation when the source receipt clearly
   * cannot be accepted (failed tx, wrong emitter, account mismatch).
   */
  async requestCreditLine(txHash: string, signer: Signer): Promise<TransactionReceipt> {
    // ── Fast pre-validation from the source-chain receipt ──────────────────
    const receipt = await this.sourceProvider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Receipt for ${txHash} not found on the source chain`);
    }
    if (receipt.status !== 1) {
      throw new Error("Source transaction did not succeed; nothing to underwrite");
    }
    const event = decodeCreditActivityFromReceipt(receipt);
    if (event.emitter.toLowerCase() !== this.sourceContractAddress.toLowerCase()) {
      throw new Error(
        `Event not emitted by the registered source contract (${this.sourceContractAddress})`
      );
    }
    const signerAddress = await signer.getAddress();
    if (event.account.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        `Attested account ${event.account} does not match the signer ${signerAddress}`
      );
    }

    // ── Build the proof (waits for attestation) ─────────────────────────────
    const { proof, activity } = await this.buildProof(txHash);
    if (activity.amount !== event.amount || activity.account.toLowerCase() !== event.account.toLowerCase()) {
      throw new Error("Decoded activity from proof does not match the source receipt");
    }

    // ── Submit to the ASC ───────────────────────────────────────────────────
    const tx = await this.attestLine.connect(signer).requestCreditLine(
      proof.chainKey,
      proof.headerNumber,
      proof.txBytes,
      proof.merkleProof.root,
      proof.merkleProof.siblings,
      proof.continuityProof.lowerEndpointDigest,
      proof.continuityProof.roots
    );
    const mined = await tx.wait();
    if (!mined) {
      throw new Error("Credit line transaction was dropped");
    }
    return mined;
  }

  /** Draw `amount` of LineToken against the signer's credit line. */
  async draw(amount: bigint, signer: Signer): Promise<TransactionReceipt> {
    const tx = await this.attestLine.connect(signer).draw(amount);
    const mined = await tx.wait();
    if (!mined) throw new Error("Draw transaction was dropped");
    return mined;
  }

  /** Repay `amount` of LineToken (interest first, then principal). */
  async repay(amount: bigint, signer: Signer): Promise<TransactionReceipt> {
    const tx = await this.attestLine.connect(signer).repay(amount);
    const mined = await tx.wait();
    if (!mined) throw new Error("Repay transaction was dropped");
    return mined;
  }

  /** The borrower's current credit line. */
  async getCreditLine(address: string): Promise<CreditLineView> {
    const line = await this.attestLine.getCreditLine(address);
    return {
      borrower: line.borrower,
      creditLimit: line.creditLimit,
      used: line.used,
      interestRateBps: line.interestRateBps,
      createdAtBlock: line.createdAtBlock,
      deadlineBlock: line.deadlineBlock,
      defaulted: line.defaulted,
    };
  }

  /** Credit score derived from the borrower's most recent attested amount. */
  creditScoreOf(address: string): Promise<bigint> {
    return this.attestLine.creditScoreOf(address);
  }

  /** Amount still drawable right now. */
  available(address: string): Promise<bigint> {
    return this.attestLine.available(address);
  }

  /** Total interest accrued up to the current block (frozen at default). */
  accruedInterestOf(address: string): Promise<bigint> {
    return this.attestLine.accruedInterestOf(address);
  }
}
