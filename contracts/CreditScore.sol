// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title CreditScore
 * @notice Pure, deterministic credit-scoring library used by AttestLine.
 * @dev The score is a function of the ATTESTED on-chain activity amount ONLY:
 *      no storage, no external calls, trivially unit-testable.
 *
 *      Model (documented in ARCHITECTURE.md):
 *      - `tokens = attestedAmount / 1e18` (whole tokens of committed value)
 *      - `steps = floor(log2(tokens + 1))` — logarithmic "activity band"
 *      - `score = min(850, 300 + 50 * steps)` — FICO-like 300..850 scale
 *      - credit-limit factor and APR are tiered on the same activity band:
 *        steps 0 -> 0.5x / 18% APR
 *        steps 1 -> 0.8x / 15% APR
 *        steps 2 -> 1.0x / 12% APR
 *        steps 3 -> 1.2x / 10% APR
 *        steps >= 4 -> 1.5x / 8% APR
 */
library CreditScore {
    uint256 public constant MAX_SCORE = 850;
    uint256 public constant MIN_SCORE = 300;
    uint256 public constant WEI_PER_TOKEN = 1e18;
    uint256 public constant SCORE_PER_LOG2_STEP = 50;

    /// @notice Evaluate attested activity into (score, limitFactorBps, aprBps).
    /// @param attestedAmount Amount (wei) attested on the source chain.
    /// @return score Credit score on the 300-850 scale.
    /// @return limitFactorBps Credit limit = attestedAmount * limitFactorBps / 10000.
    /// @return aprBps Annual interest rate in basis points (1% = 100 bps).
    function evaluate(uint256 attestedAmount)
        public
        pure
        returns (uint256 score, uint256 limitFactorBps, uint256 aprBps)
    {
        uint256 steps = _activitySteps(attestedAmount);

        score = MIN_SCORE + SCORE_PER_LOG2_STEP * steps;
        if (score > MAX_SCORE) {
            score = MAX_SCORE;
        }

        if (steps == 0) {
            limitFactorBps = 5_000; // 0.5x
            aprBps = 1_800; // 18%
        } else if (steps == 1) {
            limitFactorBps = 8_000; // 0.8x
            aprBps = 1_500; // 15%
        } else if (steps == 2) {
            limitFactorBps = 10_000; // 1.0x
            aprBps = 1_200; // 12%
        } else if (steps == 3) {
            limitFactorBps = 12_000; // 1.2x
            aprBps = 1_000; // 10%
        } else {
            limitFactorBps = 15_000; // 1.5x
            aprBps = 800; // 8%
        }
    }

    /// @notice Score-only view for a given attested amount.
    function scoreOf(uint256 attestedAmount) public pure returns (uint256) {
        uint256 steps = _activitySteps(attestedAmount);
        uint256 score = MIN_SCORE + SCORE_PER_LOG2_STEP * steps;
        return score > MAX_SCORE ? MAX_SCORE : score;
    }

    /// @dev floor(log2(attestedAmount / 1e18 + 1)) — saturating logarithmic band.
    function _activitySteps(uint256 attestedAmount) private pure returns (uint256 steps) {
        uint256 x = attestedAmount / WEI_PER_TOKEN + 1;
        while (x > 1) {
            x >>= 1;
            steps++;
        }
    }
}
