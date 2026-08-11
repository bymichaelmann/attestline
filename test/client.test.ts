/**
 * Unit tests for AttestLineClient — no network, no secrets.
 *
 * The @gluwa/usc-sdk ProofBuilder class is stubbed at the module level and the
 * contract instances are injected fakes (constructor DI), so every test is
 * fully deterministic. The EvmV1 decoding paths are exercised against the SAME
 * fixtures used by the on-chain tests (test/fixtures/encoded-transactions.ts).
 */
import { expect } from "chai";
import sinon from "sinon";
import { proofProvider } from "@gluwa/usc-sdk";
import {
  AttestLineClient,
  decodeCreditActivityFromEncodedTx,
  decodeCreditActivityFromReceipt,
  CREDIT_ACTIVITY_EVENT_SIGNATURE,
} from "../src/client";
import { buildFixture, ZERO_ADDRESS } from "./fixtures/encoded-transactions";

const CHAIN_KEY = 1;
const SOURCE_CONTRACT = "0x1111111111111111111111111111111111111111";
const ATTESTLINE_ADDRESS = "0x2222222222222222222222222222222222222222";
const LINE_TOKEN_ADDRESS = "0x3333333333333333333333333333333333333333";
const PROOF_BUILDER_URL = "https://prover.example.test";

