#!/usr/bin/env bun
/**
 * Sonder — Portfolio Dashboard
 *
 * Shows a comprehensive view of any wallet's holdings:
 *   Wallet:   POL balance, USDC balance, YES share balance
 *   Protocol: Shares deposited in Vault, outstanding debt,
 *             health factor, loan details, interest accrued
 *
 * Usage:
 *   bun run scripts/portfolio.ts                         # shows Alice + Deployer
 *   ADDRESS=0xYourAddr bun run scripts/portfolio.ts      # specific wallet
 */

import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

// ─── Config ────────────────────────────────────────────────────────────────────
const TENDERLY_RPC = process.env.TENDERLY_RPC_URL!;
const PRICE_ORACLE = process.env.PRICE_ORACLE_ADDRESS! as `0x${string}`;
const VAULT = process.env.VAULT_ADDRESS! as `0x${string}`;
const LENDING_POOL = process.env.LENDING_POOL_ADDRESS! as `0x${string}`;
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`;
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as `0x${string}`;
const YES_TOKEN_ID = BigInt(process.env.POLYMARKET_TOKEN_ID!);
const MARKET_ID = 1n;
const ALICE_KEY = "0x4f0b00b3f0b48ca53b80c891c1671f47fa3b7717fcf5b82c6d250c38735c0731" as `0x${string}`;

const tenderlyChain = { ...polygon, id: 999137, name: "Tenderly (Polygon Fork)" };

// ─── ABIs ──────────────────────────────────────────────────────────────────────
const ORACLE_ABI = parseAbi(["function getPrice(uint256 marketId) view returns (uint256)"]);
const POOL_ABI = parseAbi([
    "function getLoan(address user) view returns (uint256 marketId, uint256 principal, uint256 interestAccrued, uint256 lastInterestUpdate, bool active)",
    "function getHealthFactor(address user) view returns (uint256)",
    "function getTotalDebt(address user) view returns (uint256)",
    "function liquidationPending(address user) view returns (bool)",
]);
const VAULT_ABI = parseAbi(["function getCollateral(address user, uint256 marketId) view returns (uint256)"]);
const CTF_ABI = parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)"]);
const USDC_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
// POL balance via publicClient.getBalance() — no ABI needed

// ─── Terminal UI ───────────────────────────────────────────────────────────────
const K = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
    cyan: "\x1b[36m", white: "\x1b[37m", magenta: "\x1b[35m",
    bgGreen: "\x1b[42m", bgRed: "\x1b[41m", bgYellow: "\x1b[43m",
};

const W = 58; // inner box width

function boxTop(title: string) {
    const stripped = title.replace(/\x1b\[[0-9;]*m/g, "");
    const side = Math.max(0, Math.floor((W - stripped.length) / 2));
    const extra = (W - stripped.length) % 2;
    console.log(`  ${K.cyan}╔${"═".repeat(side)}${title}${K.cyan}${"═".repeat(side + extra)}╗${K.reset}`);
}
function boxBottom() { console.log(`  ${K.cyan}╚${"═".repeat(W + 2)}╝${K.reset}`); }
function boxSep() { console.log(`  ${K.cyan}╠${"═".repeat(W + 2)}╣${K.reset}`); }
function boxLine(content: string) {
    const stripped = content.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, W - stripped.length);
    console.log(`  ${K.cyan}║${K.reset} ${content}${" ".repeat(pad)}${K.cyan}║${K.reset}`);
}
function boxEmpty() { boxLine(""); }

function row(label: string, value: string, indent = 0) {
    const prefix = " ".repeat(indent);
    const stripped = (prefix + label).replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(1, 28 - stripped.length);
    boxLine(`${prefix}${label}${" ".repeat(pad)}${value}`);
}

function hfBadge(hf: number): string {
    if (!isFinite(hf) || hf > 100) return `${K.green}∞${K.reset}      ${K.dim}(no debt)${K.reset}`;
    if (hf >= 1.5) return `${K.bold}${K.green}${hf.toFixed(4)}${K.reset}  ${K.bgGreen}${K.white} HEALTHY ${K.reset}`;
    if (hf >= 1.1) return `${K.bold}${K.green}${hf.toFixed(4)}${K.reset}  ${K.bgGreen}${K.white} HEALTHY ${K.reset}`;
    if (hf >= 1.0) return `${K.bold}${K.yellow}${hf.toFixed(4)}${K.reset}  ${K.bgYellow}${K.white} AT RISK ${K.reset}`;
    return `${K.bold}${K.red}${hf.toFixed(4)}${K.reset}  ${K.bgRed}${K.white} LIQUIDATABLE ${K.reset}`;
}

function usd(amount: bigint, decimals = 6): string {
    const n = Number(amount) / 10 ** decimals;
    return `${K.green}$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}${K.reset}`;
}

function pol(amount: bigint): string {
    const n = Number(formatUnits(amount, 18));
    return `${K.magenta}${n.toFixed(4)} POL${K.reset}`;
}

function shares(n: bigint): string {
    return `${K.yellow}${Number(n).toLocaleString()}${K.reset} ${K.dim}YES shares${K.reset}`;
}

function sinceTs(ts: bigint): string {
    if (ts === 0n) return K.dim + "never" + K.reset;
    const secs = Math.floor(Date.now() / 1000) - Number(ts);
    if (secs < 60) return `${K.dim}${secs}s ago${K.reset}`;
    if (secs < 3600) return `${K.dim}${Math.floor(secs / 60)}m ago${K.reset}`;
    return `${K.dim}${Math.floor(secs / 3600)}h ago${K.reset}`;
}

// ─── Portfolio for one address ─────────────────────────────────────────────────
async function showPortfolio(
    publicClient: any,
    address: `0x${string}`,
    label: string,
    oraclePrice: bigint
) {
    const priceNum = Number(oraclePrice) / 1_000_000;

    // ── Wallet holdings ──────────────────────────────────────────────────────
    const [polBalance, usdcBalance, yesInWallet] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: POLYMARKET_CTF, abi: CTF_ABI, functionName: "balanceOf", args: [address, YES_TOKEN_ID] }) as Promise<bigint>,
    ]);

    // ── Protocol holdings ────────────────────────────────────────────────────
    const [collateral, loan, hf, totalDebt, liqPending] = await Promise.all([
        publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "getCollateral", args: [address, MARKET_ID] }) as Promise<bigint>,
        publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "getLoan", args: [address] }) as Promise<[bigint, bigint, bigint, bigint, boolean]>,
        publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "getHealthFactor", args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "getTotalDebt", args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: LENDING_POOL, abi: POOL_ABI, functionName: "liquidationPending", args: [address] }) as Promise<boolean>,
    ]);

    const MAX_HF = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const hfFloat = hf === MAX_HF ? Infinity : Number(hf) / 1e18;

    const [_loanMarket, principal, interestAccrued, lastUpdate, loanActive] = loan;
    const collateralValue = Number(collateral) * priceNum;
    const walletYesValue = Number(yesInWallet) * priceNum;
    const totalYes = collateral + yesInWallet;
    const totalYesValue = Number(totalYes) * priceNum;

    // ── Display ───────────────────────────────────────────────────────────────
    boxTop(` ${K.bold}${K.white}${label}${K.reset}${K.cyan} `);

    // Address
    boxLine(`  ${K.dim}${address}${K.reset}`);
    boxSep();

    // Wallet
    boxLine(`  ${K.bold}💼 Wallet${K.reset}`);
    row("  POL (gas)", pol(polBalance), 0);
    row("  USDC", usd(usdcBalance), 0);
    row("  YES shares", shares(yesInWallet), 0);
    row("  YES value", `${K.dim}≈ ${K.reset}${usd(BigInt(Math.floor(walletYesValue * 1_000_000)), 6)}`, 0);
    boxSep();

    // Protocol
    boxLine(`  ${K.bold}🔒 Sonder Protocol${K.reset}`);
    row("  Vault Collateral", shares(collateral), 0);
    row("  Collateral Value", `${K.dim}≈ ${K.reset}${usd(BigInt(Math.floor(collateralValue * 1_000_000)), 6)}`, 0);
    boxSep();

    if (loanActive) {
        boxLine(`  ${K.bold}📋 Active Loan${K.reset}`);
        row("  Principal", usd(principal), 0);
        row("  Interest Accrued", usd(interestAccrued), 0);
        row("  Total Debt", usd(totalDebt), 0);
        row("  Last Updated", sinceTs(lastUpdate), 0);
        row("  Health Factor", hfBadge(hfFloat), 0);
        if (liqPending) {
            row("  Status", `${K.bgRed}${K.white} LIQUIDATION PENDING ${K.reset}`, 0);
        }
    } else {
        boxLine(`  ${K.dim}No active loan${K.reset}`);
    }

    boxSep();
    // Totals
    boxLine(`  ${K.bold}📊 Summary${K.reset}`);
    row("  Total YES (wallet + vault)", shares(totalYes), 0);
    row("  Total YES value", `${K.dim}≈ ${K.reset}${usd(BigInt(Math.floor(totalYesValue * 1_000_000)), 6)}`, 0);
    row("  Net position",
        totalDebt === 0n
            ? `${K.green}+${usd(BigInt(Math.floor(totalYesValue * 1_000_000)), 6)}${K.reset}`
            : `${K.dim}Assets: ${K.reset}${usd(BigInt(Math.floor(totalYesValue * 1_000_000)), 6)}${K.dim} | Debt: ${K.reset}${usd(totalDebt)}`,
        0
    );
    boxBottom();
    console.log("");
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const publicClient = createPublicClient({ chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });

    const oraclePrice = await publicClient.readContract({
        address: PRICE_ORACLE, abi: ORACLE_ABI,
        functionName: "getPrice", args: [MARKET_ID],
    }) as bigint;

    const priceNum = Number(oraclePrice) / 1_000_000;
    const probPct = (priceNum * 100).toFixed(1);

    console.log("");
    console.log(`  ${K.bold}${K.cyan}Sonder — Portfolio Dashboard${K.reset}`);
    console.log(`  ${K.dim}Oracle: $${priceNum.toFixed(4)} (${probPct}% probability) | Market: "Aliens confirmed before 2027?"${K.reset}`);
    console.log(`  ${K.dim}Chain:  Tenderly Virtual TestNet (Polygon fork)${K.reset}`);
    console.log(`  ${K.dim}Time:   ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC${K.reset}\n`);

    // Custom address from env, or show Alice + Deployer
    if (process.env.ADDRESS) {
        await showPortfolio(publicClient, process.env.ADDRESS as `0x${string}`, "Custom Wallet", oraclePrice);
    } else {
        // Alice (demo borrower)
        const alice = privateKeyToAccount(ALICE_KEY);
        await showPortfolio(publicClient, alice.address, "Alice (Demo Borrower)", oraclePrice);

        // Deployer / Admin
        const deployer = privateKeyToAccount(process.env.CRE_ETH_PRIVATE_KEY! as `0x${string}`);
        await showPortfolio(publicClient, deployer.address, "Deployer / Admin", oraclePrice);
    }
}

main().catch(err => {
    console.error(`\n  ${K.red}Error:${K.reset}`, err.shortMessage ?? err.message ?? err);
    process.exit(1);
});
