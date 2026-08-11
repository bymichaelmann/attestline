# AttestLine × Attestcoin Protocol — integration deep dive

AttestLine is an **Attestcoin Smart Contract (ASC)**: a Creditcoin smart contract whose
underwriting inputs are *native inclusion proofs* of transactions that happened on another chain.
This document explains exactly how that integration works — the interfaces, the proof flow, the
encoding, and the security pitfalls the code guards against.

## 1. The Attestcoin Protocol in one paragraph

The Attestcoin Protocol (Gluwa) lets Creditcoin smart contracts *read* what happened on other EVM
chains without trusting an oracle. Validators attest to source-chain block headers; the **Block
Prover precompile** on Creditcoin stores the resulting attestation chain. A dApp submits a
transaction it cares about, ABI-encoded in the canonical "EvmV1" format, along with:

- a **Merkle proof** (block root + sibling path) proving the transaction is in a specific block, and
- a **continuity proof** (a chain of block-root digests) proving that block descends from an
  attested header.

The precompile verifies both natively against the attestation chain and, on success, the dApp can
*decode* the transaction and its receipt and act on it.

## 2. Precompiles & addresses

| Precompile | Address | Used for |
| --- | --- | --- |
| Block Prover (`INativeQueryVerifier`) | `0x0000000000000000000000000000000000000FD2` | `verify` / `verifyAndEmit` / `calculateTxIndex` |
| ChainInfo | `0x0000000000000000000000000000000000000FD3` | chain list, attestation heights/bounds (via `@gluwa/usc-sdk`) |

`NativeQueryVerifierLib.getVerifier()` (in `contracts/interfaces/INativeQueryVerifier.sol`) returns
the Block Prover instance. The interface is vendored because the `@gluwa/usc-contracts` npm package
ships a lean copy without `verifyAndEmit`/`calculateTxIndex`; struct layouts and signatures are
byte-identical with the official example (`USCMinter`/`VerifierInterface.sol` in
`gluwa/usc-testnet-bridge-examples`) and the canonical precompile ABI.

## 3. Chain keys

A **chain key** identifies a source chain on Creditcoin. `chainKey 1 = Ethereum Sepolia`.
Supported chains, attested heights and continuity bounds are read from the ChainInfo precompile:

```ts
const info = new chainInfo.PrecompileChainInfoProvider(creditcoinProvider);
const chains = await info.getSupportedChains();          // [{ chainKey, chainId, chainName, chainEncoding }]
```

## 4. The proof flow, step by step

```
borrower                                   source chain                          Creditcoin
   │   1. recordActivity(amount)                │                                   │
   ├───────────────────────────────────────────►│                                   │
   │                                            │  tx in block N                    │
   │                                            │  … ~8 min … block N attested ─────►│
   │                                            │                                   │
   │   2. submit Merkle + continuity proof      │                                   │
   ├────────────────────────────────────────────────────────────────────────────────►│
   │                                            │   AttestLine.requestCreditLine(   │
   │                                            │     chainKey=1, height=N,         │
   │                                            │     encodedTransaction,           │
   │                                            │     merkleRoot, siblings,         │
   │                                            │     lowerEndpointDigest, roots)   │
   │                                            │                                   │
   │                                            │   ┌─ 1. txIndex = VERIFIER.        │
   │                                            │   │      calculateTxIndex(proof)  │
   │                                            │   │ 2. txKey = keccak(chainKey,    │
   │                                            │   │      height, txIndex); check   │
   │                                            │   │      not processed             │
   │                                            │   │ 3. VERIFIER.verifyAndEmit(...) │
   │                                            │   │      → TransactionVerified     │
   │                                            │   │ 4. mark processed              │
   │                                            │   │ 5. decode receipt; require     │
   │                                            │   │      receiptStatus == 1        │
   │                                            │   │ 6. find CreditActivityRecorded │
   │                                            │   │      log; require emitter ==   │
   │                                            │   │      sourceContract            │
   │                                            │   │ 7. require account == msg.sender│
   │                                            │   │ 8. score → limit/APR → store   │
   │                                            │   └─────────────────────────────── │
   │   3. draw / repay ALCT                     │                                   │
   ├────────────────────────────────────────────────────────────────────────────────►│
```

## 5. EvmV1 encoding (what the proof actually contains)