describe("AttestLineClient", () => {
  let sandbox: sinon.SinonSandbox;
  let proofBuilderStub: {
    getProof: sinon.SinonStub;
    waitUntilHeightAttested: sinon.SinonStub;
  };
  let sourceProviderStub: {
    getTransaction: sinon.SinonStub;
    getTransactionReceipt: sinon.SinonStub;
  };
  let contractStub: {
    connect: sinon.SinonStub;
    requestCreditLine: sinon.SinonStub;
    draw: sinon.SinonStub;
    repay: sinon.SinonStub;
    getCreditLine: sinon.SinonStub;
    creditScoreOf: sinon.SinonStub;
    available: sinon.SinonStub;
    accruedInterestOf: sinon.SinonStub;
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    proofBuilderStub = {
      getProof: sandbox.stub(),
      waitUntilHeightAttested: sandbox.stub().resolves(undefined),
    };
    sandbox.stub(proofProvider.service, "ProofBuilder").returns(proofBuilderStub as never);

    sourceProviderStub = {
      getTransaction: sandbox.stub(),
      getTransactionReceipt: sandbox.stub(),
    };

    contractStub = {
      connect: sandbox.stub(),
      requestCreditLine: sandbox.stub(),
      draw: sandbox.stub(),
      repay: sandbox.stub(),
      getCreditLine: sandbox.stub(),
      creditScoreOf: sandbox.stub(),
      available: sandbox.stub(),
      accruedInterestOf: sandbox.stub(),
    };
    contractStub.connect.returns(contractStub);
  });

  afterEach(() => {
    sandbox.restore();
  });

  function makeClient(): AttestLineClient {
    return new AttestLineClient({
      creditcoinProvider: {} as never,
      sourceProvider: sourceProviderStub as never,
      proofBuilderUrl: PROOF_BUILDER_URL,
      chainKey: CHAIN_KEY,
      attestLineAddress: ATTESTLINE_ADDRESS,
      lineTokenAddress: LINE_TOKEN_ADDRESS,
      sourceContractAddress: SOURCE_CONTRACT,
      attestLineContract: contractStub as never,
      lineTokenContract: {} as never,
    });
  }

  function proofDataFor(fx: ReturnType<typeof buildFixture>) {
    return {
      chainKey: fx.chainKey,
      headerNumber: fx.blockHeight,
      txIndex: fx.txIndex,
      txHash: "0x" + "ab".repeat(32),
      txBytes: fx.encodedTx,
      merkleProof: { root: fx.merkleRoot, siblings: fx.siblings },
      continuityProof: {
        lowerEndpointDigest: fx.lowerEndpointDigest,
        roots: fx.continuityRoots,
      },
      cached: false,
      generatedAt: new Date("2024-01-01T00:00:00Z"),
    };
  }

  describe("decoding helpers", () => {
    it("decodes the activity event from an EvmV1-encoded transaction", () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 8_000_000_000_000_000_000n,
      });
      const decoded = decodeCreditActivityFromEncodedTx(fx.encodedTx);
      expect(decoded.account).to.equal("0x4444444444444444444444444444444444444444");
      expect(decoded.amount).to.equal(8_000_000_000_000_000_000n);
      expect(decoded.emitter).to.equal(SOURCE_CONTRACT);
    });

    it("decodes the activity event from a standard receipt", () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 42n,
      });
      const decoded = decodeCreditActivityFromReceipt({ logs: [fx.log] } as never);
      expect(decoded.account).to.equal("0x4444444444444444444444444444444444444444");
      expect(decoded.amount).to.equal(42n);
    });

    it("throws when no activity event is present", () => {
      expect(() =>
        decodeCreditActivityFromEncodedTx("0x" + "00".repeat(64))
      ).to.throw();
    });
  });

  describe("buildProof", () => {
    it("waits for attestation, generates a proof and decodes the event", async () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 8_000_000_000_000_000_000n,
      });
      sourceProviderStub.getTransaction.resolves({ blockNumber: fx.blockHeight, hash: "0x" + "ab".repeat(32) });
      proofBuilderStub.getProof.resolves({ success: true, data: proofDataFor(fx) });

      const client = makeClient();
      const result = await client.buildProof("0x" + "ab".repeat(32));

      expect(proofBuilderStub.waitUntilHeightAttested.calledOnceWith(fx.chainKey, fx.blockHeight, 15_000, 900_000)).to.equal(true);
      expect(proofBuilderStub.getProof.calledOnceWith("0x" + "ab".repeat(32))).to.equal(true);
      expect(result.proof.headerNumber).to.equal(fx.blockHeight);
      expect(result.activity.account).to.equal("0x4444444444444444444444444444444444444444");
      expect(result.activity.amount).to.equal(8_000_000_000_000_000_000n);
      expect(result.activity.emitter).to.equal(SOURCE_CONTRACT);
      expect(result.activity.txHash).to.equal("0x" + "ab".repeat(32));
    });

    it("propagates proof-builder failures", async () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 1n,
      });
      sourceProviderStub.getTransaction.resolves({ blockNumber: fx.blockHeight });
      proofBuilderStub.getProof.resolves({ success: false, error: "boom" });

      await expect(makeClient().buildProof("0x" + "ab".repeat(32))).to.be.rejectedWith(/boom/);
    });

    it("propagates attestation-wait failures", async () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 1n,
      });
      sourceProviderStub.getTransaction.resolves({ blockNumber: fx.blockHeight });
      proofBuilderStub.waitUntilHeightAttested.rejects(new Error("timeout waiting for attestation"));

      await expect(makeClient().buildProof("0x" + "ab".repeat(32))).to.be.rejectedWith(
        /timeout waiting for attestation/
      );
    });

    it("fails when the transaction does not exist on the source chain", async () => {
      sourceProviderStub.getTransaction.resolves(null);
      await expect(makeClient().buildProof("0x" + "ab".repeat(32))).to.be.rejectedWith(/does not exist/);
    });

    it("fails when the transaction is not yet mined", async () => {
      sourceProviderStub.getTransaction.resolves({ blockNumber: null });
      await expect(makeClient().buildProof("0x" + "ab".repeat(32))).to.be.rejectedWith(/not yet mined/);
    });
  });

  describe("requestCreditLine", () => {
    function setupHappyPath() {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 8_000_000_000_000_000_000n,
      });
      sourceProviderStub.getTransactionReceipt.resolves({ status: 1, logs: [fx.log] });
      sourceProviderStub.getTransaction.resolves({ blockNumber: fx.blockHeight, hash: "0x" + "ab".repeat(32) });
      proofBuilderStub.getProof.resolves({ success: true, data: proofDataFor(fx) });
      const receipt = { hash: "0x" + "cd".repeat(32) };
      contractStub.requestCreditLine.resolves({ wait: async () => receipt });
      return { fx, receipt };
    }

    it("builds the proof and submits requestCreditLine with the decoded arguments", async () => {
      const { fx, receipt } = setupHappyPath();
      const client = makeClient();
      const signer = { getAddress: async () => "0x4444444444444444444444444444444444444444" };

      const result = await client.requestCreditLine("0x" + "ab".repeat(32), signer as never);

      expect(result).to.equal(receipt);
      expect(contractStub.requestCreditLine.calledOnce).to.equal(true);
      const args = contractStub.requestCreditLine.firstCall.args;
      expect(args[0]).to.equal(fx.chainKey);
      expect(args[1]).to.equal(fx.blockHeight);
      expect(args[2]).to.equal(fx.encodedTx);
      expect(args[3]).to.equal(fx.merkleRoot);
      expect(args[4]).to.deep.equal(fx.siblings);
      expect(args[5]).to.equal(fx.lowerEndpointDigest);
      expect(args[6]).to.deep.equal(fx.continuityRoots);
    });

    it("fast-fails when the attested account does not match the signer (no proof built)", async () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x5555555555555555555555555555555555555555", // someone else
        amount: 1n,
      });
      sourceProviderStub.getTransactionReceipt.resolves({ status: 1, logs: [fx.log] });
      const client = makeClient();
      const signer = { getAddress: async () => "0x4444444444444444444444444444444444444444" };

      await expect(
        client.requestCreditLine("0x" + "ab".repeat(32), signer as never)
      ).to.be.rejectedWith(/does not match the signer/);
      expect(proofBuilderStub.getProof.called).to.equal(false);
    });

    it("fast-fails when the source transaction failed (receipt status 0)", async () => {
      const fx = buildFixture({
        sourceContract: SOURCE_CONTRACT,
        account: "0x4444444444444444444444444444444444444444",
        amount: 1n,
      });
      sourceProviderStub.getTransactionReceipt.resolves({ status: 0, logs: [fx.log] });

      await expect(
        makeClient().requestCreditLine("0x" + "ab".repeat(32), { getAddress: async () => fx.account } as never)
      ).to.be.rejectedWith(/did not succeed/);
      expect(proofBuilderStub.getProof.called).to.equal(false);
    });

    it("fast-fails when the event emitter is not the registered source contract", async () => {
      const fx = buildFixture({
        sourceContract: ZERO_ADDRESS, // fixture emitter
        account: "0x4444444444444444444444444444444444444444",
        amount: 1n,
      });
      sourceProviderStub.getTransactionReceipt.resolves({ status: 1, logs: [fx.log] });

      await expect(
        makeClient().requestCreditLine("0x" + "ab".repeat(32), { getAddress: async () => fx.account } as never)
      ).to.be.rejectedWith(/registered source contract/);
      expect(proofBuilderStub.getProof.called).to.equal(false);
    });

    it("fails when the receipt is not found on the source chain", async () => {
      sourceProviderStub.getTransactionReceipt.resolves(null);
      await expect(
        makeClient().requestCreditLine("0x" + "ab".repeat(32), { getAddress: async () => "0x4444444444444444444444444444444444444444" } as never)
      ).to.be.rejectedWith(/not found/);
    });
  });

  describe("read & write operations", () => {
    it("getSupportedChains delegates to the ChainInfo precompile provider", async () => {
      const client = makeClient();
      const info = [{ chainKey: 1, chainId: 11155111, chainName: "Ethereum Sepolia", chainEncoding: 1 }];
      sandbox.stub(client.chainInfoProvider, "getSupportedChains").resolves(info as never);
      expect(await client.getSupportedChains()).to.equal(info);
    });

    it("draw submits a transaction and returns its receipt", async () => {
      const receipt = { hash: "0x" + "aa".repeat(32) };
      contractStub.draw.resolves({ wait: async () => receipt });
      const signer = {} as never;
      const result = await makeClient().draw(123n, signer);
      expect(result).to.equal(receipt);
      expect(contractStub.draw.calledOnceWith(123n)).to.equal(true);
    });

    it("repay submits a transaction and returns its receipt", async () => {
      const receipt = { hash: "0x" + "bb".repeat(32) };
      contractStub.repay.resolves({ wait: async () => receipt });
      const result = await makeClient().repay(456n, {} as never);
      expect(result).to.equal(receipt);
      expect(contractStub.repay.calledOnceWith(456n)).to.equal(true);
    });

    it("getCreditLine normalizes the on-chain struct", async () => {
      contractStub.getCreditLine.resolves({
        borrower: "0x4444444444444444444444444444444444444444",
        creditLimit: 1000n,
        used: 250n,
        interestRateBps: 800n,
        createdAtBlock: 5n,
        deadlineBlock: 1005n,
        defaulted: false,
      });
      const line = await makeClient().getCreditLine("0x4444444444444444444444444444444444444444");
      expect(line.creditLimit).to.equal(1000n);
      expect(line.used).to.equal(250n);
      expect(line.defaulted).to.equal(false);
      expect(contractStub.getCreditLine.calledOnceWith("0x4444444444444444444444444444444444444444")).to.equal(true);
    });

    it("creditScoreOf / available / accruedInterestOf delegate to the contract", async () => {
      contractStub.creditScoreOf.resolves(450n);
      contractStub.available.resolves(750n);
      contractStub.accruedInterestOf.resolves(3n);
      const client = makeClient();
      const addr = "0x4444444444444444444444444444444444444444";
      expect(await client.creditScoreOf(addr)).to.equal(450n);
      expect(await client.available(addr)).to.equal(750n);
      expect(await client.accruedInterestOf(addr)).to.equal(3n);
    });
  });

  describe("event signature consistency", () => {
    it("matches the contract fixture constant", async () => {
      // Imported lazily to avoid a circular top-level import in fixtures.
      const { CREDIT_ACTIVITY_EVENT_SIGNATURE: fixtureSig } = await import("./fixtures/encoded-transactions");
      expect(CREDIT_ACTIVITY_EVENT_SIGNATURE).to.equal(fixtureSig);
    });
  });
});
