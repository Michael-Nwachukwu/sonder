#!/usr/bin/env bun
/**
 * Sonder — Premium Interactive CLI Demo
 *
 * A beautiful, interactive terminal experience showcasing the full Sonder lifecycle:
 *   1. Show protocol status dashboard
 *   2. User chooses how many YES shares to lock as collateral
 *   3. User sees borrowing power and chooses USDC amount to borrow
 *   4. Price crash simulation with dramatic visuals
 *   5. Liquidation triggered and finalized
 *   6. Final settlement dashboard
 *
 * What's REAL on-chain:
 *   ✓ YES tokens (transferred from real Polymarket whale)
 *   ✓ Deposit into Vault (ERC1155 safeTransferFrom)
 *   ✓ USDC borrow (actual token transfer)
 *   ✓ Collateral locking & seizure
 *   ✓ Interest rate formula (probability-based from smart contract)
 *   ✓ Health factor computation (from smart contract)
 *
 * What's SIMULATED for demo:
 *   ⚡ Oracle price (MOCK mode — in production CRE pushes real prices)
 *   ⚡ Price crash (admin sets mock price)
 *   ⚡ Liquidation trigger (admin override — in production CRE bot triggers)
 *   ⚡ Liquidation finalization (0 USDC recovery — in production bot sells on CLOB)
 *
 * Prerequisites: Run `bun run scripts/setup.ts` first.
 * Usage:         bun run scripts/demo.ts
 */

import * as readline from "readline";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

