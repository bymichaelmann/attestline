import { expect } from "chai";
import hre from "hardhat";
import { CreditScore__factory, type CreditScore } from "../typechain-types";

const { ethers } = hre;

const WEI = 10n ** 18n;
const MAX_SCORE = 850n;
const MIN_SCORE = 300n;

const BPS = {
  L0: [5000n, 1800n] as const, // 0.5x / 18%
  L1: [8000n, 1500n] as const, // 0.8x / 15%
  L2: [10000n, 1200n] as const, // 1.0x / 12%
  L3: [12000n, 1000n] as const, // 1.2x / 10%
  L4: [15000n, 800n] as const, // 1.5x / 8%
};

/**
 * Reference implementation of the scoring model (must stay in sync with
 * contracts/CreditScore.sol). Used to generate the expected-value table.
 */
function referenceEvaluate(amountWei: bigint): { score: bigint; factor: bigint; apr: bigint } {
  const tokens = amountWei / WEI;
  let x = tokens + 1n;
  let steps = 0n;
  while (x > 1n) {
    x >>= 1n;
    steps++;
  }
  let score = MIN_SCORE + 50n * steps;
  if (score > MAX_SCORE) score = MAX_SCORE;
  let factor: bigint;
  let apr: bigint;
  if (steps === 0n) [factor, apr] = BPS.L0;
  else if (steps === 1n) [factor, apr] = BPS.L1;
  else if (steps === 2n) [factor, apr] = BPS.L2;
  else if (steps === 3n) [factor, apr] = BPS.L3;
  else [factor, apr] = BPS.L4;
  return { score, factor, apr };
}

describe("CreditScore", () => {
  let lib: CreditScore;

  before(async () => {
    const [signer] = await ethers.getSigners();
    lib = await new CreditScore__factory(signer).deploy();
  });

  describe("evaluate", () => {
    const amounts: { label: string; wei: bigint; score: bigint; factor: bigint; apr: bigint }[] = [
      { label: "zero", wei: 0n, score: 300n, factor: 5000n, apr: 1800n },
      { label: "dust (< 1 token)", wei: 1n, score: 300n, factor: 5000n, apr: 1800n },
      { label: "0.5 token", wei: WEI / 2n, score: 300n, factor: 5000n, apr: 1800n },
      { label: "1 token", wei: 1n * WEI, score: 350n, factor: 8000n, apr: 1500n },
      { label: "2 tokens", wei: 2n * WEI, score: 350n, factor: 8000n, apr: 1500n },
      { label: "3 tokens", wei: 3n * WEI, score: 400n, factor: 10000n, apr: 1200n },
      { label: "4 tokens", wei: 4n * WEI, score: 400n, factor: 10000n, apr: 1200n },
      { label: "7 tokens", wei: 7n * WEI, score: 450n, factor: 12000n, apr: 1000n },
      { label: "8 tokens", wei: 8n * WEI, score: 450n, factor: 12000n, apr: 1000n },
      { label: "15 tokens", wei: 15n * WEI, score: 500n, factor: 15000n, apr: 800n },
      { label: "16 tokens", wei: 16n * WEI, score: 500n, factor: 15000n, apr: 800n },
      { label: "100 tokens", wei: 100n * WEI, score: 600n, factor: 15000n, apr: 800n },
      { label: "1_000 tokens", wei: 1_000n * WEI, score: 750n, factor: 15000n, apr: 800n },
      { label: "2_047 tokens (score cap)", wei: 2_047n * WEI, score: 850n, factor: 15000n, apr: 800n },
      { label: "2_048 tokens", wei: 2_048n * WEI, score: 850n, factor: 15000n, apr: 800n },
      { label: "1e12 tokens", wei: 10n ** 30n, score: 850n, factor: 15000n, apr: 800n },
      { label: "max uint256 wei", wei: 2n ** 256n - 1n, score: 850n, factor: 15000n, apr: 800n },
    ];

    for (const t of amounts) {
      it(`returns exact values for ${t.label}`, async () => {
        const [score, factor, apr] = await lib.evaluate(t.wei);
        expect(score).to.equal(t.score);
        expect(factor).to.equal(t.factor);
        expect(apr).to.equal(t.apr);
      });
    }

    it("matches the reference implementation across a wide sweep of amounts", async () => {
      const sweep: bigint[] = [];
      for (let i = 0n; i <= 300n; i++) sweep.push(i * WEI); // 0..300 tokens
      for (let i = 1n; i <= 40n; i++) sweep.push(i * 10n ** 18n * 10n ** 6n); // 1e6..40e6 tokens
      for (let i = 0n; i < 20n; i++) sweep.push(10n ** (18n + i)); // 1..1e19 tokens
      sweep.push(2n ** 256n - 1n);

      for (const amount of sweep) {
        const expected = referenceEvaluate(amount);
        const [score, factor, apr] = await lib.evaluate(amount);
        expect(score, `score for ${amount}`).to.equal(expected.score);
        expect(factor, `factor for ${amount}`).to.equal(expected.factor);
        expect(apr, `apr for ${amount}`).to.equal(expected.apr);
      }
    });

    it("is monotone: score and limit factor never decrease with amount; APR never increases", async () => {
      let prevScore = -1n;
      let prevFactor = -1n;
      let prevApr = 2n ** 256n - 1n;
      for (let i = 0n; i <= 5000n; i += 7n) {
        const [score, factor, apr] = await lib.evaluate(i * WEI);
        expect(score).to.be.gte(prevScore);
        expect(factor).to.be.gte(prevFactor);
        expect(apr).to.be.lte(prevApr);
        prevScore = score;
        prevFactor = factor;
        prevApr = apr;
      }
    });
  });

  describe("scoreOf", () => {
    it("returns 300 for zero input", async () => {
      expect(await lib.scoreOf(0n)).to.equal(MIN_SCORE);
    });

    it("returns 850 for very large input (cap)", async () => {
      expect(await lib.scoreOf(2n ** 256n - 1n)).to.equal(MAX_SCORE);
      expect(await lib.scoreOf(10n ** 30n)).to.equal(MAX_SCORE);
    });

    it("is consistent with evaluate", async () => {
      for (const amount of [0n, 1n, WEI, 8n * WEI, 100n * WEI, 2_047n * WEI, 10n ** 30n]) {
        const [score] = await lib.evaluate(amount);
        expect(await lib.scoreOf(amount)).to.equal(score);
      }
    });
  });
});
