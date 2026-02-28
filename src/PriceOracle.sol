// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PriceOracle
 * @notice Bridges off-chain Polymarket share prices to on-chain.
 *
 * WHAT IS "PRICE"?
 * On Polymarket, each market has YES/NO shares priced 0.00–1.00 USDC.
 * A YES share price of $0.65 means the market believes 65% probability.
 * This IS the probability. The CRE workflow fetches this from the Polymarket
 * CLOB API and writes it here so LendingPool can value collateral.
 *
 * MODES:
 * - REAL: prices are updated by the CRE workflow every N minutes
 * - MOCK: admin sets any price manually (used for crash simulation demos)
 */
contract PriceOracle is Ownable {
    enum OracleMode { REAL, MOCK }

    OracleMode public mode;

    /// @dev marketId => price (6 decimals, e.g. 650000 = $0.65 = 65% probability)
    mapping(uint256 => uint256) private realPrices;
    mapping(uint256 => uint256) private mockPrices;

    /// @dev track when each price was last updated
    mapping(uint256 => uint256) public lastUpdated;

    /// @dev address authorised to call updatePrice() (set to CRE bot wallet / deployer)
    address public updater;

    event PriceUpdated(uint256 indexed marketId, uint256 price, OracleMode mode);
    event OracleModeChanged(OracleMode newMode);
    event UpdaterChanged(address newUpdater);

    error UnauthorizedUpdater(address caller);
    error StalePrice(uint256 marketId, uint256 lastUpdated);
    error InvalidPrice(uint256 price);

    constructor(address initialOwner) Ownable(initialOwner) {
        mode = OracleMode.REAL;
        updater = initialOwner;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Writer functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Update live price — called by CRE workflow via its funded wallet.
     * @param marketId The Sonder market ID.
     * @param price    In 6 decimals. E.g., 650000 = $0.65 (65% win probability).
     */
    function updatePrice(uint256 marketId, uint256 price) external {
        if (msg.sender != updater && msg.sender != owner()) {
            revert UnauthorizedUpdater(msg.sender);
        }
        if (price == 0 || price > 1_000_000) revert InvalidPrice(price);

        realPrices[marketId] = price;
        lastUpdated[marketId] = block.timestamp;

        emit PriceUpdated(marketId, price, OracleMode.REAL);
    }

    /**
     * @notice Admin sets a mock price for crash simulation demos.
     * @param price 0–1_000_000 (6 decimals). E.g. 50000 = $0.05 (crashed).
     */
    function setMockPrice(uint256 marketId, uint256 price) external onlyOwner {
        if (price > 1_000_000) revert InvalidPrice(price);
        mockPrices[marketId] = price;
        emit PriceUpdated(marketId, price, OracleMode.MOCK);
    }

    /**
     * @notice Switch between REAL and MOCK mode.
     * @dev Toggle to MOCK for crash simulation, back to REAL for live.
     */
    function setMode(OracleMode newMode) external onlyOwner {
        mode = newMode;
        emit OracleModeChanged(newMode);
    }

    /**
     * @notice Update the authorised updater address (set to your CRE bot wallet).
     */
    function setUpdater(address newUpdater) external onlyOwner {
        updater = newUpdater;
        emit UpdaterChanged(newUpdater);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reader functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Get the current price for a market.
     * @return price in 6 decimals (0–1_000_000). Returns the MODE-appropriate value.
     */
    function getPrice(uint256 marketId) external view returns (uint256) {
        if (mode == OracleMode.MOCK) {
            return mockPrices[marketId];
        }
        return realPrices[marketId];
    }

    /**
     * @notice Check if the real price is stale (older than maxAge seconds).
     */
    function isPriceStale(uint256 marketId, uint256 maxAge) external view returns (bool) {
        return block.timestamp - lastUpdated[marketId] > maxAge;
    }

    /**
     * @notice Returns both real and mock prices for a market (for debugging).
     */
    function getPrices(uint256 marketId) external view returns (uint256 real, uint256 mock) {
        return (realPrices[marketId], mockPrices[marketId]);
    }
}