The proof builder (`proofProvider.service.ProofBuilder` in `@gluwa/usc-sdk`, backed by
`https://prover.cc3-testnet.creditcoin.network`) returns a `ContinuityResponse`:

```
{
  chainKey, headerNumber, txIndex, txHash,
  txBytes,                                  // EvmV1 ABI-encoded tx + receipt
  merkleProof:  { root, siblings: [{ hash, isLeft }] },
  continuityProof: { lowerEndpointDigest, roots: bytes32[] },
  cached, generatedAt
}
```

`txBytes` is `abi.encode(uint8 txType, bytes[] chunks)`. For a legacy (type 0) transaction:

- `chunks[0]` = common fields: `(uint64 nonce, uint64 gasLimit, address from, bool toIsNull, address to, uint256 value, bytes data)`
- `chunks[1]` = type-0 fields: `(uint128 gasPrice, uint256 v, bytes32 r, bytes32 s)`
- `chunks[2]` = receipt: `(uint8 receiptStatus, uint64 gasUsed, (address, bytes32[], bytes)[] logs, bytes bloom)`

`EvmV1Decoder` (from `@gluwa/usc-contracts`, linked at deploy time) decodes exactly this. The test
fixtures in `test/fixtures/encoded-transactions.ts` reproduce the encoding byte-for-byte, and the
client decodes the same format in TypeScript.

## 6. Why `receiptStatus` must be checked

The precompile proves **inclusion**: the transaction is in a finalized, attested block. It does
**not** prove the transaction succeeded — a reverted transaction is still included in a block. An
ASC that skipped the status check could be tricked by a proof of a *failed* transaction. AttestLine
therefore always:

```solidity
EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
require(receipt.receiptStatus == 1, "AttestLine: transaction did not succeed");
```

(`TransactionDidNotSucceed`.)

## 7. Replay protection

- The transaction index is derived from the Merkle sibling path via `VERIFIER.calculateTxIndex`:
  walking the path leaf→root, `sibling[i].isLeft == true` sets bit `i` of the index.
- The replay key is `txKey = keccak256(chainKey, blockHeight, txIndex)` — the exact packed layout
  of the official ASCMinter example (chainKey as a full word, blockHeight in the top 8 bytes of the
  next word, txIndex in the following 8 bytes; 72 bytes hashed).
- `processedQueries[txKey] = true` after successful verification ⇒ the same proof can never be
  replayed (e.g. to re-grant a line, or to double-claim).

## 8. Event extraction & allowlisting

`getLogsByEventSignature(receipt, CREDIT_ACTIVITY_EVENT_SIGNATURE)` filters the receipt logs for
`keccak256("CreditActivityRecorded(address,uint256)")`. The first match is processed and must:

- have been emitted by the owner-registered `sourceContract` (checked via the log's `address_`
  field — exactly like `USCLoanManager` checks its source loan contract),
- carry exactly two topics (signature + indexed account) and 32 bytes of data (`uint256 amount`),
- have its indexed `account` equal `msg.sender`.

## 9. SDK usage (TypeScript)

```ts
import { proofProvider, chainInfo } from "@gluwa/usc-sdk";

const proofBuilder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);
await proofBuilder.waitUntilHeightAttested(chainKey, blockNumber); // polls 15s / 15m default
const result = await proofBuilder.getProof(txHash);                // { success, data, error }

const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
await info.getSupportedChains();
```

`AttestLineClient` in `src/client.ts` wraps this end to end (including fast pre-validation of the
source receipt before the ~8-minute attestation wait).

## 10. Test strategy (deterministic, no RPC)

- `MockVerifier` implements the precompile interface with the same observable behavior
  (canonical Keccak Merkle verification, `calculateTxIndex`, strict (chainKey, height, root)
  enforcement, optional fail-all mode). Tests inject its bytecode at `0x…0FD2` with
  `hardhat_setCode`, so AttestLine calls the precompile address for real.
- Fixtures build EvmV1 encodings + Merkle proofs with the exact SDK/chain scheme, so the *same*
  bytes are used on-chain (MockVerifier recomputes the root) and in the client tests (TS decode).
- The matrix covers: happy path, replay protection, wrong chainKey/height/root, failed receipt,
  missing/foreign events, non-whitelisted emitter, account mismatch, limit/interest edge cases,
  defaults, and ownership.
