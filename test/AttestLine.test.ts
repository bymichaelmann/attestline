import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  AttestLine__factory,
  CreditActivity__factory,
  LineToken__factory,
  TestHarness__factory,
  type AttestLine,
  type CreditActivity,
  type LineToken,
  type MockVerifier,
  type TestHarness,
} from "../typechain-types";
import {
  buildFixture,
  CREDIT_ACTIVITY_EVENT_SIGNATURE,
  TRANSACTION_VERIFIED_EVENT_SIGNATURE,
  ZERO_ADDRESS,
} from "./fixtures/encoded-transactions";
import {
  BLOCK_PROVER_PRECOMPILE,
  deployAttestLine,
  installMockVerifier,
  mineBlocks,
} from "./helpers";

const { ethers } = hre;

/** Small term so deadline tests can mine past it quickly. */
const TERM_BLOCKS = 200;
const WEI = 10n ** 18n;

/** BLOCKS_PER_YEAR * BPS_DENOMINATOR, used for expected-interest math. */
const INTEREST_DENOMINATOR = 2_102_400n * 10_000n;

describe("AttestLine", () => {
  async function deployTestStack() {
    const [owner, borrower, other, stranger] = await ethers.getSigners();

    // Source-chain activity contract (simulated on the same local node).
    const creditActivity = (await new CreditActivity__factory(owner).deploy()) as CreditActivity;
    await creditActivity.waitForDeployment();

    // AttestLine with linked libraries.
    const attestLine = (await deployAttestLine(TERM_BLOCKS)) as AttestLine;

    // Lending token, mintable by AttestLine only.
    const lineToken = (await new LineToken__factory(owner).deploy(attestLine.target)) as LineToken;
    await lineToken.waitForDeployment();

    await (await attestLine.setLineToken(lineToken.target)).wait();
    await (await attestLine.setSourceContract(creditActivity.target)).wait();

    // Install the MockVerifier at the Block Prover precompile address (lax mode).
    const mock = await installMockVerifier({});

    return { owner, borrower, other, stranger, creditActivity, attestLine, lineToken, mock };
  }

  function grantArgs(
    fx: ReturnType<typeof buildFixture>,
    overrides: Partial<{
      chainKey: number;
      blockHeight: number;
      encodedTx: string;
      merkleRoot: string;
      siblings: { hash: string; isLeft: boolean }[];
    }> = {}
  ) {
    return [
      overrides.chainKey ?? fx.chainKey,
      overrides.blockHeight ?? fx.blockHeight,
      overrides.encodedTx ?? fx.encodedTx,
      overrides.merkleRoot ?? fx.merkleRoot,
      overrides.siblings ?? fx.siblings,
      fx.lowerEndpointDigest,
      fx.continuityRoots,
    ] as const;
  }

  async function grantLine(
    attestLine: AttestLine,
    borrower: { address: string },
    creditActivity: CreditActivity,
    amount: bigint
  ) {
    const fx = buildFixture({
      sourceContract: creditActivity.target as string,
      account: borrower.address,
      amount,
    });
    const tx = await attestLine.connect(borrower as any).requestCreditLine(...grantArgs(fx));
    const receipt = await tx.wait();
    return { fx, receipt: receipt! };
  }

  describe("requestCreditLine — happy path", () => {
    it("grants a line from an attested CreditActivityRecorded event", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI; // steps 3 → score 450, factor 1.2x, APR 10%
      const expectedLimit = (amount * 12_000n) / 10_000n;

      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount,
      });

      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx)))
        .to.emit(attestLine, "CreditLineGranted")
        .withArgs(borrower.address, amount, expectedLimit, 450n, 1000n);

      const line = await attestLine.getCreditLine(borrower.address);
      expect(line.borrower).to.equal(borrower.address);
      expect(line.creditLimit).to.equal(expectedLimit);
      expect(line.used).to.equal(0n);
      expect(line.interestRateBps).to.equal(1000n);
      expect(line.deadlineBlock).to.equal(line.createdAtBlock + BigInt(TERM_BLOCKS));
      expect(line.defaulted).to.be.false;

      expect(await attestLine.creditScoreOf(borrower.address)).to.equal(450n);
      expect(await attestLine.lastActivityAmount(borrower.address)).to.equal(amount);
      expect(await attestLine.available(borrower.address)).to.equal(expectedLimit);
    });

    it("emits TransactionVerified from the Block Prover precompile address (verifyAndEmit path)", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 10n * WEI,
      });
      const tx = await attestLine.connect(borrower).requestCreditLine(...grantArgs(fx));
      const receipt = await tx.wait();

      const verifiedLogs = receipt!.logs.filter(
        (l) =>
          l.address.toLowerCase() === BLOCK_PROVER_PRECOMPILE.toLowerCase() &&
          l.topics[0].toLowerCase() === TRANSACTION_VERIFIED_EVENT_SIGNATURE.toLowerCase()
      );
      expect(verifiedLogs.length).to.equal(1);
    });

    it("grants the same line to multiple borrowers from distinct proofs", async () => {
      const { attestLine, creditActivity, borrower, other } = await loadFixture(deployTestStack);
      const fx1 = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      const fx2 = buildFixture({
        sourceContract: creditActivity.target as string,
        account: other.address,
        amount: 8n * WEI,
        blockHeight: 1_000_001, // distinct proof key (chainKey, height, txIndex)
      });
      await attestLine.connect(borrower).requestCreditLine(...grantArgs(fx1));
      await attestLine.connect(other).requestCreditLine(...grantArgs(fx2));
      expect((await attestLine.getCreditLine(other.address)).borrower).to.equal(other.address);
    });

    it("works when the transaction sits at a different leaf index (txIndex from proof path)", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 4n * WEI,
        leafIndex: 3,
      });
      expect(fx.txIndex).to.equal(3);
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.emit(
        attestLine,
        "CreditLineGranted"
      );
    });
  });

  describe("requestCreditLine — proof integrity & replay protection", () => {
    it("rejects replaying the same proof", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      await attestLine.connect(borrower).requestCreditLine(...grantArgs(fx));
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "ProofAlreadyProcessed"
      );
    });

    it("rejects a proof for the wrong chainKey (verified by the precompile)", async () => {
      const { attestLine, creditActivity, borrower, mock } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      // Strict mock: only chainKey 1 at the fixture height with the fixture root is accepted.
      await installMockVerifier({
        chainKey: 1,
        height: fx.blockHeight,
        root: fx.merkleRoot,
        enforce: true,
      });
      await expect(
        attestLine.connect(borrower).requestCreditLine(...grantArgs(fx, { chainKey: 2 }))
      ).to.be.revertedWithCustomError(mock, "MockVerifierRejected");
      // Sanity: the correct chainKey passes the strict mock.
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.emit(
        attestLine,
        "CreditLineGranted"
      );
    });

    it("rejects a proof for the wrong block height (verified by the precompile)", async () => {
      const { attestLine, creditActivity, borrower, mock } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      await installMockVerifier({
        chainKey: 1,
        height: fx.blockHeight,
        root: fx.merkleRoot,
        enforce: true,
      });
      await expect(
        attestLine.connect(borrower).requestCreditLine(...grantArgs(fx, { blockHeight: fx.blockHeight + 1 }))
      ).to.be.revertedWithCustomError(mock, "MockVerifierRejected");
    });

    it("rejects a tampered merkle root (verified by the precompile)", async () => {
      const { attestLine, creditActivity, borrower, mock } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      await installMockVerifier({
        chainKey: 1,
        height: fx.blockHeight,
        root: fx.merkleRoot,
        enforce: true,
      });
      const tampered = "0x" + (BigInt(fx.merkleRoot) ^ 1n).toString(16).padStart(64, "0");
      await expect(
        attestLine.connect(borrower).requestCreditLine(...grantArgs(fx, { merkleRoot: tampered }))
      ).to.be.revertedWithCustomError(mock, "MockVerifierRejected");
    });

    it("reverts when the precompile itself fails (failAll mode)", async () => {
      const { attestLine, creditActivity, borrower, mock } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      await installMockVerifier({ fail: true });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        mock,
        "MockVerifierRejected"
      );
    });
  });

  describe("requestCreditLine — decoding & validation", () => {
    it("rejects a transaction whose receipt status is 0 (failed tx)", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
        receiptStatus: 0,
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "TransactionDidNotSucceed"
      );
    });

    it("rejects a transaction with no CreditActivityRecorded event", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
        logs: [],
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "NoCreditActivityEvent"
      );
    });

    it("rejects a transaction carrying only a foreign event", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const foreignSig = ethers.id("Transfer(address,address,uint256)");
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
        logs: [
          {
            address: creditActivity.target as string,
            topics: [foreignSig, ethers.zeroPadValue(borrower.address, 32)],
            data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
          },
        ],
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "NoCreditActivityEvent"
      );
    });

    it("rejects an event emitted by a non-whitelisted source contract", async () => {
      const { attestLine, creditActivity, borrower, other } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
        logs: [
          {
            address: other.address,
            topics: [CREDIT_ACTIVITY_EVENT_SIGNATURE, ethers.zeroPadValue(borrower.address, 32)],
            data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [8n * WEI]),
          },
        ],
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "EventNotFromSourceContract"
      );
    });

    it("rejects when the attested account != msg.sender", async () => {
      const { attestLine, creditActivity, borrower, other } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: other.address, // attested account is `other`...
        amount: 8n * WEI,
      });
      // ...but `borrower` submits the proof.
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "AccountMismatch"
      );
    });

    it("rejects a zero attested amount", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 0n,
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        attestLine,
        "ZeroAmount"
      );
    });
  });

  describe("credit line lifecycle", () => {
    it("grants → draws → repays → settles (same-block batch) → can re-grant", async () => {
      const { attestLine, lineToken, creditActivity, owner } = await loadFixture(deployTestStack);
      const harness = (await new TestHarness__factory(owner).deploy()) as TestHarness;
      await harness.waitForDeployment();

      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;

      // Underwrite the harness (contract borrower) from an attested event.
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: harness.target as string,
        amount,
      });
      await harness.requestLine(
        attestLine.target,
        fx.chainKey,
        fx.blockHeight,
        fx.encodedTx,
        fx.merkleRoot,
        fx.siblings,
        fx.lowerEndpointDigest,
        fx.continuityRoots
      );

      const line = await attestLine.getCreditLine(harness.target as string);
      expect(line.borrower).to.equal(harness.target);
      expect(line.creditLimit).to.equal(limit);
      expect(line.interestRateBps).to.equal(1000n);
      expect(await attestLine.creditScoreOf(harness.target as string)).to.equal(450n);
      expect(await attestLine.available(harness.target as string)).to.equal(limit);

      // Draw + repay in a single block: zero elapsed blocks ⇒ zero interest ⇒
      // the borrower repays exactly the principal drawn.
      const settleTx = await harness.drawAndRepay(attestLine.target, lineToken.target, limit);
      const settleReceipt = await settleTx.wait();
      expect(await lineToken.balanceOf(harness.target as string)).to.equal(0n);
      expect((await attestLine.getCreditLine(harness.target as string)).used).to.equal(0n);
      expect(await attestLine.accruedInterestOf(harness.target as string)).to.equal(0n);

      // Parse the two events emitted during the batched draw+repay.
      const iface = attestLine.interface;
      const events = settleReceipt!.logs
        .map((l) => {
          try {
            return iface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      expect(events.some((e) => e.name === "Drawn")).to.equal(true);
      const repaid = events.find((e) => e.name === "Repaid");
      const settled = events.find((e) => e.name === "LineSettled");
      expect(repaid).to.not.equal(undefined);
      expect(repaid!.args.amount).to.equal(limit);
      expect(repaid!.args.interestAmount).to.equal(0n);
      expect(repaid!.args.principalAmount).to.equal(limit);
      expect(settled).to.not.equal(undefined);

      // Fully settled → the borrower may be underwritten again.
      const fx2 = buildFixture({
        sourceContract: creditActivity.target as string,
        account: harness.target as string,
        amount: 16n * WEI,
        blockHeight: 1_000_001, // distinct proof key
      });
      await harness.requestLine(
        attestLine.target,
        fx2.chainKey,
        fx2.blockHeight,
        fx2.encodedTx,
        fx2.merkleRoot,
        fx2.siblings,
        fx2.lowerEndpointDigest,
        fx2.continuityRoots
      );
      expect((await attestLine.getCreditLine(harness.target as string)).creditLimit).to.equal(
        (16n * WEI * 15_000n) / 10_000n
      );
    });

    it("accrues linear per-block interest and settles interest-first", async () => {
      const { attestLine, lineToken, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      const drawTx = await attestLine.connect(borrower).draw(limit);
      const drawReceipt = await drawTx.wait();
      await (await lineToken.connect(borrower).approve(attestLine.target, ethers.MaxUint256)).wait();
      await mineBlocks(100);

      const head = await ethers.provider.getBlockNumber();
      const elapsedView = BigInt(head - drawReceipt!.blockNumber);
      const expectedView = (limit * 1000n * elapsedView) / INTEREST_DENOMINATOR;
      expect(await attestLine.accruedInterestOf(borrower.address)).to.equal(expectedView);

      // The repay lands one block later, so one more block of interest is due.
      const elapsedRepay = BigInt(head + 1 - drawReceipt!.blockNumber);
      const expectedAtRepay = (limit * 1000n * elapsedRepay) / INTEREST_DENOMINATOR;
      await expect(attestLine.connect(borrower).repay(expectedAtRepay))
        .to.emit(attestLine, "Repaid")
        .withArgs(borrower.address, expectedAtRepay, expectedAtRepay, 0n);

      // Interest-only repayment: principal untouched, interest reset to zero.
      expect((await attestLine.getCreditLine(borrower.address)).used).to.equal(limit);
      expect(await attestLine.accruedInterestOf(borrower.address)).to.equal(0n);
    });

    it("allows partial principal repayment (interest settled first)", async () => {
      const { attestLine, lineToken, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await (await lineToken.connect(borrower).approve(attestLine.target, ethers.MaxUint256)).wait();
      await attestLine.connect(borrower).draw(limit);

      // Exactly one block of interest between draw and repay.
      const interestDue = (limit * 1000n * 1n) / INTEREST_DENOMINATOR;
      expect(interestDue).to.be.greaterThan(0n);

      const partial = limit / 2n;
      await attestLine.connect(borrower).repay(partial + interestDue);

      const line = await attestLine.getCreditLine(borrower.address);
      expect(line.used).to.equal(limit - partial);
      // A new line is still blocked while principal is outstanding.
      const reGrant = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 32n * WEI,
        blockHeight: 1_000_001, // distinct proof key
      });
      await expect(
        attestLine.connect(borrower).requestCreditLine(...grantArgs(reGrant))
      ).to.be.revertedWithCustomError(attestLine, "ActiveCreditLineExists");
    });

    it("rejects a repayment that does not cover accrued interest", async () => {
      const { attestLine, lineToken, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(limit);
      await mineBlocks(5);

      const interestDue = await attestLine.accruedInterestOf(borrower.address);
      expect(interestDue).to.be.greaterThan(0n);

      await (await lineToken.connect(borrower).approve(attestLine.target, interestDue - 1n)).wait();
      await expect(attestLine.connect(borrower).repay(interestDue - 1n)).to.be.revertedWithCustomError(
        attestLine,
        "RepayDoesNotCoverInterest"
      );
    });

    it("rejects overpaying beyond principal + interest", async () => {
      const { attestLine, lineToken, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await (await lineToken.connect(borrower).approve(attestLine.target, ethers.MaxUint256)).wait();
      const drawTx = await attestLine.connect(borrower).draw(limit);
      const drawReceipt = await drawTx.wait();

      // Exact interest due at the repay block (draw + 1), then go one wei over.
      const head = await ethers.provider.getBlockNumber();
      const elapsed = BigInt(head + 1 - drawReceipt!.blockNumber);
      const interestAtRepay = (limit * 1000n * elapsed) / INTEREST_DENOMINATOR;

      await expect(attestLine.connect(borrower).repay(limit + interestAtRepay + 1n)).to.be.revertedWithCustomError(
        attestLine,
        "Overpay"
      );
    });

    it("rejects repay with no outstanding debt", async () => {
      const { attestLine, borrower } = await loadFixture(deployTestStack);
      await expect(attestLine.connect(borrower).repay(1n)).to.be.revertedWithCustomError(
        attestLine,
        "NoOutstandingDebt"
      );
    });

    it("rejects drawing with no credit line", async () => {
      const { attestLine, stranger } = await loadFixture(deployTestStack);
      await expect(attestLine.connect(stranger).draw(1n)).to.be.revertedWithCustomError(
        attestLine,
        "NoCreditLine"
      );
    });

    it("rejects drawing more than the credit limit", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(limit);
      await expect(attestLine.connect(borrower).draw(1n)).to.be.revertedWithCustomError(
        attestLine,
        "ExceedsCreditLimit"
      );
    });

    it("rejects re-granting while an active line has outstanding principal", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(1n * WEI);
      const fx2 = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 16n * WEI,
        blockHeight: 1_000_001, // distinct proof key
      });
      await expect(attestLine.connect(borrower).requestCreditLine(...grantArgs(fx2))).to.be.revertedWithCustomError(
        attestLine,
        "ActiveCreditLineExists"
      );
    });
  });

  describe("defaults", () => {
    it("freezes draws after the deadline passes (expired)", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(1n * WEI);

      await mineBlocks(TERM_BLOCKS + 2);
      await expect(attestLine.connect(borrower).draw(1n)).to.be.revertedWithCustomError(
        attestLine,
        "LineExpired"
      );
      expect(await attestLine.available(borrower.address)).to.equal(0n);
    });

    it("anyone can mark a line defaulted after the deadline; draws freeze but repayment still works", async () => {
      const { attestLine, lineToken, creditActivity, borrower, stranger } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(limit);

      await mineBlocks(TERM_BLOCKS + 2);
      await expect(attestLine.connect(stranger).markDefaulted(borrower.address))
        .to.emit(attestLine, "MarkedDefaulted")
        .withArgs(borrower.address);

      const line = await attestLine.getCreditLine(borrower.address);
      expect(line.defaulted).to.be.true;

      // Draws frozen.
      await expect(attestLine.connect(borrower).draw(1n)).to.be.revertedWithCustomError(
        attestLine,
        "LineDefaulted"
      );
      expect(await attestLine.available(borrower.address)).to.equal(0n);

      // Repayment still allowed after default (interest frozen at default block);
      // repay the frozen interest only — the principal stays outstanding.
      const interestDue = await attestLine.accruedInterestOf(borrower.address);
      await (await lineToken.connect(borrower).approve(attestLine.target, interestDue)).wait();
      await expect(attestLine.connect(borrower).repay(interestDue))
        .to.emit(attestLine, "Repaid")
        .withArgs(borrower.address, interestDue, interestDue, 0n);
      // Principal untouched; default flag persists as a reputation record.
      expect((await attestLine.getCreditLine(borrower.address)).used).to.equal(limit);
      expect((await attestLine.getCreditLine(borrower.address)).defaulted).to.be.true;
    });

    it("cannot mark defaulted before the deadline or without debt", async () => {
      const { attestLine, creditActivity, borrower, stranger } = await loadFixture(deployTestStack);
      await expect(attestLine.connect(stranger).markDefaulted(borrower.address)).to.be.revertedWithCustomError(
        attestLine,
        "NoOutstandingDebt"
      );

      const amount = 8n * WEI;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(1n * WEI);

      await expect(attestLine.connect(stranger).markDefaulted(borrower.address)).to.be.revertedWithCustomError(
        attestLine,
        "DeadlineNotPassed"
      );
    });

    it("interest stops accruing at the default block", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      const amount = 8n * WEI;
      const limit = (amount * 12_000n) / 10_000n;
      await grantLine(attestLine, borrower, creditActivity, amount);
      await attestLine.connect(borrower).draw(limit);

      await mineBlocks(TERM_BLOCKS + 2);
      await attestLine.markDefaulted(borrower.address);
      const afterDefault = await attestLine.accruedInterestOf(borrower.address);
      expect(afterDefault).to.be.greaterThan(0n);

      await mineBlocks(50);
      expect(await attestLine.accruedInterestOf(borrower.address)).to.equal(afterDefault);
    });
  });

  describe("ownership & configuration", () => {
    it("only the owner can register the source contract", async () => {
      const { attestLine, creditActivity, other } = await loadFixture(deployTestStack);
      await expect(attestLine.connect(other).setSourceContract(other.address)).to.be.revertedWithCustomError(
        attestLine,
        "OwnableUnauthorizedAccount"
      );
      await expect(attestLine.setSourceContract(creditActivity.target)).to.emit(
        attestLine,
        "SourceContractRegistered"
      );
    });

    it("rejects the zero address as source contract", async () => {
      const { attestLine } = await loadFixture(deployTestStack);
      await expect(attestLine.setSourceContract(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        attestLine,
        "SourceContractNotRegistered"
      );
    });

    it("only the owner can set the line token, and only once", async () => {
      const { attestLine, other, lineToken } = await loadFixture(deployTestStack);
      await expect(attestLine.connect(other).setLineToken(lineToken.target)).to.be.revertedWithCustomError(
        attestLine,
        "OwnableUnauthorizedAccount"
      );
      await expect(attestLine.setLineToken(lineToken.target)).to.be.revertedWithCustomError(
        attestLine,
        "LineTokenAlreadySet"
      );
    });

    it("grants are rejected before a source contract is registered", async () => {
      const { attestLine, creditActivity, borrower } = await loadFixture(deployTestStack);
      // Deploy a fresh AttestLine without registering a source contract.
      const fresh = (await deployAttestLine(TERM_BLOCKS)) as AttestLine;
      const fx = buildFixture({
        sourceContract: creditActivity.target as string,
        account: borrower.address,
        amount: 8n * WEI,
      });
      await expect(fresh.connect(borrower).requestCreditLine(...grantArgs(fx))).to.be.revertedWithCustomError(
        fresh,
        "SourceContractNotRegistered"
      );
    });
  });

  describe("MockVerifier", () => {
    it("derives the transaction index from the Merkle sibling path (LSB-first)", async () => {
      const { mock } = await loadFixture(deployTestStack);
      const fx1 = buildFixture({
        sourceContract: ZERO_ADDRESS,
        account: ethers.Wallet.createRandom().address,
        amount: 1n,
        leafIndex: 0,
      });
      const fx3 = buildFixture({
        sourceContract: ZERO_ADDRESS,
        account: ethers.Wallet.createRandom().address,
        amount: 1n,
        leafIndex: 3,
      });
      const mp = (root: string, siblings: { hash: string; isLeft: boolean }[]) => ({
        root,
        siblings,
      });
      expect(await mock.calculateTxIndex(mp(fx1.merkleRoot, fx1.siblings))).to.equal(0n);
      expect(await mock.calculateTxIndex(mp(fx3.merkleRoot, fx3.siblings))).to.equal(3n);
    });

    it("accepts a valid Merkle proof and rejects a tampered leaf (strict mode)", async () => {
      const { mock } = await loadFixture(deployTestStack);
      const fx = buildFixture({
        sourceContract: ZERO_ADDRESS,
        account: ethers.Wallet.createRandom().address,
        amount: 42n,
      });
      const strict = await installMockVerifier({
        chainKey: 1,
        height: fx.blockHeight,
        root: fx.merkleRoot,
        enforce: true,
      });
      const mp = (root: string, siblings: { hash: string; isLeft: boolean }[]) => ({
        root,
        siblings,
      });
      expect(
        await strict.verify(fx.chainKey, fx.blockHeight, fx.encodedTx, mp(fx.merkleRoot, fx.siblings), {
          lowerEndpointDigest: fx.lowerEndpointDigest,
          roots: fx.continuityRoots,
        })
      ).to.equal(true);
      await expect(
        strict.verify(
          fx.chainKey,
          fx.blockHeight,
          "0x" + "ff".repeat(100),
          mp(fx.merkleRoot, fx.siblings),
          { lowerEndpointDigest: fx.lowerEndpointDigest, roots: fx.continuityRoots }
        )
      ).to.be.revertedWithCustomError(mock, "MockVerifierRejected");
    });
  });
});
