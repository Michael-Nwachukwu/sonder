// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import "./PriceOracle.sol";
import "./MarketRegistry.sol";
import "./Vault.sol";

/**
 * @title LendingPool
 * @notice Core lending engine for Sonder.
 *
 * FLOW:
 * 1. User deposits Polymarket YES/NO shares into Vault
 * 2. User calls borrow() — receives USDC up to maxLTV of collateral value
 * 3. CRE monitors health factor every N minutes
 * 4. If HF drops below 1.1: emit AtRisk (email warning sent off-chain)
 * 5. If HF drops below 1.0: emit LiquidationTriggered (bot sells CLOB, calls finalizeLiquidation)
 * 6. User can repay anytime to withdraw collateral
 *
 * INTEREST RATE MODEL (probability-based, not utilization-based):
 *   Rate = BASE_RATE + (1 - probability) * RISK_MULTIPLIER
 *   Where probability = YES share price (0-1).
 *   E.g. P=0.65 → Rate = 5% + (0.35 * 20%) = 12%
 *   Rationale: lower probability = riskier collateral = higher borrowing cost.
 *
 * HEALTH FACTOR:
 *   HF = (collateralShares * sharePrice * liquidationThreshold) / totalDebt
 *   HF >= 1.0 = healthy. < 1.0 = liquidatable.
 *   Represented in 18 decimals (1e18 = 1.0).
 *
 * COLLATERAL VALUE:
 *   collateralValue = shares * sharePrice (6 dec) / 1e6
 *   Shares are whole units (0 decimal). Price is in 6 dec (0-1_000_000).
 */
