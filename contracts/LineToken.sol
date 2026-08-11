// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title LineToken
 * @notice ERC20 that AttestLine lends to borrowers ("AttestLine Credit Token", ALCT).
 * @dev Minting and burning are restricted to the `minter` (the AttestLine ASC).
 *      The token has no intrinsic value and no transfer restrictions — it is a
 *      plain protocol credit token, fully collateralized by the protocol's
 *      underwriting (reputation) model in v1.
 */
contract LineToken is ERC20 {
    /// @notice The only account allowed to mint/burn (set at construction).
    address public immutable minter;

    error OnlyMinter(address caller);

    modifier onlyMinter() {
        if (msg.sender != minter) {
            revert OnlyMinter(msg.sender);
        }
        _;
    }

    constructor(address minter_) ERC20("AttestLine Credit Token", "ALCT") {
        require(minter_ != address(0), "LineToken: minter cannot be the zero address");
        minter = minter_;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }
}
