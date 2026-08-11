// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title INativeQueryVerifier
 * @notice Interface of the Block Prover precompile on Creditcoin (address
 *         0x0000000000000000000000000000000000000FD2, decimal 4050).
 * @dev Vendored from the official Attestcoin Protocol example
 *      (github.com/gluwa/usc-testnet-bridge-examples, contracts/sol/VerifierInterface.sol)
 *      and completed with the read-only `verify` view from the canonical
 *      precompile ABI (block_prover.json shipped with the gluwa usc-sdk npm package). Struct layouts and
 *      function signatures are byte-identical with the precompile interface so
 *      that the contract can be used both against the real precompile and
 *      against the test-only MockVerifier deployed at the same address.
 *
 *      The precompile proves INCLUSION of a transaction in a finalized block of
 *      an attested chain (Merkle proof + continuity chain). It does NOT prove
 *      that the transaction succeeded — ASCs must decode the receipt and check
 *      `receiptStatus == 1` themselves.
 */
interface INativeQueryVerifier {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Emitted by verifyAndEmit for each successfully verified transaction.
    event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);

    /// @notice Verify inclusion of a single transaction (read-only). Reverts on failure.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Verify inclusion of a single transaction and emit TransactionVerified.
    ///         State-changing; ASCs MUST use this variant so that verification is
    ///         auditable on-chain. Reverts on failure.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);

    /// @notice Derive the transaction's index within its block from the Merkle
    ///         proof sibling path (LSB-first: sibling[i].isLeft sets bit i).
    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64);
}

/**
 * @title NativeQueryVerifierLib
 * @notice Helper returning the Block Prover precompile instance.
 */
library NativeQueryVerifierLib {
    address constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000FD2;

    function getVerifier() internal pure returns (INativeQueryVerifier) {
        return INativeQueryVerifier(PRECOMPILE_ADDRESS);
    }
}
