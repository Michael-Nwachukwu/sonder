#!/usr/bin/env bun
/**
 * Sonder — CRE Autonomous Watcher (Execution Arm)
 *
 * Two-part autonomous loop:
 *   Part A (CRE Brain): Runs `cre workflow simulate --broadcast`
 *          → fetches Polymarket price, updates oracle, monitors health factors
 *          → AI Guardian on anomalies
 *   Part B (Execution): Reads health factors directly and executes on-chain actions
 *          → Calls checkAndEmitRiskEvents for at-risk positions
 *          → Calls finalizeLiquidation for triggered liquidations
 *          → Sends email notifications (console logs for demo, real email opt-in)
 *
 * Usage:
 *   bun run scripts/watcher.ts
 *   INTERVAL=30 bun run scripts/watcher.ts   # faster cycle
 *   NOTIFY_EMAIL=you@email.com bun run scripts/watcher.ts  # enable email logs
 */

import { execSync } from "child_process";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Resend } from "resend";

// ─── Config ───────────────────────────────────────────────────────────────────
const INTERVAL_SECS = parseInt(process.env.INTERVAL ?? "60");
const TENDERLY_RPC = process.env.TENDERLY_RPC_URL!;
const DEPLOYER_KEY = process.env.CRE_ETH_PRIVATE_KEY! as `0x${string}`;
const LENDING_POOL = process.env.LENDING_POOL_ADDRESS! as `0x${string}`;
const PRICE_ORACLE = process.env.PRICE_ORACLE_ADDRESS! as `0x${string}`;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? null;       // recipient email
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? null;     // unset = console-only
const FROM_EMAIL = process.env.FROM_EMAIL ?? "alerts@sonder.finance";
const WORKFLOW = "sonder-workflow";
const CRE = `${process.env.HOME}/.cre/bin/cre`;

// Resend client — null if no API key (falls back to console log)
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Borrowers to monitor — comma-separated in env, defaults to Alice
const BORROWERS = (process.env.BORROWER_ADDRESSES ?? "0x6C9cbb059F5Dbf3f265256a55bbCA0184Dc60564")
    .split(",").map(a => a.trim() as `0x${string}`);

const tenderlyChain = { ...polygon, id: 999137, name: "Tenderly (Polygon Fork)" };

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const POOL_ABI = parseAbi([
    "function getHealthFactor(address user) view returns (uint256)",
    "function getTotalDebt(address user) view returns (uint256)",
    "function getLoan(address user) view returns (uint256,uint256,uint256,uint256,bool)",
    "function checkAndEmitRiskEvents(address user) returns (uint256)",
    "function finalizeLiquidation(address user, uint256 recoveredUsdc) external",
    "function setAdminLiquidationOverride(address user, bool status) external",
    "function liquidationPending(address user) view returns (bool)",
]);

const ORACLE_ABI = parseAbi([
    "function mode() view returns (uint8)",
    "function setMode(uint8 newMode) external",
    "function updatePrice(uint256 marketId, uint256 price) external",
]);

// ─── Terminal UI ───────────────────────────────────────────────────────────────
const K = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
    blue: "\x1b[34m", cyan: "\x1b[36m", white: "\x1b[37m",
    bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgYellow: "\x1b[43m",
};

