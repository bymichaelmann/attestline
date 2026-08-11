// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {INativeQueryVerifier, NativeQueryVerifierLib} from "./interfaces/INativeQueryVerifier.sol";
import {CreditScore} from "./CreditScore.sol";
import {LineToken} from "./LineToken.sol";

/**
 * @title AttestLine
 * @notice An Attestcoin Smart Contract (ASC) on Creditcoin that grants on-chain
 *         credit lines to borrowers based on ATTESTED cross-chain on-chain
 *         activity. Underwriting is driven by inclusion proofs of transactions
 *         that happened on a source chain (Ethereum Sepolia), verified natively
 *         on Creditcoin through the Block Prover precompile (0x…0FD2) — no
 *         centralized oracle operators.
 *
 * @dev Proof flow (per Attestcoin Protocol):
 *      1. A borrower calls `recordActivity` on the source-chain CreditActivity
 *         contract, committing on-chain activity (amount).
 *      2. The borrower submits a proof of inclusion (Merkle + continuity) for
 *         that transaction to `requestCreditLine`.
 *      3. The ASC calls `VERIFIER.verifyAndEmit(...)` (the precompile), which
 *         proves INCLUSION in a finalized, attested block — NOT success. The
 *         ASC therefore decodes the receipt and requires `receiptStatus == 1`.
 *      4. The ASC extracts the `CreditActivityRecorded` log(s), validates the
 *         emitting address == registered source contract, and that the indexed
 *         account == msg.sender.
 *      5. `CreditScore.evaluate(amount)` yields (score, limit factor, APR) and
 *         a credit line is stored. The borrower can then draw/repay in LineToken.
 *
 *      Replay protection: every processed proof is keyed by
 *      `keccak256(chainKey, blockHeight, txIndex)` (txIndex derived from the
 *      Merkle sibling path via `VERIFIER.calculateTxIndex`) and can only be
 *      used once.
 *
 *      Credit lines are reputation-collateralized: there is NO liquidation of
 *      collateral in v1. A line past its deadline with outstanding principal
 *      can be marked defaulted by anyone (freezing draws; repayment remains
 *      allowed), which is a permanent on-chain reputation event.
 */
