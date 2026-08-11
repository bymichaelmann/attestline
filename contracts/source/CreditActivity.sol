// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title CreditActivity
 * @notice Source-chain activity ledger for AttestLine (deployed on the source
 *         chain, e.g. Ethereum Sepolia, chainKey 1 on Creditcoin).
 * @dev Per Attestcoin Protocol best practices this is intentionally minimal:
 *      a single source contract, one unambiguous event that carries ALL data
 *      needed by the ASC (account + amount), and no hidden state transitions.
 *
 *      The event name is unique to this dApp (`CreditActivityRecorded`) so that
 *      AttestLine can filter for it unambiguously after verifying inclusion.
 */
contract CreditActivity {
    /// @notice Emitted whenever an account records on-chain activity.
    /// @param account The account that recorded the activity (msg.sender).
    /// @param amount The amount of value/activity committed, in wei.
    event CreditActivityRecorded(address indexed account, uint256 amount);

    /// @notice Cumulative activity recorded per account.
    mapping(address => uint256) private _activity;

    /**
     * @notice Record `amount` of on-chain activity for msg.sender.
     * @param amount Amount of value committed (wei). Must be greater than zero.
     */
    function recordActivity(uint256 amount) external {
        require(amount > 0, "CreditActivity: amount must be greater than zero");
        _activity[msg.sender] += amount;
        emit CreditActivityRecorded(msg.sender, amount);
    }

    /// @notice Cumulative activity recorded by `account`.
    function activityOf(address account) external view returns (uint256) {
        return _activity[account];
    }
}