function now() { return new Date().toISOString().replace("T", " ").slice(0, 19); }
function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ${K.green}✓${K.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${K.yellow}⚠${K.reset} ${msg}`); }
function err(msg: string) { console.log(`  ${K.red}✗${K.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${K.dim}│${K.reset} ${msg}`); }

function header() {
    console.clear();
    const emailMode = resend && NOTIFY_EMAIL
        ? `${K.green}real → ${NOTIFY_EMAIL}${K.reset}`
        : `${K.yellow}console-only${K.reset} ${K.dim}(set RESEND_API_KEY + NOTIFY_EMAIL for real email)${K.reset}`;
    console.log(`\n  ${K.bold}${K.cyan}╔══════════════════════════════════════════════════════════╗${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}  ${K.bold}${K.white}Sonder — Autonomous CRE Watcher${K.reset}                    ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}║${K.reset}  ${K.dim}CRE Brain + On-chain Execution + Email Alerting${K.reset}       ${K.bold}${K.cyan}║${K.reset}`);
    console.log(`  ${K.bold}${K.cyan}╚══════════════════════════════════════════════════════════╝${K.reset}\n`);
    console.log(`  ${K.dim}Interval:  every ${INTERVAL_SECS}s${K.reset}`);
    console.log(`  ${K.dim}Borrowers: ${BORROWERS.map(a => a.slice(0, 10) + "...").join(", ")}${K.reset}`);
    console.log(`  ${K.dim}Email:     ${emailMode}`);
    console.log(`  ${K.dim}Started:   ${now()}${K.reset}`);
    console.log(`\n  ${K.yellow}Ctrl+C to stop${K.reset}`);
    console.log(`\n  ${"─".repeat(58)}`);
}

// ─── Email Notification ───────────────────────────────────────────────────────
async function sendEmailAlert(subject: string, body: string, borrower: string, isLiquidation = false) {
    const to = NOTIFY_EMAIL ?? borrower;

    // Always log to console with prominent styling
    console.log("");
    console.log(`  ${K.bgYellow}${K.bold}${K.white} 📧 EMAIL ALERT ${K.reset}`);
    console.log(`  ${K.yellow}To:      ${to}${K.reset}`);
    console.log(`  ${K.yellow}Subject: ${subject}${K.reset}`);
    console.log(`  ${K.yellow}Body:    ${body}${K.reset}`);

    // Send real email via Resend if configured
    if (resend && NOTIFY_EMAIL) {
        const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; margin: 0; padding: 24px; }
  .card { background: #111; border: 1px solid ${isLiquidation ? "#ef4444" : "#f59e0b"}; border-radius: 12px; max-width: 480px; padding: 28px; }
  .badge { display: inline-block; background: ${isLiquidation ? "#ef4444" : "#f59e0b"}; color: white; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
  h2 { margin: 0 0 8px; font-size: 20px; color: white; }
  p  { margin: 0 0 16px; line-height: 1.6; color: #999; }
  .footer { margin-top: 24px; font-size: 12px; color: #555; border-top: 1px solid #222; padding-top: 16px; }
  a { color: #22d3ee; }
</style></head>
<body>
  <div class="card">
    <div class="badge">${isLiquidation ? "🔴 LIQUIDATION" : "⚠️ AT RISK"}</div>
    <h2>${subject}</h2>
    <p>${body}</p>
    <p>Wallet: <code style="color:#22d3ee;font-size:13px">${borrower.slice(0, 16)}...${borrower.slice(-4)}</code></p>
    <div class="footer">Sonder Protocol · Powered by Chainlink CRE · <a href="https://polymarket.com">Polymarket</a></div>
  </div>
</body>
</html>`;

        try {
            const { error } = await resend.emails.send({
                from: FROM_EMAIL,
                to: NOTIFY_EMAIL,
                subject,
                html,
            });
            if (error) {
                console.log(`  ${K.red}  Email send failed: ${error.message}${K.reset}`);
            } else {
                console.log(`  ${K.green}  ✓ Email sent via Resend → ${NOTIFY_EMAIL}${K.reset}`);
            }
        } catch (e: any) {
            console.log(`  ${K.red}  Email error: ${e.message}${K.reset}`);
        }
    } else {
        console.log(`  ${K.dim}  (Set RESEND_API_KEY + NOTIFY_EMAIL to send real emails)${K.reset}`);
    }
    console.log("");
}

