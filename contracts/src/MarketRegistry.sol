// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MarketRegistry
 * @notice Stores configuration for each Polymarket market supported as collateral.
 *
 * V1: Single market. Designed to be extensible to multiple markets without a rewrite.
 *
 * RESOLUTION TIME GUARD:
 * - No NEW borrows within 72 hours of market resolution (prevents near-expiry collateral)
 * - 24-hour forced repayment period before resolution
 */
contract MarketRegistry is Ownable {
    struct MarketConfig {
        /// @dev Polymarket CTF (ERC1155) contract address on Polygon
        address collateralToken;
        /// @dev ERC1155 token ID of the YES share for this market
        uint256 tokenId;
        /// @dev Max LTV in basis points. 3500 = 35%
        uint256 maxLTV;
        /// @dev Health factor threshold for liquidation trigger. 4500 = 45%
        uint256 liquidationThreshold;
        /// @dev Bonus paid to liquidator (from seized collateral). 800 = 8%
        uint256 liquidationBonus;
        /// @dev Unix timestamp when the market resolves
        uint256 resolutionTime;
        /// @dev Whether this market actively accepts new deposits/borrows
        bool active;
    }

    /// @dev marketId => config. IDs start at 1.
    mapping(uint256 => MarketConfig) private markets;
    uint256 public marketCount;

    /// @dev How many seconds before resolution to stop new borrows
    uint256 public constant BORROW_CUTOFF = 72 hours;

    event MarketAdded(
        uint256 indexed marketId,
        address collateralToken,
        uint256 tokenId
    );
    event MarketDeactivated(uint256 indexed marketId);
    event MarketResolutionTimeUpdated(
        uint256 indexed marketId,
        uint256 newResolutionTime
    );

    error MarketNotFound(uint256 marketId);
    error MarketNotActive(uint256 marketId);
    error TooCloseToResolution(uint256 marketId, uint256 resolutionTime);
    error InvalidMarketConfig();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Admin functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a new market that can be used as collateral.
     */
    function addMarket(
        address collateralToken,
        uint256 tokenId,
        uint256 maxLTV,
        uint256 liquidationThreshold,
        uint256 liquidationBonus,
        uint256 resolutionTime
    ) external onlyOwner returns (uint256 marketId) {
        if (collateralToken == address(0)) revert InvalidMarketConfig();
        if (liquidationThreshold <= maxLTV) revert InvalidMarketConfig();
        if (resolutionTime <= block.timestamp) revert InvalidMarketConfig();

        marketId = ++marketCount;
        markets[marketId] = MarketConfig({
            collateralToken: collateralToken,
            tokenId: tokenId,
            maxLTV: maxLTV,
            liquidationThreshold: liquidationThreshold,
            liquidationBonus: liquidationBonus,
            resolutionTime: resolutionTime,
            active: true
        });

        emit MarketAdded(marketId, collateralToken, tokenId);
    }

    /**
     * @notice Deactivate a market (stops new borrows; existing loans continue).
     */
    function deactivateMarket(uint256 marketId) external onlyOwner {
        _requireMarketExists(marketId);
        markets[marketId].active = false;
        emit MarketDeactivated(marketId);
    }

    /**
     * @notice Update resolution time (e.g., if Polymarket extends the market).
     */
    function updateResolutionTime(
        uint256 marketId,
        uint256 newResolutionTime
    ) external onlyOwner {
        _requireMarketExists(marketId);
        markets[marketId].resolutionTime = newResolutionTime;
        emit MarketResolutionTimeUpdated(marketId, newResolutionTime);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reader functions
    // ─────────────────────────────────────────────────────────────────────────

    function getMarket(
        uint256 marketId
    ) external view returns (MarketConfig memory) {
        _requireMarketExists(marketId);
        return markets[marketId];
    }

    /**
     * @notice Check if a borrow is allowed right now for a market.
     * @dev Reverts with a descriptive error if not allowed.
     */
    function requireBorrowAllowed(uint256 marketId) external view {
        _requireMarketExists(marketId);
        MarketConfig storage cfg = markets[marketId];

        if (!cfg.active) revert MarketNotActive(marketId);
        if (block.timestamp + BORROW_CUTOFF >= cfg.resolutionTime) {
            revert TooCloseToResolution(marketId, cfg.resolutionTime);
        }
    }

    function isMarketActive(uint256 marketId) external view returns (bool) {
        return markets[marketId].active;
    }

    function getResolutionTime(
        uint256 marketId
    ) external view returns (uint256) {
        return markets[marketId].resolutionTime;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _requireMarketExists(uint256 marketId) internal view {
        if (marketId == 0 || marketId > marketCount)
            revert MarketNotFound(marketId);
    }
}