contract LendingPool is Ownable, ReentrancyGuard, ERC1155Holder {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant PRECISION = 1e18;
    uint256 public constant PRICE_PRECISION = 1e6; // PriceOracle uses 6 decimals

    /// @dev 5% annual base rate (in 18 dec)
    uint256 public constant BASE_RATE = 5e16;
    /// @dev 20% risk multiplier applied proportionally to (1 - probability)
    uint256 public constant RISK_MULTIPLIER = 20e16;
    /// @dev Interest accrues per second (computes annually)
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @dev HF thresholds in 18 dec (1.1e18, 1.0e18)
    uint256 public constant WARNING_HF = 1_100_000_000_000_000_000; // 1.1
    uint256 public constant LIQUIDATION_HF = 1_000_000_000_000_000_000; // 1.0

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    struct Loan {
        uint256 marketId;
        uint256 principal; // USDC borrowed (6 dec, matching USDC decimals)
        uint256 interestAccrued; // accrued but unpaid interest (6 dec)
        uint256 lastInterestUpdate; // timestamp of last interest accrual
        bool active;
    }

    /// @dev user => Loan (V1: one loan per user)
    mapping(address => Loan) public loans;

    /// @dev Track if a liquidation is in progress to prevent double-finalization
    mapping(address => bool) public liquidationPending;

    PriceOracle public immutable oracle;
    MarketRegistry public immutable registry;
    Vault public immutable vault;
    IERC20 public immutable usdc;

    /// @dev address authorised to call finalizeLiquidation (liquidation bot / admin)
    address public liquidationBot;
    /// @dev admin override: force-allow a liquidation (demo safety net)
    mapping(address => bool) public adminLiquidationOverride;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event LoanCreated(
        address indexed user,
        uint256 indexed marketId,
        uint256 amount,
        uint256 interestRate
    );
    event LoanRepaid(address indexed user, uint256 principal, uint256 interest);
    event AtRisk(address indexed user, uint256 healthFactor, uint256 marketId);
    event LiquidationTriggered(
        address indexed user,
        uint256 indexed marketId,
        uint256 sharesSeized
    );
    event LiquidationFinalized(
        address indexed user,
        uint256 recoveredUsdc,
        uint256 debtCleared
    );
    event LiquidationBotSet(address bot);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ActiveLoanExists();
    error NoActiveLoan();
    error InsufficientCollateral();
    error ExceedsMaxLTV(uint256 requested, uint256 maxAllowed);
    error PriceNotAvailable(uint256 marketId);
    error LiquidationNotTriggered(uint256 healthFactor);
    error LiquidationAlreadyPending();
    error OnlyLiquidationBot();
    error TransferFailed();
    error ZeroAmount();

    constructor(
        address initialOwner,
        address _oracle,
        address _registry,
        address _vault,
        address _usdc
    ) Ownable(initialOwner) {
        oracle = PriceOracle(_oracle);
        registry = MarketRegistry(_registry);
        vault = Vault(_vault);
        usdc = IERC20(_usdc);
        liquidationBot = initialOwner;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setLiquidationBot(address bot) external onlyOwner {
        liquidationBot = bot;
        emit LiquidationBotSet(bot);
    }

    /// @dev Fund the pool with USDC so it can lend. Called by owner/admin via Tenderly.
    function depositLiquidity(uint256 amount) external onlyOwner {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Emergency: admin can force-mark a user for liquidation (demo safety net)
    function setAdminLiquidationOverride(
        address user,
        bool status
    ) external onlyOwner {
        adminLiquidationOverride[user] = status;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core user functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Borrow USDC against your deposited Polymarket collateral.
     * @param marketId     The Sonder market ID.
     * @param borrowAmount USDC to borrow (in USDC's 6 decimals).
     */
    function borrow(
        uint256 marketId,
        uint256 borrowAmount
    ) external nonReentrant {
        if (borrowAmount == 0) revert ZeroAmount();
        if (loans[msg.sender].active) revert ActiveLoanExists();

        // Checks: market must be active and not near resolution
        registry.requireBorrowAllowed(marketId);

        uint256 price = oracle.getPrice(marketId);
        if (price == 0) revert PriceNotAvailable(marketId);

        uint256 sharesDeposited = vault.getCollateral(msg.sender, marketId);
        if (sharesDeposited == 0) revert InsufficientCollateral();

        MarketRegistry.MarketConfig memory cfg = registry.getMarket(marketId);

        // collateralValue in USDC (6 dec): shares * price
        // shares are whole units (0 dec), price is 0-1_000_000 (6 dec) per share
        // So shares * price already gives USDC in 6-decimal units.
        // E.g. 100 shares * 650_000 = 65_000_000 = $65 USDC (6 dec)
        uint256 collateralValue = sharesDeposited * price;
        uint256 maxBorrow = (collateralValue * cfg.maxLTV) / 10_000;

        if (borrowAmount > maxBorrow)
            revert ExceedsMaxLTV(borrowAmount, maxBorrow);

        uint256 rate = _computeInterestRate(price);

        loans[msg.sender] = Loan({
            marketId: marketId,
            principal: borrowAmount,
            interestAccrued: 0,
            lastInterestUpdate: block.timestamp,
            active: true
        });

        usdc.safeTransfer(msg.sender, borrowAmount);

        emit LoanCreated(msg.sender, marketId, borrowAmount, rate);
    }

    /**
     * @notice Repay your loan in full and get collateral back.
     * @dev User must approve LendingPool to spend USDC first.
     */
    function repay() external nonReentrant {
        Loan storage loan = loans[msg.sender];
        if (!loan.active) revert NoActiveLoan();

        _accrueInterest(msg.sender);

        uint256 totalOwed = loan.principal + loan.interestAccrued;
        uint256 marketId = loan.marketId;
        uint256 shares = vault.getCollateral(msg.sender, marketId);

        usdc.safeTransferFrom(msg.sender, address(this), totalOwed);

        loan.active = false;
        loan.principal = 0;
        loan.interestAccrued = 0;

        // Return all collateral to the user
        vault.withdraw(msg.sender, marketId, shares);

        emit LoanRepaid(msg.sender, loan.principal, loan.interestAccrued);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Health factor & risk events (called by CRE bot or anyone)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Check a user's health factor and emit risk events if thresholds breached.
     * @dev Called by the CRE workflow every N minutes. Public — anyone can call.
     * @return hf Health factor in 18 decimals. < 1e18 = liquidatable.
     */
    function checkAndEmitRiskEvents(
        address user
    ) external returns (uint256 hf) {
        Loan storage loan = loans[user];
        if (!loan.active) return type(uint256).max; // no loan = infinitely healthy

        _accrueInterest(user);
        hf = _computeHealthFactor(user);

        if (hf < WARNING_HF && hf >= LIQUIDATION_HF) {
            emit AtRisk(user, hf, loan.marketId);
        } else if (
            (hf < LIQUIDATION_HF || adminLiquidationOverride[user]) &&
            !liquidationPending[user]
        ) {
            liquidationPending[user] = true;
            uint256 shares = vault.getCollateral(user, loan.marketId);
            vault.seizeCollateral(user, loan.marketId, shares);
            emit LiquidationTriggered(user, loan.marketId, shares);
        }
    }

    /**
     * @notice Called by liquidation bot after shares are sold on Polymarket CLOB.
     * @param user          The borrower being liquidated.
     * @param recoveredUsdc USDC recovered from selling the shares.
     */
    function finalizeLiquidation(
        address user,
        uint256 recoveredUsdc
    ) external nonReentrant {
        if (msg.sender != liquidationBot && msg.sender != owner())
            revert OnlyLiquidationBot();
        if (!liquidationPending[user]) revert LiquidationNotTriggered(0);

        Loan storage loan = loans[user];
        uint256 debt = loan.principal + loan.interestAccrued;

        usdc.safeTransferFrom(msg.sender, address(this), recoveredUsdc);

        loan.active = false;
        loan.principal = 0;
        loan.interestAccrued = 0;
        liquidationPending[user] = false;

        emit LiquidationFinalized(user, recoveredUsdc, debt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Current health factor for a user (with accrued interest).
     * @return 18-decimal fixed point. 1.5e18 = 1.5 (healthy). <1e18 = liquidatable.
     */
    function getHealthFactor(address user) external view returns (uint256) {
        return _computeHealthFactor(user);
    }

    /**
     * @notice Total debt (principal + accrued interest through now).
     */
    function getTotalDebt(address user) external view returns (uint256) {
        Loan memory loan = loans[user];
        if (!loan.active) return 0;
        uint256 pendingInterest = _computePendingInterest(user);
        return loan.principal + loan.interestAccrued + pendingInterest;
    }

    /**
     * @notice The current annual interest rate for a user's loan (in 18 dec).
     */
    function getInterestRate(address user) external view returns (uint256) {
        Loan memory loan = loans[user];
        if (!loan.active) return 0;
        uint256 price = oracle.getPrice(loan.marketId);
        return _computeInterestRate(price);
    }

    function getLoan(address user) external view returns (Loan memory) {
        return loans[user];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Probability-based interest rate.
     * Rate = BASE_RATE + (1 - P) * RISK_MULTIPLIER
     * Where P = price / PRICE_PRECISION (i.e., 0-1 probability).
     *
     * Example:
     *   price = 650_000 (P = 0.65) → Rate = 5% + 0.35 * 20% = 12%
     *   price = 100_000 (P = 0.10) → Rate = 5% + 0.90 * 20% = 23%
     */
    function _computeInterestRate(
        uint256 price
    ) internal pure returns (uint256) {
        // Probability in 18 dec
        uint256 probability = (price * PRECISION) / PRICE_PRECISION;
        // (1 - P) in 18 dec
        uint256 oneMinusP = PRECISION - probability;
        // Rate = BASE_RATE + (oneMinusP / PRECISION) * RISK_MULTIPLIER
        return BASE_RATE + (oneMinusP * RISK_MULTIPLIER) / PRECISION;
    }

    function _accrueInterest(address user) internal {
        Loan storage loan = loans[user];
        uint256 pending = _computePendingInterest(user);
        loan.interestAccrued += pending;
        loan.lastInterestUpdate = block.timestamp;
    }

    function _computePendingInterest(
        address user
    ) internal view returns (uint256) {
        Loan memory loan = loans[user];
        if (!loan.active) return 0;

        uint256 price = oracle.getPrice(loan.marketId);
        uint256 rate = _computeInterestRate(price);

        uint256 elapsed = block.timestamp - loan.lastInterestUpdate;

        // interest = principal * rate * elapsed / SECONDS_PER_YEAR / PRECISION
        return
            (loan.principal * rate * elapsed) / (SECONDS_PER_YEAR * PRECISION);
    }

    /**
     * @dev HF = (collateralShares * sharePrice * liquidationThreshold) / (1e4 * totalDebt)
     * Returns 18-decimal fixed point. 1e18 = perfectly at threshold.
     */
    function _computeHealthFactor(
        address user
    ) internal view returns (uint256) {
        Loan memory loan = loans[user];
        if (!loan.active) return type(uint256).max;

        uint256 price = oracle.getPrice(loan.marketId);
        uint256 shares = vault.getCollateral(user, loan.marketId);

        // collateralValue in USDC (6 dec): shares * price
        // shares (0 dec) * price (6 dec per share) = USDC in 6 dec
        uint256 collateralValue = shares * price;

        MarketRegistry.MarketConfig memory cfg = registry.getMarket(
            loan.marketId
        );
        // liquidation collateral value: multiply by threshold / 10000
        uint256 adjCollateral = (collateralValue * cfg.liquidationThreshold) /
            10_000;

        uint256 totalDebt = loan.principal +
            loan.interestAccrued +
            _computePendingInterest(user);
        if (totalDebt == 0) return type(uint256).max;

        // Return 18-decimal HF
        return (adjCollateral * PRECISION) / totalDebt;
    }
}