// ─── Part A: CRE Brain ────────────────────────────────────────────────────────
function runCREWorkflow(): { success: boolean; price?: number; prevPrice?: number; anomaly?: boolean; liquidatable?: number; atRisk?: number; output: string } {
    try {
        // Use spawnSync so we can capture output AND echo important lines to terminal
        const { spawnSync } = require("child_process");
        const result = spawnSync(
            CRE,
            ["workflow", "simulate", WORKFLOW, "--broadcast"],
            {
                encoding: "utf-8",
                cwd: process.cwd(),
                timeout: 180_000,
                maxBuffer: 10 * 1024 * 1024,
                input: "\n",  // Auto-accept trigger prompt (selects default cron trigger)
                env: { ...process.env },
            }
        );

        const output = (result.stdout ?? "") + (result.stderr ?? "");

        // ── Stream [USER LOG] lines to terminal ──────────────────────────
        // These are runtime.log() calls from cronCallback.ts + aiGuardian.ts
        const logLines = output.split("\n").filter((line: string) =>
            line.includes("[USER LOG]") ||
            line.includes("Simulation complete")
        );

        for (const line of logLines) {
            // Strip the CRE timestamp prefix: "2026-02-28T14:00:00Z [USER LOG] "
            const cleaned = line.replace(/^\S+\s+\[USER LOG\]\s*/, "").trim();
            if (!cleaned) continue;

            // Colour-code based on content
            if (cleaned.includes("ANOMALY") || cleaned.includes("⚠")) {
                console.log(`  ${K.yellow}${cleaned}${K.reset}`);
            } else if (cleaned.includes("LIQUIDAT") || cleaned.includes("🔴")) {
                console.log(`  ${K.red}${cleaned}${K.reset}`);
            } else if (cleaned.includes("AI Guardian") && cleaned.includes("┏")) {
                console.log(`\n  ${K.cyan}${cleaned}${K.reset}`);
            } else if (cleaned.includes("Step F") || cleaned.includes("Verdict") || cleaned.includes("Recommendation")) {
                console.log(`  ${K.bold}${cleaned}${K.reset}`);
            } else if (cleaned.includes("🔍") || cleaned.includes("📰")) {
                console.log(`  ${K.cyan}  ${cleaned}${K.reset}`);
            } else if (cleaned.includes("━━━") || cleaned.includes("┏") || cleaned.includes("┗")) {
                console.log(`  ${K.dim}${cleaned}${K.reset}`);
            } else if (cleaned.startsWith("[Step") || cleaned.startsWith("[AI Guardian]") || cleaned.startsWith("[Sonder]")) {
                console.log(`  ${K.dim}${cleaned}${K.reset}`);
            }
        }

        // Parse the return value line (last non-empty line from the simulate output)
        const priceMatch = output.match(/price=(\d+)/);
        const prevPrMatch = output.match(/prevPrice=(\d+)/);
        const anomalyMatch = output.match(/anomaly=(\d)/);
        const liqMatch = output.match(/liquidatable=(\d+)/);
        const atRiskMatch = output.match(/atRisk=(\d+)/);

        if (result.status !== 0 && !priceMatch) {
            return { success: false, output };
        }

        return {
            success: true,
            price: priceMatch ? parseInt(priceMatch[1] ?? "0") : undefined,
            prevPrice: prevPrMatch ? parseInt(prevPrMatch[1] ?? "0") : undefined,
            anomaly: anomalyMatch ? anomalyMatch[1] === "1" : false,
            liquidatable: liqMatch ? parseInt(liqMatch[1] ?? "0") : undefined,
            atRisk: atRiskMatch ? parseInt(atRiskMatch[1] ?? "0") : undefined,
            output,
        };
    } catch (e: any) {
        return { success: false, output: e.message ?? String(e) };
    }
}

