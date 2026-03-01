#!/usr/bin/env bun
/**
 * Sonder — Tenderly Fork Setup Script
 *
 * Automates the entire fork preparation:
 *   1. Fund the deployer wallet with ETH
 *   2. Fund Alice (a fresh EOA) with ETH
 *   3. Fund the LendingPool with USDC
 *   4. Impersonate a Polymarket whale to transfer real YES tokens to Alice
 *   5. Set the Oracle price to the live Polymarket price
 *
 * This script uses Tenderly-specific RPC methods:
 *   - tenderly_addBalance: Give native ETH to any address
 *   - tenderly_setErc20Balance: Give ERC20 tokens to any address
 *   - cast send --unlocked: Impersonate any address (sends tx without private key)
 *
 * Usage: bun run scripts/setup.ts
 * Prereqs: .env with TENDERLY_RPC_URL set, foundry (cast) in PATH
 */

import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { execSync } from "child_process";

// ─── Config ────────────────────────────────────────────────────────────────
const TENDERLY_RPC = process.env.TENDERLY_RPC_URL!;
const DEPLOYER = "0x7FBbE68068A3Aa7E479A1E51e792F4C2073b018f";

// Alice — a fresh EOA generated specifically for the demo
const ALICE = "0x6C9cbb059F5Dbf3f265256a55bbCA0184Dc60564";

// Polymarket CTF contract (Gnosis Conditional Tokens Framework)
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const YES_TOKEN_ID = "107505882767731489358349912513945399560393482969656700824895970500493757150417";

// Whale with ~894 billion YES tokens (a Polymarket proxy wallet)
const WHALE = "0xaf23273e03a924a257edd6beae7133cf9d32377f";

// Contract addresses (must match deployed contracts)
const LENDING_POOL = process.env.LENDING_POOL_ADDRESS!;
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const TRANSFER_AMOUNT = 100_000; // YES shares for Alice

const tenderlyChain = { ...polygon, id: 999137, name: "Tenderly Fork" };

