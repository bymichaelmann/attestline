// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AttestLine} from "../AttestLine.sol";
import {LineToken} from "../LineToken.sol";
import {INativeQueryVerifier} from "../interfaces/INativeQueryVerifier.sol";

/**
 * @title TestHarness
 * @notice TEST-ONLY helper that lets a contract be the borrower and perform
 *         draw+repay in a SINGLE block, so that the elapsed-blocks interest is
 *         exactly zero. This mirrors a borrower who repays in the same block
 *         they drew (e.g. via batching) and lets tests exercise the full
 *         grant → draw → repay → settle cycle deterministically without needing
 *         to source extra ALCT to cover interest.
 */
contract TestHarness {
    function requestLine(
        AttestLine attestLine,
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (AttestLine.CreditLine memory) {
        return attestLine.requestCreditLine(
            chainKey, blockHeight, encodedTransaction, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
    }

    function drawAndRepay(AttestLine attestLine, LineToken token, uint256 amount) external {
        attestLine.draw(amount);
        token.approve(address(attestLine), amount);
        attestLine.repay(amount);
    }
}
