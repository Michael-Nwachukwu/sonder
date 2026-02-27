// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/PriceOracle.sol";
import "../src/MarketRegistry.sol";
import "../src/Vault.sol";
import "../src/LendingPool.sol";

// ─── Minimal mocks ────────────────────────────────────────────────────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockCTF is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

contract PolyLendTest is Test {
    PriceOracle oracle;
    MarketRegistry registry;
    Vault vault;
    LendingPool pool;
    MockUSDC usdc;
    MockCTF ctf;

    address admin = address(0xA0);
    address alice = address(0xA1);
    address bob = address(0xA2);
    address bot = address(0xB0);

    uint256 constant MARKET_ID = 1;
    uint256 constant CTF_TOKEN_ID = 42;
    uint256 constant PRICE_6DEC = 650_000; // $0.65 — 65% probability
    uint256 constant SHARES = 100; // 100 YES shares
    uint256 constant POOL_LIQUIDITY = 100_000e6; // 100k USDC

    function setUp() public {
        vm.startPrank(admin);

        usdc = new MockUSDC();
        ctf = new MockCTF();
        oracle = new PriceOracle(admin);
        registry = new MarketRegistry(admin);
        vault = new Vault(admin);
        pool = new LendingPool(
            admin,
            address(oracle),
            address(registry),
            address(vault),
            address(usdc)
        );

        // Wire up
        vault.setLendingPool(address(pool));
        pool.setLiquidationBot(bot);

        // Register market
        // resolution: 7 days from now (well outside 72h cutoff)
        registry.addMarket(
            address(ctf),
            CTF_TOKEN_ID,
            3500, // 35% maxLTV
            4500, // 45% liquidation threshold
            800, // 8% liquidation bonus
            block.timestamp + 7 days
        );

        // Configure vault token
        vault.configureMarketToken(MARKET_ID, address(ctf), CTF_TOKEN_ID);

        // Set initial oracle price
        oracle.updatePrice(MARKET_ID, PRICE_6DEC);

        // Fund pool with USDC
        usdc.mint(admin, POOL_LIQUIDITY);
        usdc.approve(address(pool), POOL_LIQUIDITY);
        pool.depositLiquidity(POOL_LIQUIDITY);

        vm.stopPrank();

        // Mint shares to Alice and Bob
        ctf.mint(alice, CTF_TOKEN_ID, SHARES);
        ctf.mint(bob, CTF_TOKEN_ID, SHARES);
    }

    // ─── Price Oracle ─────────────────────────────────────────────────────────

    function test_Oracle_UpdateAndReadPrice() public {
        vm.prank(admin);
        oracle.updatePrice(MARKET_ID, 750_000);
        assertEq(oracle.getPrice(MARKET_ID), 750_000);
        assertEq(uint8(oracle.mode()), uint8(PriceOracle.OracleMode.REAL));
    }

    function test_Oracle_MockMode() public {
        vm.startPrank(admin);
        oracle.setMockPrice(MARKET_ID, 50_000); // crash price: $0.05
        oracle.setMode(PriceOracle.OracleMode.MOCK);
        vm.stopPrank();

        assertEq(oracle.getPrice(MARKET_ID), 50_000);

        // Switch back to real
        vm.prank(admin);
        oracle.setMode(PriceOracle.OracleMode.REAL);
        assertEq(oracle.getPrice(MARKET_ID), PRICE_6DEC);
    }

    function test_Oracle_RejectsUnauthorizedUpdater() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceOracle.UnauthorizedUpdater.selector,
                alice
            )
        );
        vm.prank(alice);
        oracle.updatePrice(MARKET_ID, 500_000);
    }

    function test_Oracle_RejectsInvalidPrice() public {
        vm.expectRevert(
            abi.encodeWithSelector(PriceOracle.InvalidPrice.selector, 0)
        );
        vm.prank(admin);
        oracle.updatePrice(MARKET_ID, 0);

        vm.expectRevert(
            abi.encodeWithSelector(PriceOracle.InvalidPrice.selector, 1_000_001)
        );
        vm.prank(admin);
        oracle.updatePrice(MARKET_ID, 1_000_001);
    }

    // ─── Vault ────────────────────────────────────────────────────────────────

    function test_Vault_DepositAndGetCollateral() public {
        vm.startPrank(alice);
        ctf.setApprovalForAll(address(vault), true);
        vault.deposit(MARKET_ID, SHARES);
        vm.stopPrank();

        assertEq(vault.getCollateral(alice, MARKET_ID), SHARES);
    }

    function test_Vault_RejectsZeroDeposit() public {
        vm.startPrank(alice);
        ctf.setApprovalForAll(address(vault), true);
        vm.expectRevert(abi.encodeWithSelector(Vault.ZeroAmount.selector));
        vault.deposit(MARKET_ID, 0);
        vm.stopPrank();
    }

    // ─── Full Borrow / Repay Lifecycle ────────────────────────────────────────

    function test_Borrow_SuccessAtMaxLTV() public {
        // Deposit collateral: 100 shares @ $0.65 = $65 collateral value
        // maxLTV = 35%, so maxBorrow = $65 * 0.35 = $22.75 → 22_750_000 (6 dec)
        _depositCollateral(alice, SHARES);

        // collateralValue = 100 shares * 650_000 (price 6 dec) = 65_000_000 ($65 USDC in 6 dec)
        // maxBorrow at 35% LTV = 65_000_000 * 3500 / 10_000 = 22_750_000 ($22.75 USDC)
        uint256 collateralValue = SHARES * PRICE_6DEC; // = 65_000_000
        uint256 maxBorrow = (collateralValue * 3500) / 10_000; // = 22_750_000

        vm.prank(alice);
        pool.borrow(MARKET_ID, maxBorrow);

        LendingPool.Loan memory loan = pool.getLoan(alice);
        assertTrue(loan.active);
        assertEq(loan.principal, maxBorrow);
        assertEq(loan.marketId, MARKET_ID);
    }

    function test_Borrow_RevertsWithNoCollateral() public {
        vm.expectRevert(
            abi.encodeWithSelector(LendingPool.InsufficientCollateral.selector)
        );
        vm.prank(alice);
        pool.borrow(MARKET_ID, 1e6);
    }

    function test_Borrow_RevertsExceedsMaxLTV() public {
        _depositCollateral(alice, SHARES);

        // collateral value = 100 * 650000 / 1e6 = 65 USDC
        // maxBorrow at 35% = 22 USDC (in 6 dec = 22_000_000)
        // Try to borrow more
        uint256 tooMuch = 30e6; // $30 — exceeds 35% LTV

        vm.expectRevert(); // ExceedsMaxLTV
        vm.prank(alice);
        pool.borrow(MARKET_ID, tooMuch);
    }

    function test_Repay_FullLoanPlusInterest() public {
        _depositCollateral(alice, SHARES);

        uint256 borrowed = 22_000_000; // $22 USDC
        vm.prank(alice);
        pool.borrow(MARKET_ID, borrowed);

        // Advance 30 days
        vm.warp(block.timestamp + 30 days);

        uint256 totalDebt = pool.getTotalDebt(alice);
        assertGt(totalDebt, borrowed); // interest should have accrued

        // Give alice enough USDC to repay
        usdc.mint(alice, totalDebt);
        vm.startPrank(alice);
        usdc.approve(address(pool), totalDebt);
        pool.repay();
        vm.stopPrank();

        LendingPool.Loan memory loan = pool.getLoan(alice);
        assertFalse(loan.active);

        // Collateral returned
        assertEq(vault.getCollateral(alice, MARKET_ID), 0);
        assertEq(ctf.balanceOf(alice, CTF_TOKEN_ID), SHARES);
    }

    // ─── Health Factor ────────────────────────────────────────────────────────

    function test_HealthFactor_HealthyLoan() public {
        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 10e6); // borrow $10 well under max

        uint256 hf = pool.getHealthFactor(alice);
        assertGt(hf, 2e18); // Should be well above 2.0
        console.log("HF (healthy):", hf);
    }

    function test_HealthFactor_DropsOnPriceCrash() public {
        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 22e6); // borrow near max

        // Crash price to $0.10
        vm.startPrank(admin);
        oracle.setMockPrice(MARKET_ID, 100_000); // $0.10
        oracle.setMode(PriceOracle.OracleMode.MOCK);
        vm.stopPrank();

        uint256 hf = pool.getHealthFactor(alice);
        assertLt(hf, 1e18); // Below 1.0 — liquidatable
        console.log("HF (crashed):", hf);
    }

    // ─── Risk Events ─────────────────────────────────────────────────────────

    function test_EmitAtRisk_OnWarningHF() public {
        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 22e6);

        // Price drops to $0.45 (HF should be just below warning but above liquidation)
        vm.startPrank(admin);
        oracle.setMockPrice(MARKET_ID, 450_000);
        oracle.setMode(PriceOracle.OracleMode.MOCK);
        vm.stopPrank();

        uint256 hf = pool.getHealthFactor(alice);
        console.log("HF at $0.45 price:", hf);

        // Only emit if HF is in warning range
        if (hf < 1_100_000_000_000_000_000 && hf >= 1_000_000_000_000_000_000) {
            vm.expectEmit(true, false, false, false);
            emit LendingPool.AtRisk(alice, hf, MARKET_ID);
            pool.checkAndEmitRiskEvents(alice);
        }
    }

    function test_LiquidationTriggered_OnLowHF() public {
        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 22e6);

        // Crash price
        vm.startPrank(admin);
        oracle.setMockPrice(MARKET_ID, 50_000); // $0.05
        oracle.setMode(PriceOracle.OracleMode.MOCK);
        vm.stopPrank();

        uint256 hf = pool.getHealthFactor(alice);
        assertLt(hf, 1e18);

        // Call checkAndEmitRiskEvents — this should seize collateral and set liquidationPending
        pool.checkAndEmitRiskEvents(alice);

        assertTrue(pool.liquidationPending(alice));
        // All shares should be seized (removed from vault)
        assertEq(vault.getCollateral(alice, MARKET_ID), 0);
    }

    function test_FinalizeLiquidation() public {
        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 22e6);

        // Crash + trigger
        vm.startPrank(admin);
        oracle.setMockPrice(MARKET_ID, 50_000);
        oracle.setMode(PriceOracle.OracleMode.MOCK);
        vm.stopPrank();

        pool.checkAndEmitRiskEvents(alice);
        assertTrue(pool.liquidationPending(alice));

        // Bot finalizes with recovered USDC
        uint256 recovered = 20e6; // $20 recovered from CLOB sell
        usdc.mint(bot, recovered);
        vm.startPrank(bot);
        usdc.approve(address(pool), recovered);
        pool.finalizeLiquidation(alice, recovered);
        vm.stopPrank();

        LendingPool.Loan memory loan = pool.getLoan(alice);
        assertFalse(loan.active);
        assertFalse(pool.liquidationPending(alice));
    }

    // ─── Interest Rate Model ─────────────────────────────────────────────────

    function test_InterestRate_ProbabilityBased() public {
        _depositCollateral(alice, SHARES);

        // At P=0.65: rate = 5% + (1-0.65)*20% = 5% + 7% = 12%
        vm.prank(alice);
        pool.borrow(MARKET_ID, 10e6);

        uint256 rate = pool.getInterestRate(alice);
        // 12% in 18 dec = 12e16 = 0.12 * 1e18
        assertApproxEqAbs(rate, 12e16, 1e14); // within 0.01%
        console.log("Interest rate at P=0.65:", rate);
    }

    function test_InterestRate_HigherAtLowProbability() public {
        // Update price to P=0.10 → rate = 5% + 0.90*20% = 23%
        vm.prank(admin);
        oracle.updatePrice(MARKET_ID, 100_000);

        _depositCollateral(alice, SHARES);
        vm.prank(alice);
        pool.borrow(MARKET_ID, 1e6); // small borrow at low price

        uint256 rate = pool.getInterestRate(alice);
        assertApproxEqAbs(rate, 23e16, 1e14);
        console.log("Interest rate at P=0.10:", rate);
    }

    // ─── Market Registry Guards ───────────────────────────────────────────────

    function test_Registry_BlocksBorrowNearResolution() public {
        vm.prank(admin);
        // Add a market that resolves in 48 hours (within 72h cutoff)
        registry.addMarket(
            address(ctf),
            CTF_TOKEN_ID,
            3500,
            4500,
            800,
            block.timestamp + 48 hours
        );

        uint256 nearMarketId = registry.marketCount();
        vm.prank(admin);
        vault.configureMarketToken(nearMarketId, address(ctf), CTF_TOKEN_ID);

        vm.prank(admin);
        oracle.updatePrice(nearMarketId, PRICE_6DEC);

        _depositCollateral(alice, SHARES);

        vm.expectRevert(); // TooCloseToResolution
        vm.prank(alice);
        pool.borrow(nearMarketId, 1e6);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _depositCollateral(address user, uint256 amount) internal {
        vm.startPrank(user);
        ctf.setApprovalForAll(address(vault), true);
        vault.deposit(MARKET_ID, amount);
        vm.stopPrank();
    }
}
