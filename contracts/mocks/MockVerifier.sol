// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "../interfaces/INativeQueryVerifier.sol";

/**
 * @title MockVerifier
 * @notice TEST-ONLY stand-in for the Block Prover precompile (0x…0FD2). Tests
 *         inject its bytecode at the precompile address via `hardhat_setCode`
 *         so that AttestLine's real code path (calling the precompile address
 *         through `NativeQueryVerifierLib.getVerifier()`) is exercised
 *         deterministically on a local Hardhat network — no RPC, no secrets.
 *
 * @dev Faithful model of the real precompile's observable behavior:
 *      - `calculateTxIndex` derives the transaction index from the Merkle
 *        sibling path (LSB-first: sibling[i].isLeft sets bit i).
 *      - `verify`/`verifyAndEmit` recompute the block root from the encoded
 *        transaction + siblings using the canonical Keccak Merkle scheme
 *        (leaf = keccak256(0x00 ‖ tx), inner = keccak256(0x01 ‖ left ‖ right))
 *        and revert on mismatch — exactly like the Rust precompile.
 *      - Optionally enforce an expected (chainKey, height) pair and/or fail
 *        every verification, so tests can exercise the reject paths.
 *
 * @dev STORAGE LAYOUT (deliberately simple — six independent 32-byte slots so
 *      tests can transplant configuration to the precompile address with
 *      `hardhat_setStorageAt` after `hardhat_setCode`):
 *      slot 0: expectedChainKey     slot 1: expectedHeight
 *      slot 2: acceptedRoot         slot 3: enforceExpectation
 *      slot 4: failAll              slot 5: returnFalse
 */
contract MockVerifier is INativeQueryVerifier {
    // Slots 0-5, see layout note above.
    uint256 public expectedChainKey;
    uint256 public expectedHeight;
    bytes32 public acceptedRoot;
    uint256 public enforceExpectation;
    uint256 public failAll;
    uint256 public returnFalse;

    error MockVerifierRejected();

    /// @notice Configure the mock. Test-only.
    function __configure(
        uint256 chainKey_,
        uint256 height_,
        bytes32 root_,
        bool enforce_,
        bool fail_,
        bool returnFalse_
    ) external {
        expectedChainKey = chainKey_;
        expectedHeight = height_;
        acceptedRoot = root_;
        enforceExpectation = enforce_ ? 1 : 0;
        failAll = fail_ ? 1 : 0;
        returnFalse = returnFalse_ ? 1 : 0;
    }

    /// @notice Return the raw storage-slot values (0..5) so tests can transplant
    ///         the configuration onto the precompile address after hardhat_setCode.
    function __configSnapshot() external view returns (bytes32[] memory values) {
        values = new bytes32[](6);
        values[0] = bytes32(expectedChainKey);
        values[1] = bytes32(expectedHeight);
        values[2] = acceptedRoot;
        values[3] = bytes32(enforceExpectation);
        values[4] = bytes32(failAll);
        values[5] = bytes32(returnFalse);
    }

    // ── INativeQueryVerifier ────────────────────────────────────────────────

    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata
    ) external view returns (bool) {
        _check(chainKey, height, encodedTransaction, merkleProof);
        // returnFalse mode: return false WITHOUT reverting, so AttestLine's own
        // ProofVerificationFailed branch is exercised (the real precompile never
        // returns false, so tests need a mock-only switch to reach that path).
        return returnFalse == 0;
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata
    ) external returns (bool) {
        _check(chainKey, height, encodedTransaction, merkleProof);
        emit TransactionVerified(chainKey, height, calculateTxIndex(merkleProof));
        return returnFalse == 0;
    }

    function calculateTxIndex(MerkleProof calldata merkleProof) public pure returns (uint64) {
        uint256 index;
        uint256 n = merkleProof.siblings.length;
        for (uint256 i = 0; i < n; i++) {
            if (merkleProof.siblings[i].isLeft) {
                index |= (uint256(1) << i);
            }
        }
        return uint64(index);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    function _check(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof
    ) internal view {
        if (failAll != 0) {
            revert MockVerifierRejected();
        }
        // Lax mode (enforceExpectation == 0) accepts every proof: used by most
        // AttestLine logic tests that exercise decode/validation paths.
        if (enforceExpectation == 0) {
            return;
        }
        // Strict mode mirrors the real precompile: chainKey/height must match the
        // attested header and the recomputed root must match the accepted root.
        if (uint256(chainKey) != expectedChainKey || uint256(height) != expectedHeight) {
            revert MockVerifierRejected();
        }
        // Recomputed root must match the accepted root (canonical Keccak Merkle scheme)
        // AND the root submitted in the proof must be consistent with the path.
        bytes32 node = keccak256(abi.encodePacked(uint8(0), encodedTransaction));
        uint256 n = merkleProof.siblings.length;
        for (uint256 i = 0; i < n; i++) {
            if (merkleProof.siblings[i].isLeft) {
                node = keccak256(abi.encodePacked(uint8(1), merkleProof.siblings[i].hash, node));
            } else {
                node = keccak256(abi.encodePacked(uint8(1), node, merkleProof.siblings[i].hash));
            }
        }
        if (node != acceptedRoot || node != merkleProof.root) {
            revert MockVerifierRejected();
        }
    }
}
