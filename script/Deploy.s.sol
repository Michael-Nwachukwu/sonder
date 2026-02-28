// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PriceOracle.sol";
import "../src/MarketRegistry.sol";
import "../src/Vault.sol";
import "../src/LendingPool.sol";

/**
 * @title Deploy
 * @notice Deploys the full PolyLend protocol.
 *
 * Usage:
 *   forge script script/Deploy.s.sol --rpc-url $POLYGON_RPC_URL --broadcast --private-key $CRE_ETH_PRIVATE_KEY
 *
 * For Tenderly Virtual TestNet:
 *   forge script script/Deploy.s.sol --rpc-url $TENDERLY_RPC_URL --broadcast --private-key $CRE_ETH_PRIVATE_KEY
 *
 * After deployment, copy contract addresses to .env and config.staging.json.
 */
contract Deploy is Script {
    // ─── Polygon addresses ────────────────────────────────────────────────────
    // Real USDC on Polygon mainnet (6 decimals)
    address constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    // Polymarket Conditional Token Framework (CTF) ERC1155 contract on Polygon
    address constant POLYMARKET_CTF =
        0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;

    // ─── V1 Market Config ─────────────────────────────────────────────────────
    // Token ID of the YES share for your chosen Polymarket market
    // Fill this in before deploying!
    uint256 constant YES_TOKEN_ID = 107505882767731489358349912513945399560393482969656700824895970500493757150417;


    // Resolution timestamp of your chosen market (unix epoch)
    // Must be > 72 hours from now. Fill in before deploying!
    uint256 constant RESOLUTION_TIME = 1798675200;



    function run() external {
        uint256 deployerPrivateKey = vm.envUint("CRE_ETH_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        // 1. Deploy PriceOracle
        PriceOracle oracle = new PriceOracle(deployer);
        console.log("PriceOracle deployed at:", address(oracle));

        // 2. Deploy MarketRegistry
        MarketRegistry registry = new MarketRegistry(deployer);
        console.log("MarketRegistry deployed at:", address(registry));

        // 3. Deploy Vault
        Vault vault = new Vault(deployer);
        console.log("Vault deployed at:", address(vault));

        // 4. Deploy LendingPool
        LendingPool pool = new LendingPool(
            deployer,
            address(oracle),
            address(registry),
            address(vault),
            POLYGON_USDC
        );
        console.log("LendingPool deployed at:", address(pool));

        // 5. Wire up
        vault.setLendingPool(address(pool));
        console.log("Vault wired to LendingPool");

        // 6. Register market (only if YES_TOKEN_ID and RESOLUTION_TIME are set)
        if (YES_TOKEN_ID > 0 && RESOLUTION_TIME > block.timestamp + 72 hours) {
            uint256 marketId = registry.addMarket(
                POLYMARKET_CTF,
                YES_TOKEN_ID,
                3500, // 35% maxLTV
                4500, // 45% liquidation threshold
                800, // 8% liquidation bonus
                RESOLUTION_TIME
            );
            vault.configureMarketToken(marketId, POLYMARKET_CTF, YES_TOKEN_ID);
            console.log("Market registered. ID:", marketId);
        } else {
            console.log(
                "Skipping market registration -- set YES_TOKEN_ID and RESOLUTION_TIME first"
            );
        }

        vm.stopBroadcast();

        console.log("\n=== PolyLend Deployment Complete ===");
        console.log("Copy these to your .env and config.staging.json:");
        console.log("PRICE_ORACLE_ADDRESS=", address(oracle));
        console.log("MARKET_REGISTRY_ADDRESS=", address(registry));
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("LENDING_POOL_ADDRESS=", address(pool));
    }
}