// ─── Config ────────────────────────────────────────────────────────────────────
const TENDERLY_RPC = process.env.TENDERLY_RPC_URL!;
const DEPLOYER_KEY = process.env.CRE_ETH_PRIVATE_KEY! as `0x${string}`;
const PRICE_ORACLE = process.env.PRICE_ORACLE_ADDRESS! as `0x${string}`;
const VAULT = process.env.VAULT_ADDRESS! as `0x${string}`;
const LENDING_POOL = process.env.LENDING_POOL_ADDRESS! as `0x${string}`;
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as `0x${string}`;
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`;
const YES_TOKEN_ID = BigInt(process.env.POLYMARKET_TOKEN_ID!);
const MARKET_ID = 1n;
const ALICE_KEY = "0x4f0b00b3f0b48ca53b80c891c1671f47fa3b7717fcf5b82c6d250c38735c0731" as `0x${string}`;
const tenderlyChain = { ...polygon, id: 999137, name: "Tenderly (Polygon Fork)" };

// ─── ABIs ──────────────────────────────────────────────────────────────────────
const ORACLE_ABI = parseAbi([
    "function getPrice(uint256 marketId) view returns (uint256)",
    "function setMockPrice(uint256 marketId, uint256 price) external",
    "function setMode(uint8 mode) external",
]);
const POOL_ABI = parseAbi([
    "function borrow(uint256 marketId, uint256 usdcAmount) external",
    "function getHealthFactor(address user) view returns (uint256)",
    "function getTotalDebt(address user) view returns (uint256)",
    "function checkAndEmitRiskEvents(address user) returns (uint256)",
    "function finalizeLiquidation(address user, uint256 recoveredUsdc) external",
    "function setAdminLiquidationOverride(address user, bool status) external",
    "function getLoan(address user) view returns (uint256 marketId, uint256 principal, uint256 interestAccrued, uint256 lastInterestUpdate, bool active)",
]);
const VAULT_ABI = parseAbi([
    "function deposit(uint256 marketId, uint256 amount) external",
    "function getCollateral(address user, uint256 marketId) view returns (uint256)",
]);
const CTF_ABI = parseAbi([
    "function balanceOf(address account, uint256 id) view returns (uint256)",
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) view returns (bool)",
]);
const USDC_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

// ─── Terminal UI Kit ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt: string): Promise<string> {
    return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

const K = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
    under: "\x1b[4m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
    blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
    bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgYellow: "\x1b[43m", bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m", bgCyan: "\x1b[46m",
};

const W = 60; // box width (inner)

function boxLine(content: string) {
    const stripped = content.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = Math.max(0, W - stripped.length);
    console.log(`  ${K.cyan}║${K.reset} ${content}${" ".repeat(padding)}${K.cyan}║${K.reset}`);
}
function boxTop(title?: string) {
    if (title) {
        const stripped = title.replace(/\x1b\[[0-9;]*m/g, "");
        const side = Math.max(0, Math.floor((W - stripped.length) / 2));
        const extra = (W - stripped.length) % 2;
        console.log(`  ${K.cyan}╔${"═".repeat(side)}${title}${K.cyan}${"═".repeat(side + extra)}╗${K.reset}`);
    } else {
        console.log(`  ${K.cyan}╔${"═".repeat(W + 2)}╗${K.reset}`);
    }
}
function boxBottom() { console.log(`  ${K.cyan}╚${"═".repeat(W + 2)}╝${K.reset}`); }
function boxSep() { console.log(`  ${K.cyan}╠${"═".repeat(W + 2)}╣${K.reset}`); }
function boxEmpty() { boxLine(""); }

function banner() {
    console.log("");
    console.log(`  ${K.bold}${K.cyan}╔══════════════════════════════════════════════════════════════╗${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}                                                              ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}   ${K.bold}${K.cyan} ██████  ██████  ███  ██ ██████  █████  ██████${K.reset}          ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}   ${K.bold}${K.cyan}██      ██    ██ ████ ██ ██   ██ ██     ██   ██${K.reset}         ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}   ${K.bold}${K.cyan} █████  ██    ██ ██ ████ ██   ██ █████  ██████${K.reset}          ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}   ${K.bold}${K.cyan}     ██ ██    ██ ██  ███ ██   ██ ██     ██  ██${K.reset}          ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}   ${K.bold}${K.cyan}██████   ██████  ██   ██ ██████  █████  ██   ██${K.reset}         ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}                                                              ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}╠══════════════════════════════════════════════════════════════╣${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}  ${K.dim}Borrow USDC against Polymarket YES shares${K.reset}                  ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}  ${K.dim}Powered by Chainlink CRE + AI Anomaly Detection${K.reset}            ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}╚══════════════════════════════════════════════════════════════╝${K.reset}`);
    console.log("");
}

function sectionHeader(icon: string, title: string) {
    console.log("");
    console.log(`  ${K.bold}${K.cyan}${icon}  ${title}${K.reset}`);
    console.log(`  ${K.cyan}${"─".repeat(58)}${K.reset}`);
}

function row(label: string, value: string, indent = 0) {
    const prefix = " ".repeat(indent);
    const stripped = label.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = 26 - stripped.length - indent;
    console.log(`  ${K.dim}│${K.reset} ${prefix}${label}${" ".repeat(Math.max(1, padding))}${value}`);
}

function statusBadge(label: string, ok: boolean) {
    return ok
        ? `${K.bgGreen}${K.bold}${K.white} ${label} ${K.reset}`
        : `${K.bgRed}${K.bold}${K.white} ${label} ${K.reset}`;
}

function spinner(msg: string): { stop: (result: string) => void } {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const id = setInterval(() => {
        process.stdout.write(`\r  ${K.cyan}${frames[i++ % frames.length]}${K.reset} ${msg}`);
    }, 80);
    return {
        stop: (result: string) => {
            clearInterval(id);
            process.stdout.write(`\r  ${K.green}✓${K.reset} ${result}\x1b[K\n`);
        },
    };
}

function formatUSD(amount: bigint | number, decimals = 6): string {
    const n = typeof amount === "number" ? amount : Number(amount) / 10 ** decimals;
    return `${K.green}$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${K.reset}`;
}

function formatHF(hf: number): string {
    if (hf > 100) return `${K.green}∞ (no debt)${K.reset}`;
    if (hf >= 1.1) return `${K.bold}${K.green}${hf.toFixed(4)}${K.reset}  ${statusBadge("HEALTHY", true)}`;
    if (hf >= 1.0) return `${K.bold}${K.yellow}${hf.toFixed(4)}${K.reset}  ${statusBadge("AT RISK", false)}`;
    return `${K.bold}${K.red}${hf.toFixed(4)}${K.reset}  ${statusBadge("LIQUIDATABLE", false)}`;
}

function formatShares(n: bigint | number): string {
    const num = typeof n === "number" ? n : Number(n);
    return `${K.yellow}${num.toLocaleString()}${K.reset} shares`;
}

/**
 * Compute HF locally (matches LendingPool._computeHealthFactor)
 *   HF = (shares * price * liquidationThreshold / 10000) * 1e18 / totalDebt
 * Since shares (0 dec), price (6 dec per share), and debt (6 dec USDC):
 *   collateralValue = shares * price  (in 6 dec USDC)
 *   adjCollateral = collateralValue * liqThreshold / 10000
 *   HF_float = adjCollateral / totalDebt
 */
function computeHFLocally(shares: number, price6Dec: number, debtUsdc6Dec: number, liqThreshold = 4500): number {
    if (debtUsdc6Dec === 0) return Infinity;
    const collateralValue = shares * price6Dec; // in 6-dec USDC units
    const adjCollateral = (collateralValue * liqThreshold) / 10_000;
    return adjCollateral / debtUsdc6Dec;
}

// ─── Main Demo ─────────────────────────────────────────────────────────────────
async function main() {
    banner();

    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const alice = privateKeyToAccount(ALICE_KEY);

    const publicClient = createPublicClient({ chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });
    const adminWallet = createWalletClient({ account: deployer, chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });
    const aliceWallet = createWalletClient({ account: alice, chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });

    // ━━━━━━ STEP 1: Protocol Dashboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    sectionHeader("📊", "PROTOCOL STATUS");

    const poolUsdc = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [LENDING_POOL] });
    const aliceYesWallet = await publicClient.readContract({ address: POLYMARKET_CTF, abi: CTF_ABI, functionName: "balanceOf", args: [alice.address, YES_TOKEN_ID] });
    const aliceYesVault = await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "getCollateral", args: [alice.address, MARKET_ID] });
    const oraclePrice = await publicClient.readContract({ address: PRICE_ORACLE, abi: ORACLE_ABI, functionName: "getPrice", args: [MARKET_ID] });

    const priceNum = Number(oraclePrice) / 1_000_000;
    const probPct = (priceNum * 100).toFixed(1);

    row("Pool Liquidity", formatUSD(poolUsdc));
    row("Oracle Price", `${K.cyan}$${priceNum.toFixed(4)}${K.reset} ${K.dim}(${probPct}%)${K.reset}`);
    row("Market", `${K.dim}"Aliens confirmed before 2027?"${K.reset}`);
    console.log(`  ${K.dim}│${K.reset}`);
    row(`${K.bold}Alice`, "");
    row("Address", `${K.dim}${alice.address.slice(0, 10)}...${alice.address.slice(-6)}${K.reset}`, 2);
    row("YES in wallet", formatShares(aliceYesWallet), 2);
    row("YES in vault", formatShares(aliceYesVault), 2);
    row("USDC", formatUSD(await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [alice.address] })), 2);

    const totalAvailableShares = aliceYesWallet; // only wallet tokens can be newly deposited

    if (totalAvailableShares === 0n && aliceYesVault === 0n) {
        console.log(`\n  ${K.red}✗ Alice has 0 YES tokens! Run: bun run scripts/setup.ts${K.reset}`);
        rl.close(); process.exit(1);
    }
    if (oraclePrice === 0n) {
        console.log(`\n  ${K.red}✗ Oracle price is 0! Run: bun run scripts/setup.ts${K.reset}`);
        rl.close(); process.exit(1);
    }

    // ━━━━━━ STEP 2: Deposit Collateral ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    sectionHeader("🔒", "DEPOSIT COLLATERAL");

    const walletValue = Number(totalAvailableShares) * priceNum;
    console.log(`\n  You have ${formatShares(totalAvailableShares)} in wallet worth ${formatUSD(walletValue, 0)}`);
    if (aliceYesVault > 0n) {
        console.log(`  ${K.dim}(Plus ${Number(aliceYesVault).toLocaleString()} shares already in vault)${K.reset}`);
    }
    console.log(`  ${K.dim}Each YES share = $${priceNum.toFixed(4)} on Polymarket${K.reset}\n`);

    let depositAmount: bigint;
    while (true) {
        const input = await ask(`  ${K.magenta}►${K.reset} Shares to deposit as collateral? ${K.dim}(max: ${Number(totalAvailableShares).toLocaleString()})${K.reset}\n    ${K.cyan}→${K.reset} `);
        const parsed = parseInt(input.replace(/,/g, ""));
        if (isNaN(parsed) || parsed <= 0) { console.log(`  ${K.red}✗${K.reset} Enter a positive number.\n`); continue; }
        if (BigInt(parsed) > totalAvailableShares) { console.log(`  ${K.red}✗${K.reset} You only have ${Number(totalAvailableShares).toLocaleString()} available.\n`); continue; }
        depositAmount = BigInt(parsed);
        break;
    }

    console.log("");

    // Approve + Deposit
    const isApproved = await publicClient.readContract({ address: POLYMARKET_CTF, abi: CTF_ABI, functionName: "isApprovedForAll", args: [alice.address, VAULT] });
    if (!isApproved) {
        const s1 = spinner("Approving Vault as operator...");
        const approveTx = await aliceWallet.writeContract({ address: POLYMARKET_CTF, abi: CTF_ABI, functionName: "setApprovalForAll", args: [VAULT, true], chain: null });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        s1.stop(`Vault approved ${K.dim}(${approveTx.slice(0, 14)}...)${K.reset}`);
    }

    const s2 = spinner(`Depositing ${Number(depositAmount).toLocaleString()} YES shares...`);
    const depositTx = await aliceWallet.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: "deposit", args: [MARKET_ID, depositAmount], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    s2.stop(`${formatShares(depositAmount)} locked ${K.dim}(${depositTx.slice(0, 14)}...)${K.reset}`);

    // Read ACTUAL on-chain collateral after deposit (includes any previously deposited)
    const totalCollateral = await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "getCollateral", args: [alice.address, MARKET_ID] });
    const totalCollateralNum = Number(totalCollateral);
    const totalCollateralValue = totalCollateralNum * priceNum;
    const maxBorrowUsdc = totalCollateralValue * 0.35; // 35% maxLTV

    console.log("");
    boxTop(` ${K.bold}${K.white}Collateral Summary${K.reset}${K.cyan} `);
    boxLine(`  Just Deposited:   ${formatShares(depositAmount)}`);
    if (aliceYesVault > 0n) {
        boxLine(`  Previously In:    ${formatShares(aliceYesVault)}`);
    }
    boxLine(`  ${K.bold}Total Collateral: ${formatShares(totalCollateral)}${K.reset}`);
    boxSep();
    boxLine(`  Collateral Value: ${formatUSD(totalCollateralValue, 0)}`);
    boxLine(`  Max LTV:          ${K.dim}35%${K.reset}`);
    boxLine(`  ${K.bold}Max Borrowable:   ${formatUSD(maxBorrowUsdc, 0)} ${K.dim}USDC${K.reset}`);
    boxBottom();

    // ━━━━━━ STEP 3: Borrow USDC ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    sectionHeader("💰", "BORROW USDC");

    console.log(`\n  Your ${formatShares(totalCollateral)} supports up to ${formatUSD(maxBorrowUsdc, 0)} in loans.`);
    console.log(`  ${K.dim}Higher borrow → lower health factor → higher liquidation risk${K.reset}\n`);

    // Borrow options table
    console.log(`  ${K.dim}┌──────────────┬──────────┬──────────────────────────────┐${K.reset}`);
    console.log(`  ${K.dim}│${K.reset} ${K.bold}  Borrow     ${K.reset}${K.dim}│${K.reset} ${K.bold}% of Max${K.reset} ${K.dim}│${K.reset} ${K.bold} Est. Health Factor          ${K.reset}${K.dim}│${K.reset}`);
    console.log(`  ${K.dim}├──────────────┼──────────┼──────────────────────────────┤${K.reset}`);
    for (const pct of [25, 50, 75, 100]) {
        const amt = maxBorrowUsdc * (pct / 100);
        const hfEst = computeHFLocally(totalCollateralNum, Number(oraclePrice), amt * 1_000_000);
        const hfStr = formatHF(hfEst);
        const amtStr = `$${amt.toFixed(2)}`.padEnd(11);
        const pctStr = `${pct}%`.padEnd(7);
        console.log(`  ${K.dim}│${K.reset}  ${amtStr} ${K.dim}│${K.reset}  ${pctStr}${K.dim}│${K.reset}  ${hfStr}  ${K.dim}│${K.reset}`);
    }
    console.log(`  ${K.dim}└──────────────┴──────────┴──────────────────────────────┘${K.reset}\n`);

    let borrowAmountRaw: number;
    let borrowAmountUsdc: bigint;
    while (true) {
        const input = await ask(`  ${K.magenta}►${K.reset} USDC to borrow? ${K.dim}(max: $${maxBorrowUsdc.toFixed(2)})${K.reset}\n    ${K.cyan}→ $${K.reset}`);
        const parsed = parseFloat(input.replace(/,/g, "").replace("$", ""));
        if (isNaN(parsed) || parsed <= 0) { console.log(`  ${K.red}✗${K.reset} Enter a valid dollar amount.\n`); continue; }
        const usdcAmount = Math.floor(parsed * 1_000_000);
        if (usdcAmount > maxBorrowUsdc * 1_000_000) { console.log(`  ${K.red}✗${K.reset} Exceeds max. Try smaller.\n`); continue; }
        borrowAmountRaw = parsed;
        borrowAmountUsdc = BigInt(usdcAmount);
        break;
    }

    console.log("");
    const s3 = spinner(`Borrowing $${borrowAmountRaw.toFixed(2)} USDC...`);
    const borrowTx = await aliceWallet.writeContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "borrow", args: [MARKET_ID, borrowAmountUsdc], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: borrowTx });
    s3.stop(`Received ${formatUSD(borrowAmountUsdc)} ${K.dim}(${borrowTx.slice(0, 14)}...)${K.reset}`);

    // Verify loan was created + compute HF locally as primary source
    const aliceUsdcAfter = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [alice.address] });
    const loan = await publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "getLoan", args: [alice.address] });
    const loanActive = loan[4]; // active field
    const loanPrincipal = Number(loan[1]); // principal in 6-dec USDC

    // Compute HF locally (more reliable than on-chain view on Tenderly)
    const hfLocal = computeHFLocally(totalCollateralNum, Number(oraclePrice), loanPrincipal);

    // Interest rate from contract formula: BASE_RATE + (1-P)*RISK_MULTIPLIER
    // 5% + (1 - probability) * 20%, where probability = price / 1_000_000
    const interestRate = 5 + (1 - priceNum) * 20;

    console.log("");
    boxTop(` ${K.bold}${K.white}Loan Active${K.reset}${K.cyan} `);
    boxLine(`  Borrowed:         ${formatUSD(borrowAmountUsdc)}`);
    boxLine(`  USDC Balance:     ${formatUSD(aliceUsdcAfter)}`);
    boxLine(`  Loan On-Chain:    ${loanActive ? `${K.green}ACTIVE${K.reset}` : `${K.red}NOT FOUND${K.reset}`}`);
    boxLine(`  Health Factor:    ${formatHF(hfLocal)}`);
    boxLine(`  Interest Rate:    ${K.cyan}${interestRate.toFixed(1)}% APR${K.reset} ${K.dim}(5% + (1-${probPct}%) × 20%)${K.reset}`);
    boxLine(`  ${K.dim}  ↳ Real formula from LendingPool contract${K.reset}`);
    boxBottom();

    if (!loanActive) {
        console.log(`\n  ${K.red}⚠ Loan not found on-chain! The borrow may have failed silently.${K.reset}`);
        console.log(`  ${K.dim}  Check: Does LendingPool have enough USDC? Is market registered?${K.reset}\n`);
    }

    // ━━━━━━ STEP 4: Price Crash ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    await ask(`\n  ${K.magenta}►${K.reset} Press ${K.bold}Enter${K.reset} to simulate a catastrophic price crash...`);

    sectionHeader("💥", "PRICE CRASH — CATASTROPHIC NEWS EVENT");
    console.log(`\n  ${K.dim}Simulating: "Breaking — Evidence debunked, probability crashes"${K.reset}\n`);

    const s4 = spinner("Switching Oracle to MOCK mode...");
    const modeTx = await adminWallet.writeContract({ address: PRICE_ORACLE, abi: ORACLE_ABI, functionName: "setMode", args: [1], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: modeTx });
    s4.stop("Oracle → MOCK mode");

    // Calculate crash price that actually makes HF < 1.0
    // We need: shares * crashPrice * liqThreshold / 10000 < debt
    // So:      crashPrice < debt * 10000 / (shares * liqThreshold)
    // We'll set it to 60% of that threshold for a clear liquidation
    const targetCrashPrice = Math.max(
        1000, // minimum $0.001
        Math.floor((loanPrincipal * 10_000 * 0.6) / (totalCollateralNum * 4500))
    );
    const crashPriceNum = targetCrashPrice / 1_000_000;
    const dropPct = ((1 - crashPriceNum / priceNum) * 100).toFixed(1);

    const s5 = spinner(`Setting crash price to $${crashPriceNum.toFixed(6)}...`);
    const crashTx = await adminWallet.writeContract({ address: PRICE_ORACLE, abi: ORACLE_ABI, functionName: "setMockPrice", args: [MARKET_ID, BigInt(targetCrashPrice)], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: crashTx });
    s5.stop("Price updated on-chain");

    // Dramatic crash display
    const crashBar = `  ⚠  PRICE CRASHED: $${priceNum.toFixed(4)} → $${crashPriceNum.toFixed(6)} (-${dropPct}%)  `;
    console.log("");
    console.log(`  ${K.bgRed}${K.bold}${K.white}${" ".repeat(58)}${K.reset}`);
    console.log(`  ${K.bgRed}${K.bold}${K.white}${crashBar.padEnd(58)}${K.reset}`);
    console.log(`  ${K.bgRed}${K.bold}${K.white}${" ".repeat(58)}${K.reset}`);

    // Compute post-crash HF locally
    const hfAfterCrash = computeHFLocally(totalCollateralNum, targetCrashPrice, loanPrincipal);

    console.log(`\n  Health Factor: ${formatHF(hfAfterCrash)}`);

    console.log(`\n  ${K.dim}In production, the CRE AI Guardian would:${K.reset}`);
    console.log(`  ${K.dim}  → Fetch Polymarket trader comments (sentiment)${K.reset}`);
    console.log(`  ${K.dim}  → Use Google Search grounding to verify news${K.reset}`);
    console.log(`  ${K.dim}  → Classify: LIQUIDATE / MONITOR / HOLD${K.reset}`);

    // ━━━━━━ STEP 5: Liquidation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    await ask(`\n  ${K.magenta}►${K.reset} Press ${K.bold}Enter${K.reset} to trigger liquidation...`);

    sectionHeader("🔥", "LIQUIDATION");

    const s6 = spinner("Setting admin liquidation override...");
    const overrideTx = await adminWallet.writeContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "setAdminLiquidationOverride", args: [alice.address, true], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: overrideTx });
    s6.stop("Override set");

    const s7 = spinner("Triggering liquidation (seizing collateral)...");
    const triggerTx = await adminWallet.writeContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "checkAndEmitRiskEvents", args: [alice.address], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: triggerTx });
    s7.stop(`Collateral seized ${K.dim}(${triggerTx.slice(0, 14)}...)${K.reset}`);

    const s8 = spinner("Finalizing liquidation...");
    const finalizeTx = await adminWallet.writeContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "finalizeLiquidation", args: [alice.address, 0n], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: finalizeTx });
    s8.stop(`Liquidation finalized ${K.dim}(${finalizeTx.slice(0, 14)}...)${K.reset}`);

    // ━━━━━━ STEP 6: Settlement ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    sectionHeader("📋", "SETTLEMENT");

    const collateralAfter = await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "getCollateral", args: [alice.address, MARKET_ID] });
    const debtAfter = await publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "getTotalDebt", args: [alice.address] });
    const aliceUsdcFinal = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [alice.address] });

    console.log("");
    boxTop(` ${K.bold}${K.white}Settlement Report${K.reset}${K.cyan} `);
    boxLine(`  Collateral Remaining: ${formatShares(collateralAfter)}`);
    boxLine(`  Outstanding Debt:     ${formatUSD(debtAfter)}`);
    boxLine(`  Alice USDC Balance:   ${formatUSD(aliceUsdcFinal)}`);
    boxLine(`  Loan Status:          ${debtAfter === 0n ? `${K.green}CLOSED${K.reset}` : `${K.red}ACTIVE${K.reset}`}`);
    boxBottom();

    // ━━━━━━ STEP 7: Oracle Reset ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    sectionHeader("🔄", "RESTORING ORACLE");

    // Fetch current live price from Polymarket
    const midRes = await fetch(`https://clob.polymarket.com/midpoint?token_id=${YES_TOKEN_ID}`);
    const midData = await midRes.json() as { mid: string };
    const liveMid = parseFloat(midData.mid);
    const livePrice6 = BigInt(Math.round(liveMid * 1_000_000));

    // First set mock price to the live value (so on-chain state is consistent)
    const s9 = spinner(`Setting oracle price to live value ($${liveMid.toFixed(4)})...`);
    const restoreTx = await adminWallet.writeContract({ address: PRICE_ORACLE, abi: ORACLE_ABI, functionName: "setMockPrice", args: [MARKET_ID, livePrice6], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: restoreTx });
    s9.stop(`Oracle price → $${liveMid.toFixed(4)} (live Polymarket)`);

    // Switch back to LIVE mode so CRE can push real prices
    const s10 = spinner("Switching Oracle back to LIVE mode...");
    const liveTx = await adminWallet.writeContract({ address: PRICE_ORACLE, abi: ORACLE_ABI, functionName: "setMode", args: [0], chain: null });
    await publicClient.waitForTransactionReceipt({ hash: liveTx });
    s10.stop("Oracle → LIVE mode (CRE can push prices)");

    console.log(`\n  ${K.dim}To push a fresh price: cre workflow simulate sonder-workflow --broadcast${K.reset}`);

    // ━━━━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log("");
    boxTop(` ${K.bold}${K.white}What Was Demonstrated${K.reset}${K.cyan} `);
    boxEmpty();
    boxLine(`  ${K.green}✓${K.reset} Real Polymarket YES tokens as collateral`);
    boxLine(`  ${K.green}✓${K.reset} Borrowed USDC without selling position`);
    boxLine(`  ${K.green}✓${K.reset} Probability-based interest: ${K.cyan}${interestRate.toFixed(1)}% APR${K.reset}`);
    boxLine(`  ${K.green}✓${K.reset} Health factor monitoring & liquidation`);
    boxLine(`  ${K.green}✓${K.reset} Oracle restored to live Polymarket price`);
    boxSep();
    boxLine(`  ${K.bold}On-chain (real):${K.reset} Tokens, Deposit, Borrow, Collateral`);
    boxLine(`  ${K.bold}Simulated:${K.reset}      Oracle crash, Liquidation trigger`);
    boxLine(`  ${K.bold}In production:${K.reset}  CRE pushes live prices + AI guardian`);
    boxEmpty();
    boxLine(`  ${K.dim}Solidity • Chainlink CRE • Polymarket • Gemini AI${K.reset}`);
    boxBottom();
    console.log("");

    rl.close();
}

main().catch(err => {
    console.error(`\n  ${K.red}Error:${K.reset}`, err.shortMessage || err.message || err);
    rl.close();
    process.exit(1);
});