// ─── Helpers ──────────────────────────────────────────────────────────────
const C = { green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m" };

function step(n: number, msg: string) { console.log(`\n${C.bold}${C.cyan}[Step ${n}]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function run(cmd: string): string { return execSync(cmd, { encoding: "utf-8" }).trim(); }

async function tenderlyRpc(method: string, params: any[]) {
    const res = await fetch(TENDERLY_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
    console.log(`${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Sonder — Tenderly Fork Setup${C.reset}`);
    console.log(`${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}`);

    const publicClient = createPublicClient({ chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });

    // ── Step 1: Fund deployer + Alice with ETH ──────────────────────────
    step(1, "Funding wallets with ETH");
    await tenderlyRpc("tenderly_addBalance", [[DEPLOYER, ALICE, WHALE], "0x56BC75E2D63100000"]); // 100 ETH each
    ok(`Deployer (${DEPLOYER}) — 100 ETH`);
    ok(`Alice (${ALICE}) — 100 ETH`);
    ok(`Whale (${WHALE}) — 100 ETH (for gas)`);

    // ── Step 2: Fund LendingPool with USDC ──────────────────────────────
    step(2, "Funding LendingPool with USDC");
    await tenderlyRpc("tenderly_setErc20Balance", [USDC, LENDING_POOL, "0x2386F26FC10000"]); // 10M USDC (6 dec)
    const poolUsdc = await publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [LENDING_POOL as `0x${string}`],
    });
    ok(`LendingPool USDC: $${Number(poolUsdc) / 1_000_000}`);

    // ── Step 3: Impersonate whale → approve Alice → transfer YES tokens ─
    step(3, "Transferring real YES tokens from Polymarket whale to Alice");

    // Check if Alice is already approved
    const isApproved = await publicClient.readContract({
        address: CTF as `0x${string}`,
        abi: parseAbi(["function isApprovedForAll(address,address) view returns (bool)"]),
        functionName: "isApprovedForAll",
        args: [WHALE as `0x${string}`, ALICE as `0x${string}`],
    });

    if (!isApproved) {
        console.log(`  ${C.dim}Impersonating whale to approve Alice as operator...${C.reset}`);
        run(`cast send --unlocked --from ${WHALE} ${CTF} "setApprovalForAll(address,bool)" ${ALICE} true --rpc-url ${TENDERLY_RPC}`);
        ok("Alice approved as operator on whale's CTF tokens");
    } else {
        ok("Alice already approved as operator");
    }

    console.log(`  ${C.dim}Alice pulling ${TRANSFER_AMOUNT} YES tokens from whale...${C.reset}`);
    run(`cast send --unlocked --from ${ALICE} ${CTF} "safeTransferFrom(address,address,uint256,uint256,bytes)" ${WHALE} ${ALICE} ${YES_TOKEN_ID} ${TRANSFER_AMOUNT} "0x" --rpc-url ${TENDERLY_RPC}`);

    const aliceBalance = await publicClient.readContract({
        address: CTF as `0x${string}`,
        abi: parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [ALICE as `0x${string}`, BigInt(YES_TOKEN_ID)],
    });
    ok(`Alice YES token balance: ${aliceBalance} shares`);

    // ── Step 4: Set oracle price from live Polymarket data ───────────────
    step(4, "Seeding Oracle with live Polymarket price");

    const PRICE_ORACLE = process.env.PRICE_ORACLE_ADDRESS!;
    const POLYMARKET_TOKEN_ID = process.env.POLYMARKET_TOKEN_ID!;
    const DEPLOYER_KEY = process.env.CRE_ETH_PRIVATE_KEY!;

    // Fetch live midpoint from Polymarket CLOB
    const midpointRes = await fetch(`https://clob.polymarket.com/midpoint?token_id=${POLYMARKET_TOKEN_ID}`);
    const midpointData = await midpointRes.json() as { mid: string };
    const midpoint = parseFloat(midpointData.mid);
    const priceInOracleUnits = Math.round(midpoint * 1_000_000); // 6 decimals
    ok(`Live Polymarket midpoint: $${midpoint.toFixed(4)} (${priceInOracleUnits} in oracle units)`);

    // Always ensure REAL mode (demo may have left it in MOCK)
    const currentMode = await publicClient.readContract({
        address: PRICE_ORACLE as `0x${string}`,
        abi: parseAbi(["function mode() view returns (uint8)"]),
        functionName: "mode",
    });
    if (currentMode !== 0) {
        console.log(`  ${C.dim}Oracle was in MOCK mode — switching to REAL...${C.reset}`);
        run(`cast send --from ${DEPLOYER} --private-key ${DEPLOYER_KEY} ${PRICE_ORACLE} "setMode(uint8)" 0 --rpc-url ${TENDERLY_RPC}`);
        ok("Oracle switched to REAL mode");
    }

    // Push live price via updatePrice (writes to realPrices storage)
    const currentPrice = await publicClient.readContract({
        address: PRICE_ORACLE as `0x${string}`,
        abi: parseAbi(["function getPrice(uint256) view returns (uint256)"]),
        functionName: "getPrice",
        args: [1n],
    });

    if (currentPrice === 0n || Math.abs(Number(currentPrice) - priceInOracleUnits) > 10000) {
        console.log(`  ${C.dim}Pushing fresh price via updatePrice...${C.reset}`);
        run(`cast send --from ${DEPLOYER} --private-key ${DEPLOYER_KEY} ${PRICE_ORACLE} "updatePrice(uint256,uint256)" 1 ${priceInOracleUnits} --rpc-url ${TENDERLY_RPC}`);
        ok(`Oracle price set to $${midpoint.toFixed(4)} (REAL mode, via updatePrice)`);
    } else {
        ok(`Oracle price current: $${(Number(currentPrice) / 1_000_000).toFixed(4)} (REAL mode)`);
    }

    // ── Step 5: Verify Vault market token is configured ──────────────────
    step(5, "Verifying Vault configuration");

    const VAULT_ADDRESS = process.env.VAULT_ADDRESS!;
    try {
        const configuredToken = await publicClient.readContract({
            address: VAULT_ADDRESS as `0x${string}`,
            abi: parseAbi(["function collateralTokens(uint256) view returns (address)"]),
            functionName: "collateralTokens",
            args: [1n],
        });

        if (configuredToken === "0x0000000000000000000000000000000000000000") {
            console.log(`  ${C.dim}Vault market 1 not configured — configuring now...${C.reset}`);
            run(`cast send --from ${DEPLOYER} --private-key ${DEPLOYER_KEY} ${VAULT_ADDRESS} "configureMarketToken(uint256,address,uint256)" 1 ${CTF} ${YES_TOKEN_ID} --rpc-url ${TENDERLY_RPC}`);
            ok("Vault: Market 1 → CTF token configured");
        } else {
            ok(`Vault market 1 configured: ${configuredToken.slice(0, 10)}...`);
        }
    } catch {
        ok(`Vault at ${VAULT_ADDRESS.slice(0, 10)}... (Deploy.s.sol already configured it)`);
    }

    // ── Done ────────────────────────────────────────────────────────────
    console.log(`\n${C.bold}${C.green}Setup complete!${C.reset} Run the demo with:`);
    console.log(`  ${C.dim}bun run scripts/demo.ts${C.reset}\n`);
}

main().catch(console.error);
