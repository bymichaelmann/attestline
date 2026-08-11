/**
 * worker.ts — offchain readability worker for AttestLine.
 *
 * Polls CreditActivityRecorded events on the source chain and, for each one,
 * waits for attestation, generates a proof of inclusion, and submits
 * `requestCreditLine` on Creditcoin.
 *
 * GATED: requires ENABLE_WORKER=1 (never runs in CI). Requires live RPCs,
 * deployed contracts and funded keys (see docs/testnet-deployment.md).
 *
 * IMPORTANT (contract security model): AttestLine requires the attested account
 * to equal msg.sender, so the worker can only submit proofs for accounts whose
 * private keys it holds (WORKER_PRIVATE_KEYS, comma-separated). Events from
 * other accounts are logged and skipped.
 */
import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "../src/config";
import { AttestLineClient } from "../src/client";
import { CreditActivity__factory } from "../typechain-types";

const GATE = process.env.ENABLE_WORKER === "1";
const POLL_INTERVAL_MS = 5_000;
const ERROR_BACKOFF_MS = 10_000;
const MAX_PROCESSED_TXS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isShuttingDown = false;
process.on("SIGINT", () => {
  console.log("\n[worker] SIGINT received, shutting down gracefully...");
  isShuttingDown = true;
});
process.on("SIGTERM", () => {
  console.log("\n[worker] SIGTERM received, shutting down gracefully...");
  isShuttingDown = true;
});

async function main() {
  if (!GATE) {
    console.log(
      "[worker] gated: set ENABLE_WORKER=1 to run (requires RPC endpoints, contracts and funded keys). Exiting."
    );
    return;
  }

  const cfg = loadConfig();
  if (!cfg.attestLineAddress || !cfg.lineTokenAddress || !cfg.sourceContractAddress) {
    throw new Error("ATTESTLINE_CONTRACT, LINE_TOKEN_CONTRACT and SOURCE_CHAIN_ACTIVITY_CONTRACT are required");
  }
  if (!cfg.privateKey) {
    throw new Error("PRIVATE_KEY (relayer) is required for the worker");
  }
  if (cfg.workerPrivateKeys.length === 0) {
    console.warn(
      "[worker] WORKER_PRIVATE_KEYS is empty — no accounts can be underwritten (AttestLine requires account == msg.sender)."
    );
  }

  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);
  const relayer = new Wallet(cfg.privateKey, ccProvider);

  const activity = CreditActivity__factory.connect(cfg.sourceContractAddress, sourceProvider);
  const client = new AttestLineClient({
    creditcoinProvider: ccProvider,
    sourceProvider,
    proofBuilderUrl: cfg.proofBuilderUrl,
    chainKey: cfg.chainKey,
    attestLineAddress: cfg.attestLineAddress,
    lineTokenAddress: cfg.lineTokenAddress,
    sourceContractAddress: cfg.sourceContractAddress,
  });

  // Account -> signer keyring. Only these accounts can be underwritten.
  const signers = new Map<string, Wallet>();
  for (const key of cfg.workerPrivateKeys) {
    const wallet = new Wallet(key, ccProvider);
    signers.set(wallet.address.toLowerCase(), wallet);
    console.log(`[worker] keyring: ${wallet.address} (${wallet.address === relayer.address ? "relayer" : "borrower"})`);
  }

  let fromBlock = cfg.workerStartBlock ?? (await sourceProvider.getBlockNumber());
  const processed = new Set<string>();

  console.log(`[worker] started — polling CreditActivity (${cfg.sourceContractAddress}) on chainKey ${cfg.chainKey}`);
  console.log(`[worker] polling from block ${fromBlock} (chain ${await sourceProvider.getNetwork()})`);

  while (!isShuttingDown) {
    try {
      const toBlock = await sourceProvider.getBlockNumber();
      if (toBlock >= fromBlock) {
        const events = await activity.queryFilter(
          activity.filters.CreditActivityRecorded(),
          fromBlock,
          toBlock
        );
        for (const event of events) {
          const txHash = event.transactionHash;
          if (processed.has(txHash)) {
            continue;
          }
          const account = event.args.account.toLowerCase();
          const amount = event.args.amount;
          const signer = signers.get(account);

          if (!signer) {
            console.log(`[worker] skip ${txHash}: no key for attested account ${event.args.account}`);
            processed.add(txHash);
            continue;
          }

          console.log(
            `[worker] submitting proof for ${txHash} (account ${event.args.account}, amount ${amount})`
          );
          try {
            const receipt = await client.requestCreditLine(txHash, signer);
            console.log(`[worker] credit line granted for ${txHash}: tx ${receipt.hash}`);
          } catch (error) {
            console.error(`[worker] error for ${txHash}: ${(error as Error).message}`);
          }
          processed.add(txHash);
        }
        fromBlock = toBlock + 1;
      }
    } catch (error) {
      console.error(`[worker] poll error: ${(error as Error).message} (backing off)`);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (processed.size > MAX_PROCESSED_TXS) {
      processed.clear();
    }
    await sleep(POLL_INTERVAL_MS);
  }

  sourceProvider.destroy();
  ccProvider.destroy();
  console.log("[worker] stopped.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