// ─── Part B: On-chain Execution ───────────────────────────────────────────────
async function executeRiskActions(
    publicClient: any,
    adminWallet: any,
    runCount: number
): Promise<void> {
    log(`${K.dim}[Execution] Checking ${BORROWERS.length} borrower(s) for action...${K.reset}`);

    for (const borrower of BORROWERS) {
        const shortAddr = `${borrower.slice(0, 10)}...`;

        // 1. Read loan status
        const loan = await publicClient.readContract({
            address: LENDING_POOL, abi: POOL_ABI,
            functionName: "getLoan", args: [borrower],
        }) as [bigint, bigint, bigint, bigint, boolean];

        const loanActive = loan[4];
        if (!loanActive) {
            info(`${shortAddr} — no active loan, skipping`);
            continue;
        }

        // 2. Read health factor and debt
        const hf = await publicClient.readContract({
            address: LENDING_POOL, abi: POOL_ABI,
            functionName: "getHealthFactor", args: [borrower],
        }) as bigint;

        const totalDebt = await publicClient.readContract({
            address: LENDING_POOL, abi: POOL_ABI,
            functionName: "getTotalDebt", args: [borrower],
        }) as bigint;

        const isLiquidationPending = await publicClient.readContract({
            address: LENDING_POOL, abi: POOL_ABI,
            functionName: "liquidationPending", args: [borrower],
        }) as boolean;

        const WARNING_HF = 1_100_000_000_000_000_000n;
        const LIQUIDATION_HF = 1_000_000_000_000_000_000n;
        const MAX_HF = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

        const hfFloat = hf === MAX_HF ? Infinity : Number(hf) / 1e18;
        const debtUsd = Number(totalDebt) / 1_000_000;

        if (hf === MAX_HF || hf > WARNING_HF * 2n) {
            ok(`${K.green}${shortAddr}${K.reset} — HF: ${hfFloat === Infinity ? "∞" : hfFloat.toFixed(4)} ${K.dim}(healthy)${K.reset}`);
            continue;
        }

        if (isLiquidationPending) {
            // Liquidation already triggered — finalize it
            warn(`${K.yellow}${shortAddr}${K.reset} — liquidation pending, finalizing...`);
            try {
                const finalizeTx = await adminWallet.writeContract({
                    address: LENDING_POOL, abi: POOL_ABI,
                    functionName: "finalizeLiquidation",
                    args: [borrower, 0n], // 0 = bad debt write-off (demo mode)
                    chain: null,
                });
                await publicClient.waitForTransactionReceipt({ hash: finalizeTx });
                ok(`Liquidation finalized for ${shortAddr} ${K.dim}(${finalizeTx.slice(0, 14)}...)${K.reset}`);
                await sendEmailAlert(
                    "Sonder: Your position has been liquidated",
                    `Your loan of $${debtUsd.toFixed(2)} USDC has been liquidated. Health factor fell below 1.0.`,
                    borrower,
                    true
                );
            } catch (e: any) {
                err(`Finalize failed: ${e.shortMessage ?? e.message}`);
            }

        } else if (hf < LIQUIDATION_HF) {
            // Position is liquidatable — trigger seizure + send email
            warn(`${K.bgRed}${K.white} LIQUIDATABLE ${K.reset} ${shortAddr} — HF: ${K.red}${hfFloat.toFixed(4)}${K.reset} | Debt: $${debtUsd.toFixed(2)}`);

            await sendEmailAlert(
                "⚠ Sonder: Liquidation triggered on your position",
                `Your position (HF: ${hfFloat.toFixed(4)}) is being liquidated. Debt: $${debtUsd.toFixed(2)} USDC.`,
                borrower,
                true
            );

            try {
                // Set override to force liquidation
                const overrideTx = await adminWallet.writeContract({
                    address: LENDING_POOL, abi: POOL_ABI,
                    functionName: "setAdminLiquidationOverride",
                    args: [borrower, true], chain: null,
                });
                await publicClient.waitForTransactionReceipt({ hash: overrideTx });

                // Trigger seizure
                const triggerTx = await adminWallet.writeContract({
                    address: LENDING_POOL, abi: POOL_ABI,
                    functionName: "checkAndEmitRiskEvents",
                    args: [borrower], chain: null,
                });
                await publicClient.waitForTransactionReceipt({ hash: triggerTx });
                ok(`Collateral seized for ${shortAddr} ${K.dim}(${triggerTx.slice(0, 14)}...)${K.reset}`);
            } catch (e: any) {
                err(`Trigger failed: ${e.shortMessage ?? e.message}`);
            }

        } else if (hf < WARNING_HF) {
            // Position is at risk — send warning email
            warn(`${K.bgYellow}${K.white} AT RISK ${K.reset}     ${shortAddr} — HF: ${K.yellow}${hfFloat.toFixed(4)}${K.reset} | Debt: $${debtUsd.toFixed(2)}`);
            await sendEmailAlert(
                "⚠ Sonder: Your position is at risk",
                `Your health factor is ${hfFloat.toFixed(4)} (minimum 1.0). Add collateral or repay to avoid liquidation.`,
                borrower
            );
        }
    }
}

