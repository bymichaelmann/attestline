/**
 * demo.ts — live end-to-end demo of AttestLine on the CC3 testnet.
 *
 * GATED: requires ENABLE_LIVE_DEMO=1 (never runs in CI). Requires live RPCs,
 * funded keys and deployed contracts (see docs/testnet-deployment.md).
 *
 * Flow:
 *   1. record on-chain activity on the source chain (CreditActivity.recordActivity)
 *   2. wait for attestation and build a proof of inclusion (may take minutes)
 *   3. request a credit line on Creditcoin
 *   4. draw LineToken
 *   5. repay (interest + principal)
 */
import "dotenv/config";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { loadConfig } from "../src/config";
import { AttestLineClient } from "../src/client";
import { CreditActivity__factory } from "../typechain-types";

const GATE = process.env.ENABLE_LIVE_DEMO === "1";

async function main() {
  if (!GATE) {
    console.log(
      "[demo] gated: set ENABLE_LIVE_DEMO=1 to run the live end-to-end demo " +
        "(requires RPC endpoints, funded keys and deployed contracts). Exiting."
    );
    return;
  }

  const cfg = loadConfig();
  if (!cfg.attestLineAddress || !cfg.lineTokenAddress || !cfg.sourceContractAddress) {
    throw new Error("ATTESTLINE_CONTRACT, LINE_TOKEN_CONTRACT and SOURCE_CHAIN_ACTIVITY_CONTRACT are required");
  }
  if (!cfg.privateKey || !cfg.sourceChainWalletKey) {
    throw new Error("PRIVATE_KEY and SOURCE_CHAIN_WALLET_KEY are required for the demo");
  }

  const amount = parseEther(process.env.DEMO_AMOUNT ?? "8");

  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);
  const sourceWallet = new Wallet(cfg.sourceChainWalletKey, sourceProvider);
  const ccWallet = new Wallet(cfg.privateKey, ccProvider);

  const activity = CreditActivity__factory.connect(cfg.sourceContractAddress, sourceWallet);
  const client = new AttestLineClient({
    creditcoinProvider: ccProvider,
    sourceProvider,
    proofBuilderUrl: cfg.proofBuilderUrl,
    chainKey: cfg.chainKey,
    attestLineAddress: cfg.attestLineAddress,
    lineTokenAddress: cfg.lineTokenAddress,
    sourceContractAddress: cfg.sourceContractAddress,
  });

  console.log(`\n=== AttestLine live demo (chainKey ${cfg.chainKey}) ===`);
  console.log(`Source chain:  ${cfg.sourceChainRpcUrl}`);
  console.log(`Creditcoin:    ${cfg.creditcoinRpcUrl}`);
  console.log(`Source wallet: ${sourceWallet.address}`);
  console.log(`CC wallet:     ${ccWallet.address}`);
  console.log(`Demo amount:   ${amount.toString()} wei\n`);

  // 1. Record activity on the source chain.
  console.log("[1/5] Recording activity on the source chain...");
  const recordTx = await activity.recordActivity(amount);
  const recordReceipt = await recordTx.wait();
  console.log(`      tx ${recordReceipt!.hash} (block ${recordReceipt!.blockNumber})`);

  // 2. Wait for attestation + build proof.
  console.log("[2/5] Waiting for block attestation and building proof (may take minutes)...");
  const { proof, activity: decoded } = await client.buildProof(recordReceipt!.hash);
  console.log(`      attested at header ${proof.headerNumber}`);
  console.log(`      decoded activity: account=${decoded.account} amount=${decoded.amount}`);

  // 3. Request the credit line.
  console.log("[3/5] Requesting credit line on Creditcoin...");
  const grantReceipt = await client.requestCreditLine(recordReceipt!.hash, ccWallet);
  console.log(`      granted: tx ${grantReceipt.hash}`);

  const line = await client.getCreditLine(ccWallet.address);
  const score = await client.creditScoreOf(ccWallet.address);
  console.log(`      credit limit: ${line.creditLimit.toString()} ALCT`);
  console.log(`      APR:          ${(Number(line.interestRateBps) / 100).toFixed(2)}%`);
  console.log(`      score:        ${score.toString()}`);

  // 4. Draw.
  console.log("[4/5] Drawing the full credit limit...");
  const drawReceipt = await client.draw(line.creditLimit, ccWallet);
  console.log(`      drew ${line.creditLimit.toString()}: tx ${drawReceipt.hash}`);
  console.log(`      ALCT balance: ${(await client.lineToken.balanceOf(ccWallet.address)).toString()}`);

  // 5. Repay (interest + principal). The repay must cover ALL interest accrued
  //    to its block; one block of slack is added for the tx landing.
  console.log("[5/5] Repaying...");
  const interest = await client.accruedInterestOf(ccWallet.address);
  const interestPerBlock =
    (line.used * line.interestRateBps) / (2_102_400n * 10_000n);
  const repayAmount = line.used + interest + interestPerBlock;
  const repayReceipt = await client.repay(repayAmount, ccWallet);
  console.log(`      repaid ${repayAmount.toString()}: tx ${repayReceipt.hash}`);

  const after = await client.getCreditLine(ccWallet.address);
  console.log(`      remaining used: ${after.used.toString()}`);

  console.log("\n✅ Demo complete.");
  if (after.used > 0n) {
    console.log(
      `Note: ${after.used.toString()} wei of principal remains because a block of interest\n` +
        "accrued while the repay tx was in flight — repay again with the fresh figures to settle."
    );
  } else {
    console.log("Credit line fully settled.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