contract AttestLine is Ownable, ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Event signature of the source-chain activity event:
    ///         keccak256("CreditActivityRecorded(address,uint256)")
    bytes32 public constant CREDIT_ACTIVITY_EVENT_SIGNATURE =
        keccak256("CreditActivityRecorded(address,uint256)");

    /// @notice Blocks per year used for linear per-block interest accrual
    ///         (Creditcoin produces a block roughly every 12 seconds).
    uint256 public constant BLOCKS_PER_YEAR = 2_102_400;

    /// @notice Basis point denominator (100% = 10_000 bps).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The Block Prover precompile instance (0x…0FD2).
    INativeQueryVerifier public immutable VERIFIER;

    /// @notice Token the protocol lends. Owner-settable once.
    LineToken public lineToken;

    /// @notice The ONLY source-chain contract whose activity events are accepted.
    address public sourceContract;

    /// @notice Replay protection: processed proof keys
    ///         (keccak256(chainKey, blockHeight, txIndex)).
    mapping(bytes32 => bool) public processedQueries;

    /// @notice Term (in blocks) of newly granted credit lines.
    uint256 public termBlocks;

    /// @notice A borrower's credit line.
    struct CreditLine {
        address borrower;
        uint256 creditLimit;
        uint256 used;
        uint256 interestRateBps;
        uint256 createdAtBlock;
        uint256 deadlineBlock;
        bool defaulted;
    }

    mapping(address => CreditLine) public creditLines;

    /// @notice Per-borrower interest accrual state (extension to CreditLine,
    ///         kept separate to preserve the exact struct shape above).
    struct InterestState {
        uint256 accruedInterest;
        uint256 lastAccrualBlock;
    }

    mapping(address => InterestState) internal _interest;

    /// @notice Amount attested by the borrower's most recent accepted proof.
    mapping(address => uint256) public lastActivityAmount;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event SourceContractRegistered(address indexed sourceContract);
    event LineTokenSet(address indexed lineToken);
    event CreditLineGranted(
        address indexed borrower,
        uint256 amount,
        uint256 limit,
        uint256 score,
        uint256 aprBps
    );
    event Drawn(address indexed borrower, uint256 amount);
    event Repaid(address indexed borrower, uint256 amount, uint256 interestAmount, uint256 principalAmount);
    event LineSettled(address indexed borrower);
    event MarkedDefaulted(address indexed borrower);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroAmount();
    error SourceContractNotRegistered();
    error ActiveCreditLineExists();
    error NoCreditLine();
    error LineDefaulted();
    error LineExpired();
    error ExceedsCreditLimit();
    error NoOutstandingDebt();
    error RepayDoesNotCoverInterest();
    error Overpay();
    error DeadlineNotPassed();
    error AlreadyDefaulted();
    error ProofAlreadyProcessed();
    error ProofVerificationFailed();
    error UnsupportedTransactionType();
    error TransactionDidNotSucceed();
    error NoCreditActivityEvent();
    error EventNotFromSourceContract();
    error InvalidEventTopics();
    error InvalidEventData();
    error AccountMismatch();
    error LineTokenAlreadySet();
    error InvalidLineToken();
    error InvalidTermBlocks();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param termBlocks_ Term of a credit line in blocks (e.g. 648_000 ≈ 90 days
     *                    at 12s blocks). Parameterized for testability.
     */
    constructor(uint256 termBlocks_) Ownable(msg.sender) {
        if (termBlocks_ == 0) {
            revert InvalidTermBlocks();
        }
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        termBlocks = termBlocks_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner configuration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register the source-chain contract authorized to emit
     *         CreditActivityRecorded events. Only events emitted by this address
     *         are accepted when processing proofs.
     */
    function setSourceContract(address _sourceContract) external onlyOwner {
        if (_sourceContract == address(0)) {
            revert SourceContractNotRegistered();
        }
        sourceContract = _sourceContract;
        emit SourceContractRegistered(_sourceContract);
    }

    /**
     * @notice Set the token the protocol lends. Can only be set once.
     */
    function setLineToken(address _lineToken) external onlyOwner {
        if (_lineToken == address(0)) {
            revert InvalidLineToken();
        }
        if (address(lineToken) != address(0)) {
            revert LineTokenAlreadySet();
        }
        lineToken = LineToken(_lineToken);
        emit LineTokenSet(_lineToken);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core: underwriting a credit line from an attested source transaction
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Request a credit line by proving inclusion of a
     *         CreditActivityRecorded transaction on the source chain.
     * @dev All parameters except `siblings` mirror the Block Prover precompile's
     *      verifyAndEmit arguments; `merkleRoot` and `siblings` together form the
     *      MerkleProof, `lowerEndpointDigest` + `continuityRoots` the ContinuityProof.
     *
     * @param chainKey Chain key of the source chain (1 = Ethereum Sepolia).
     * @param blockHeight Block height of the attested transaction.
     * @param encodedTransaction EvmV1 ABI-encoded transaction + receipt.
     * @param merkleRoot Merkle root of the block containing the transaction.
     * @param siblings Merkle proof sibling path for the transaction.
     * @param lowerEndpointDigest Continuity proof lower bound.
     * @param continuityRoots Continuity proof block roots.
     */
    function requestCreditLine(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external nonReentrant returns (CreditLine memory) {
        // ── 1. Replay protection ────────────────────────────────────────────
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

        uint64 txIndex = VERIFIER.calculateTxIndex(merkleProof);
        bytes32 txKey = _computeTxKey(chainKey, blockHeight, txIndex);
        if (processedQueries[txKey]) {
            revert ProofAlreadyProcessed();
        }

        // ── 2. Verify proof of inclusion (state-changing, emits
        //       TransactionVerified on the precompile) ───────────────────────
        bool verified = _verifyProof(
            chainKey, blockHeight, encodedTransaction, merkleProof, lowerEndpointDigest, continuityRoots
        );
        if (!verified) {
            revert ProofVerificationFailed();
        }

        // ── 3. Mark processed (post-verification) ───────────────────────────
        processedQueries[txKey] = true;

        // ── 4-7. Decode, validate, score, store ─────────────────────────────
        return _grantCreditLine(encodedTransaction);
    }

    /// @dev Verify inclusion via the Block Prover precompile.
    function _verifyProof(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof memory merkleProof,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) internal returns (bool verified) {
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({
                lowerEndpointDigest: lowerEndpointDigest,
                roots: continuityRoots
            });

        verified = VERIFIER.verifyAndEmit(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);
    }

    /// @dev Decode + validate the attested transaction, score it, store the line.
    function _grantCreditLine(bytes memory encodedTransaction) internal returns (CreditLine memory) {
        // ── 4. Decode + validate transaction type and receipt status ────────
        //      The precompile only proves inclusion; success must be checked here.
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) {
            revert UnsupportedTransactionType();
        }
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) {
            revert TransactionDidNotSucceed();
        }

        // ── 5. Extract CreditActivityRecorded log(s) ────────────────────────
        EvmV1Decoder.LogEntry[] memory activityLogs =
            EvmV1Decoder.getLogsByEventSignature(receipt, CREDIT_ACTIVITY_EVENT_SIGNATURE);
        if (activityLogs.length == 0) {
            revert NoCreditActivityEvent();
        }
        if (sourceContract == address(0)) {
            revert SourceContractNotRegistered();
        }

        // Only the first matching log is processed (fixtures/proofs carry one).
        EvmV1Decoder.LogEntry memory log = activityLogs[0];

        // The event must have been emitted by the registered source contract.
        if (log.address_ != sourceContract) {
            revert EventNotFromSourceContract();
        }
        if (log.topics.length != 2 || log.topics[0] != CREDIT_ACTIVITY_EVENT_SIGNATURE) {
            revert InvalidEventTopics();
        }
        if (log.data.length != 32) {
            revert InvalidEventData();
        }

        // ── 6. Decode account + amount, bind to the caller ──────────────────
        address account = address(uint160(uint256(log.topics[1])));
        uint256 amount = abi.decode(log.data, (uint256));
        if (account != msg.sender) {
            revert AccountMismatch();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }

        // ── 7. Score → limit/APR, store the credit line ─────────────────────
        CreditLine storage line = creditLines[msg.sender];
        if (line.used > 0) {
            // A borrower may hold at most one line; outstanding principal must
            // be repaid before a new (or refreshed) line can be granted.
            revert ActiveCreditLineExists();
        }

        (uint256 score, uint256 limitFactorBps, uint256 aprBps) = CreditScore.evaluate(amount);
        uint256 creditLimit = (amount * limitFactorBps) / BPS_DENOMINATOR;

        line.borrower = msg.sender;
        line.creditLimit = creditLimit;
        line.used = 0;
        line.interestRateBps = aprBps;
        line.createdAtBlock = block.number;
        line.deadlineBlock = block.number + termBlocks;
        line.defaulted = false;

        lastActivityAmount[msg.sender] = amount;
        _interest[msg.sender] = InterestState({accruedInterest: 0, lastAccrualBlock: block.number});

        emit CreditLineGranted(msg.sender, amount, creditLimit, score, aprBps);

        return line;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lending
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Draw `amount` of LineToken against the caller's credit line.
     * @dev Mints new tokens (the protocol is the sole minter). Interest starts
     *      accruing from the block of the draw.
     */
    function draw(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        CreditLine storage line = creditLines[msg.sender];
        _requireActiveLine(line);

        _accrueInterest(msg.sender);

        if (line.used + amount > line.creditLimit) {
            revert ExceedsCreditLimit();
        }
        line.used += amount;
        // Interest accrues on the newly drawn principal from this block onward.
        _interest[msg.sender].lastAccrualBlock = block.number;

        lineToken.mint(msg.sender, amount);

        emit Drawn(msg.sender, amount);
    }

    /**
     * @notice Repay `amount` of LineToken (principal + interest).
     * @dev Chosen accounting model (documented in ARCHITECTURE.md):
     *      every repayment must first settle ALL interest accrued to date;
     *      the remainder (if any) reduces principal. When principal reaches
     *      zero the line is settled and a new line can be requested.
     *      Interest paid stays in the protocol (AttestLine holds the tokens).
     */
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        CreditLine storage line = creditLines[msg.sender];
        if (line.borrower != msg.sender || line.used == 0) {
            revert NoOutstandingDebt();
        }

        _accrueInterest(msg.sender);

        InterestState storage istate = _interest[msg.sender];
        uint256 interestDue = istate.accruedInterest;
        if (amount < interestDue) {
            revert RepayDoesNotCoverInterest();
        }
        uint256 principalPayment = amount - interestDue;
        if (principalPayment > line.used) {
            revert Overpay();
        }

        // Effects (checks-effects-interactions).
        istate.accruedInterest = 0;
        istate.lastAccrualBlock = block.number;
        line.used -= principalPayment;

        // Interactions.
        lineToken.transferFrom(msg.sender, address(this), amount);

        emit Repaid(msg.sender, amount, interestDue, principalPayment);
        if (line.used == 0) {
            emit LineSettled(msg.sender);
        }
    }

    /**
     * @notice Mark a borrower's line as defaulted once the deadline has passed
     *         with outstanding principal. Anyone can call; freezes draws.
     * @dev Credit lines are reputation-collateralized in v1: no liquidation of
     *      collateral. Repayment remains allowed after default; the default flag
     *      is a permanent on-chain reputation record.
     */
    function markDefaulted(address borrower) external nonReentrant {
        CreditLine storage line = creditLines[borrower];
        if (line.borrower != borrower || line.used == 0) {
            revert NoOutstandingDebt();
        }
        if (block.number <= line.deadlineBlock) {
            revert DeadlineNotPassed();
        }
        if (line.defaulted) {
            revert AlreadyDefaulted();
        }

        // Freeze interest accrual at the default block.
        _accrueInterest(borrower);
        line.defaulted = true;

        emit MarkedDefaulted(borrower);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Full credit line for `borrower` (zero-initialized if none).
    function getCreditLine(address borrower) external view returns (CreditLine memory) {
        return creditLines[borrower];
    }

    /// @notice Credit score derived from the borrower's most recent attested amount.
    function creditScoreOf(address borrower) external view returns (uint256) {
        return CreditScore.scoreOf(lastActivityAmount[borrower]);
    }

    /// @notice Amount the borrower can still draw right now.
    function available(address borrower) external view returns (uint256) {
        CreditLine storage line = creditLines[borrower];
        if (line.borrower != borrower || line.defaulted || block.number > line.deadlineBlock) {
            return 0;
        }
        return line.creditLimit - line.used;
    }

    /// @notice Total interest accrued for `borrower` up to the current block
    ///         (frozen at the default block if the line is defaulted).
    function accruedInterestOf(address borrower) external view returns (uint256) {
        CreditLine storage line = creditLines[borrower];
        if (line.borrower != borrower || line.used == 0) {
            return 0;
        }
        if (line.defaulted) {
            // Interest stopped accruing at the default block.
            return _interest[borrower].accruedInterest;
        }
        InterestState storage istate = _interest[borrower];
        uint256 elapsed = block.number - istate.lastAccrualBlock;
        uint256 interest = _computeInterest(line.used, line.interestRateBps, elapsed);
        return istate.accruedInterest + interest;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev keccak256(chainKey, blockHeight, txIndex) — the replay-protection key.
    ///      Uses the same packed layout as the official ASCMinter example.
    function _computeTxKey(uint64 chainKey, uint64 blockHeight, uint64 txIndex)
        internal
        pure
        returns (bytes32 txKey)
    {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainKey)
            mstore(add(ptr, 32), shl(192, blockHeight))
            mstore(add(ptr, 40), txIndex)
            txKey := keccak256(ptr, 72)
        }
    }

    /// @dev Linear per-block interest: principal * rateBps * elapsed / (10000 * BLOCKS_PER_YEAR).
    function _computeInterest(uint256 principal, uint256 rateBps, uint256 elapsed)
        internal
        pure
        returns (uint256)
    {
        return (principal * rateBps * elapsed) / (BPS_DENOMINATOR * BLOCKS_PER_YEAR);
    }

    /// @dev Accrue interest for `borrower` up to the current block.
    function _accrueInterest(address borrower) internal {
        CreditLine storage line = creditLines[borrower];
        if (line.used == 0 || line.defaulted) {
            return;
        }
        InterestState storage istate = _interest[borrower];
        uint256 elapsed = block.number - istate.lastAccrualBlock;
        if (elapsed == 0) {
            return;
        }
        istate.accruedInterest += _computeInterest(line.used, line.interestRateBps, elapsed);
        istate.lastAccrualBlock = block.number;
    }

    /// @dev Ensure `line` is drawable: exists, not defaulted, not past deadline.
    function _requireActiveLine(CreditLine storage line) internal view {
        if (line.borrower != msg.sender || line.creditLimit == 0) {
            revert NoCreditLine();
        }
        if (line.defaulted) {
            revert LineDefaulted();
        }
        if (block.number > line.deadlineBlock) {
            revert LineExpired();
        }
    }
}
