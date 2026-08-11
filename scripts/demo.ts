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
import { JsonRpcProvider, MaxUint256, Wallet, parseEther } from "ethers";
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

  // 4. Draw. Draw 95% of the limit (leaves headroom in the line). True
  //    invariant: AttestLine.draw sets line.used += amount and mints the same
  //    amount to the wallet (AttestLine is the sole minter of ALCT and draw is
  //    the only mint path), so after a draw the ALCT balance EXACTLY equals
  //    line.used. The undrawn 5% is credit headroom, not tokens — it cannot
  //    cover interest accrued after the draw. Step 5 therefore repays the full
  //    ALCT balance, which settles all accrued interest and clears principal to
  //    documented interest dust.
  console.log("[4/5] Drawing 95% of the credit limit...");
  const drawAmount = (line.creditLimit * 95n) / 100n;
  const drawReceipt = await client.draw(drawAmount, ccWallet);
  console.log(`      drew ${drawAmount.toString()}: tx ${drawReceipt.hash}`);
  console.log(`      ALCT balance: ${(await client.lineToken.balanceOf(ccWallet.address)).toString()}`);

  // 5. Repay (interest + principal). AttestLine.repay settles interest FIRST,
  //    reverting if amount < accrued interest (RepayDoesNotCoverInterest) or if
  //    amount - interest > used (Overpay), then pulls ALCT from the wallet via
  //    transferFrom. After the draw the wallet balance equals line.used, so the
  //    wallet cannot also cover the interest accrued between the draw and this
  //    repay in the same tx. Repaying the full ALCT balance pays ALL accrued
  //    interest and applies the remainder to principal, leaving only documented
  //    interest dust in `used`. Re-read the line and interest after the draw so
  //    the figures reflect the drawn principal (used is 0 right after the grant).
  console.log("[5/5] Repaying...");
  const balance = await client.lineToken.balanceOf(ccWallet.address);
  const lineAfterDraw = await client.getCreditLine(ccWallet.address);
  const interest = await client.accruedInterestOf(ccWallet.address);
  const owed = lineAfterDraw.used + interest; // full settle amount at read time
  // Never exceed the wallet balance (no ERC20InsufficientBalance) and never
  // exceed owed (no Overpay). Interest-first settlement means this amount pays
  // all accrued interest and applies the remainder to principal.
  const repayAmount = balance < owed ? balance : owed;
  console.log(
    `      balance=${balance.toString()} used=${lineAfterDraw.used.toString()} interest=${interest.toString()} -> repay ${repayAmount.toString()}`
  );
  // AttestLine.repay pulls ALCT from the wallet via transferFrom, so approve
  // AttestLine to spend the wallet's ALCT before repaying.
  console.log("      approving AttestLine to spend ALCT...");
  const approveReceipt = await (
    await client.lineToken.connect(ccWallet).approve(cfg.attestLineAddress, MaxUint256)
  ).wait();
  console.log(`      approved: tx ${approveReceipt!.hash}`);
  const repayReceipt = await client.repay(repayAmount, ccWallet);
  console.log(`      repaid ${repayAmount.toString()}: tx ${repayReceipt.hash}`);

  const after = await client.getCreditLine(ccWallet.address);
  console.log(`      remaining used: ${after.used.toString()}`);

  console.log("\n✅ Demo complete.");
  if (after.used > 0n) {
    console.log(
      `Note: ${after.used.toString()} wei remains in 'used'. This dust equals the interest that\n` +
        "accrued between the draw tx and the repay tx. AttestLine is the sole minter of ALCT\n" +
        "and draw is the only mint path, so the wallet holds no external ALCT that could cover\n" +
        "that interest. Repaying the full ALCT balance settles ALL accrued interest and clears\n" +
        "principal to this documented interest dust — the expected, spec-compliant outcome\n" +
        "(used = 0 or documented dust)."
    );
  } else {
    console.log("Credit line fully settled.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