// ─── Countdown bar ────────────────────────────────────────────────────────────
async function countdown(seconds: number) {
    for (let s = seconds; s > 0; s--) {
        const filled = Math.floor((seconds - s) / seconds * 32);
        const bar = "█".repeat(filled) + "░".repeat(32 - filled);
        process.stdout.write(
            `\r  ${K.dim}Next in ${K.reset}${K.bold}${K.yellow}${String(s).padStart(3)}s${K.reset}  ${K.cyan}${bar}${K.reset}`
        );
        await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write("\r" + " ".repeat(80) + "\r");
}

// ─── Main loop ────────────────────────────────────────────────────────────────
let runCount = 0;

async function main() {
    header();

    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const publicClient = createPublicClient({ chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });
    const adminWallet = createWalletClient({ account: deployer, chain: tenderlyChain as any, transport: http(TENDERLY_RPC) });

    while (true) {
        runCount++;
        const ts = now();
        console.log(`\n  ${K.bold}${K.cyan}[Cycle #${runCount}]${K.reset} ${K.dim}${ts}${K.reset}`);
        console.log(`  ${"─".repeat(58)}`);

        // ── Pre-flight: Log oracle mode (do NOT reset — demo may intentionally set MOCK)
        try {
            const mode = await publicClient.readContract({
                address: PRICE_ORACLE, abi: ORACLE_ABI,
                functionName: "mode",
            }) as number;
            info(`Oracle mode: ${mode === 0 ? "REAL" : "MOCK"}`);
        } catch (e: any) {
            warn(`Oracle pre-flight read failed: ${(e.message ?? String(e)).slice(0, 100)}`);
        }

        // ── Part A: CRE Simulate Workflow ─────────────────────────────────
        log(`${K.bold}Part A:${K.reset} ${K.cyan}cre workflow simulate ${WORKFLOW} --broadcast${K.reset}`);
        const cre = runCREWorkflow();

        if (cre.success) {
            const priceStr = cre.price !== undefined
                ? `$${(cre.price / 1_000_000).toFixed(4)}`
                : "unknown";
            ok(`CRE cycle complete: Oracle price = ${K.cyan}${priceStr}${K.reset}`);
            info(`Liquidatable: ${cre.liquidatable ?? "?"} | At risk: ${cre.atRisk ?? "?"}`);
        } else {
            const errLine = cre.output.split("\n").find(l => l.trim() && !l.includes("node_modules"));
            err(`CRE workflow failed: ${errLine?.trim() ?? "unknown error"}`);
        }

        // ── Part B: On-chain Execution (Arm) ─────────────────────────────
        console.log("");
        log(`${K.bold}Part B: Risk Execution${K.reset} — health checks + actions`);
        try {
            await executeRiskActions(publicClient, adminWallet, runCount);
        } catch (e: any) {
            err(`Execution error: ${e.message}`);
        }

        // ── Post-cycle: Reset oracle to REAL if it was in MOCK ────────────
        // The demo may have crashed the price via MOCK mode. After the cycle
        // has detected the anomaly and executed liquidations, reset back to
        // REAL so the next cycle fetches live Polymarket prices.
        try {
            const mode = await publicClient.readContract({
                address: PRICE_ORACLE, abi: ORACLE_ABI,
                functionName: "mode",
            }) as number;
            if (mode !== 0) { // 0 = REAL, 1 = MOCK
                info(`Oracle was in MOCK mode — resetting to REAL for next cycle...`);
                const resetTx = await adminWallet.writeContract({
                    address: PRICE_ORACLE, abi: ORACLE_ABI,
                    functionName: "setMode", args: [0],
                    chain: null,
                });
                await publicClient.waitForTransactionReceipt({ hash: resetTx });
                ok(`Oracle reset to REAL mode`);
            }
        } catch (e: any) {
            warn(`Oracle post-cycle reset failed: ${(e.message ?? String(e)).slice(0, 100)}`);
        }

        console.log(`\n  ${"─".repeat(58)}`);
        await countdown(INTERVAL_SECS);
    }
}

process.on("SIGINT", () => {
    console.log(`\n\n  ${K.yellow}Watcher stopped after ${runCount} cycle(s).${K.reset}\n`);
    process.exit(0);
});

main().catch(e => {
    console.error(`\n  ${K.red}Fatal error:${K.reset}`, e.message ?? e);
    process.exit(1);
});
