// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title Vault
 * @notice Custodial contract for users' Polymarket ERC1155 shares.
 *
 * Users deposit YES/NO shares here as collateral for their Sonder loans.
 * When a loan is repaid the shares are returned. When liquidated, the
 * LendingPool calls seizeCollateral() to take ownership for settlement.
 *
 * IMPORTANT: Only the LendingPool (set by owner) can call seizeCollateral().
 */
contract Vault is ERC1155Holder, Ownable {
    /// @dev Address of the LendingPool — set by owner after deploy
    address public lendingPool;

    /// @dev user => marketId => amount of shares deposited
    mapping(address => mapping(uint256 => uint256)) public userCollateral;

    /// @dev marketId => collateral token address (ERC1155)
    mapping(uint256 => address) public collateralTokens;

    /// @dev marketId => ERC1155 tokenId
    mapping(uint256 => uint256) public tokenIds;

    event Deposited(
        address indexed user,
        uint256 indexed marketId,
        uint256 amount
    );
    event Withdrawn(
        address indexed user,
        uint256 indexed marketId,
        uint256 amount
    );
    event CollateralSeized(
        address indexed user,
        uint256 indexed marketId,
        uint256 amount
    );
    event LendingPoolSet(address lendingPool);
    event MarketTokenConfigured(
        uint256 indexed marketId,
        address token,
        uint256 tokenId
    );

    error OnlyLendingPool();
    error InsufficientCollateral(
        address user,
        uint256 marketId,
        uint256 available,
        uint256 requested
    );
    error MarketTokenNotConfigured(uint256 marketId);
    error InvalidAddress();
    error ZeroAmount();

    modifier onlyLendingPool() {
        if (msg.sender != lendingPool) revert OnlyLendingPool();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Admin functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Set the LendingPool address. Called once after deployment.
     */
    function setLendingPool(address _lendingPool) external onlyOwner {
        if (_lendingPool == address(0)) revert InvalidAddress();
        lendingPool = _lendingPool;
        emit LendingPoolSet(_lendingPool);
    }

    /**
     * @notice Register the ERC1155 token and tokenId for a market.
     * @dev Must be called before users can deposit for a market.
     */
    function configureMarketToken(
        uint256 marketId,
        address token,
        uint256 tokenId
    ) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        collateralTokens[marketId] = token;
        tokenIds[marketId] = tokenId;
        emit MarketTokenConfigured(marketId, token, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit Polymarket ERC1155 shares as collateral.
     * @dev User must have called ERC1155.setApprovalForAll(vault, true) first.
     */
    function deposit(uint256 marketId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        address token = collateralTokens[marketId];
        if (token == address(0)) revert MarketTokenNotConfigured(marketId);

        IERC1155(token).safeTransferFrom(
            msg.sender,
            address(this),
            tokenIds[marketId],
            amount,
            ""
        );

        userCollateral[msg.sender][marketId] += amount;
        emit Deposited(msg.sender, marketId, amount);
    }

    /**
     * @notice Withdraw shares (only if LendingPool confirms no active loan).
     * @dev LendingPool must call allowWithdrawal() first, or user has no loan.
     *      For simplicity in V1, LendingPool calls this directly.
     */
    function withdraw(
        address user,
        uint256 marketId,
        uint256 amount
    ) external onlyLendingPool {
        _checkAndReduceCollateral(user, marketId, amount);
        IERC1155(collateralTokens[marketId]).safeTransferFrom(
            address(this),
            user,
            tokenIds[marketId],
            amount,
            ""
        );
        emit Withdrawn(user, marketId, amount);
    }

    /**
     * @notice Seize collateral during liquidation.
     * @dev Called by LendingPool. Transfers shares to lendingPool for settlement.
     */
    function seizeCollateral(
        address user,
        uint256 marketId,
        uint256 amount
    ) external onlyLendingPool {
        _checkAndReduceCollateral(user, marketId, amount);
        IERC1155(collateralTokens[marketId]).safeTransferFrom(
            address(this),
            lendingPool,
            tokenIds[marketId],
            amount,
            ""
        );
        emit CollateralSeized(user, marketId, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────────────

    function getCollateral(
        address user,
        uint256 marketId
    ) external view returns (uint256) {
        return userCollateral[user][marketId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _checkAndReduceCollateral(
        address user,
        uint256 marketId,
        uint256 amount
    ) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 available = userCollateral[user][marketId];
        if (available < amount) {
            revert InsufficientCollateral(user, marketId, available, amount);
        }
        userCollateral[user][marketId] = available - amount;
    }
}
