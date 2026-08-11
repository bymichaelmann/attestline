/**
 * Shared TypeScript types for AttestLine.
 */
import type { proofProvider } from "@gluwa/usc-sdk";

/** A decoded CreditActivityRecorded event (from either a raw receipt or an EvmV1-encoded tx). */
export interface DecodedCreditActivity {
  /** The account that recorded the activity (indexed event topic). */
  account: string;
  /** The attested amount in wei. */
  amount: bigint;
  /** The source-chain transaction that carried the event. */
  txHash: string;
  /** Block number of that transaction on the source chain. */
  blockNumber: number;
  /** The contract that emitted the event. */
  emitter: string;
}

/** A proof of inclusion (as returned by the proof builder) plus the decoded event. */
export interface ProofWithActivity {
  proof: proofProvider.ContinuityResponse;
  activity: DecodedCreditActivity;
}

/** Human-friendly view of an on-chain CreditLine. */
export interface CreditLineView {
  borrower: string;
  creditLimit: bigint;
  used: bigint;
  interestRateBps: bigint;
  createdAtBlock: bigint;
  deadlineBlock: bigint;
  defaulted: boolean;
}
