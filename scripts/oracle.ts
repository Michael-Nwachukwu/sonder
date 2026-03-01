#!/usr/bin/env bun
/**
 * oracle.ts — Interactive Price Oracle Management
 *
 * Usage:  bun run scripts/oracle.ts
 *
 * Commands:
 *   status    Show current mode, real price, mock price
 *   real      Switch to REAL mode (CRE-driven live prices)
 *   mock      Switch to MOCK mode
 *   crash     Set a mock crash price and switch to MOCK mode
 *   set       Set the real price to a specific value
 *   help      Show this help
 *   exit      Quit
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as readline from "readline";

// ─── Config ──────────────────────────────────────────────────────────────────
const RPC = process.env.TENDERLY_RPC_URL!;
const KEY = process.env.CRE_ETH_PRIVATE_KEY! as `0x${string}`;
const ORACLE = (process.env.PRICE_ORACLE_ADDRESS ?? "0x323117CE686E0FdF05546145af1078A1Eb855295") as `0x${string}`;
const MARKET_ID = 1n;

const chain = {
    id: 999137,
    name: "Tenderly (Polygon Fork)",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
};

const ABI = parseAbi([
    "function mode() view returns (uint8)",
    "function getPrice(uint256 marketId) view returns (uint256)",
    "function getPrices(uint256 marketId) view returns (uint256 real, uint256 mock)",
    "function setMode(uint8 newMode) external",
    "function setMockPrice(uint256 marketId, uint256 price) external",
    "function updatePrice(uint256 marketId, uint256 price) external",
    "function updater() view returns (address)",
    "function owner() view returns (address)",
]);

const account = privateKeyToAccount(KEY);
const publicClient = createPublicClient({ chain: chain as any, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: chain as any, transport: http(RPC) });

// ─── Helpers ─────────────────────────────────────────────────────────────────
const K = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function priceToStr(p: bigint): string {
    const f = Number(p) / 1_000_000;
    return `$${f.toFixed(4)} (${(f * 100).toFixed(1)}% probability)`;
}

async function showStatus(): Promise<void> {
    const mode = await publicClient.readContract({ address: ORACLE, abi: ABI, functionName: "mode" }) as number;
    const [realPrice, mockPrice] = await publicClient.readContract({ address: ORACLE, abi: ABI, functionName: "getPrices", args: [MARKET_ID] }) as [bigint, bigint];
    const activePrice = await publicClient.readContract({ address: ORACLE, abi: ABI, functionName: "getPrice", args: [MARKET_ID] }) as bigint;

    const modeStr = mode === 0
        ? `${K.green}REAL${K.reset} (CRE-driven live prices)`
        : `${K.yellow}MOCK${K.reset} (manual crash simulation)`;

    console.log(`\n  ${K.bold}Oracle Status${K.reset}  ${ORACLE.slice(0, 10)}...`);
    console.log(`  ├ Mode:         ${modeStr}`);
    console.log(`  ├ Active price: ${K.bold}${priceToStr(activePrice)}${K.reset}`);
    console.log(`  ├ Real price:   ${priceToStr(realPrice)}`);
    console.log(`  └ Mock price:   ${priceToStr(mockPrice)}\n`);
}

async function setMode(mode: number, label: string): Promise<void> {
    console.log(`  Setting oracle to ${label} mode...`);
    const tx = await walletClient.writeContract({
        address: ORACLE, abi: ABI, functionName: "setMode", args: [mode], chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`  ${K.green}✓${K.reset} Oracle set to ${label} mode (tx: ${tx.slice(0, 14)}...)`);
}

async function setMockCrash(rl: readline.Interface): Promise<void> {
    const priceStr = await ask(rl, `  Enter crash price (e.g. 0.05 for 5%): `);
    const f = parseFloat(priceStr);
    if (isNaN(f) || f < 0 || f > 1) {
        console.log(`  ${K.red}✗ Invalid price. Must be 0.00–1.00${K.reset}`);
        return;
    }
    const price6dec = BigInt(Math.round(f * 1_000_000));
    console.log(`  Setting mock price to ${priceToStr(price6dec)}...`);

    const tx1 = await walletClient.writeContract({
        address: ORACLE, abi: ABI, functionName: "setMockPrice", args: [MARKET_ID, price6dec], chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx1 });

    const tx2 = await walletClient.writeContract({
        address: ORACLE, abi: ABI, functionName: "setMode", args: [1], chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx2 });

    console.log(`  ${K.green}✓${K.reset} Mock crash set: ${priceToStr(price6dec)} (MOCK mode active)`);
}

async function setRealPrice(rl: readline.Interface): Promise<void> {
    const priceStr = await ask(rl, `  Enter real price (e.g. 0.65 for 65%): `);
    const f = parseFloat(priceStr);
    if (isNaN(f) || f <= 0 || f > 1) {
        console.log(`  ${K.red}✗ Invalid price. Must be 0.01–1.00${K.reset}`);
        return;
    }
    const price6dec = BigInt(Math.round(f * 1_000_000));
    console.log(`  Setting real price to ${priceToStr(price6dec)}...`);

    const tx = await walletClient.writeContract({
        address: ORACLE, abi: ABI, functionName: "updatePrice", args: [MARKET_ID, price6dec], chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });

    // Also ensure we're in REAL mode
    const mode = await publicClient.readContract({ address: ORACLE, abi: ABI, functionName: "mode" }) as number;
    if (mode !== 0) {
        const tx2 = await walletClient.writeContract({
            address: ORACLE, abi: ABI, functionName: "setMode", args: [0], chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx2 });
    }

    console.log(`  ${K.green}✓${K.reset} Real price set: ${priceToStr(price6dec)} (REAL mode active)`);
}

function ask(rl: readline.Interface, q: string): Promise<string> {
    return new Promise(resolve => rl.question(q, resolve));
}

function showHelp(): void {
    console.log(`
  ${K.bold}Commands:${K.reset}
  ${K.cyan}status${K.reset}   Show current mode, real price, mock price
  ${K.cyan}real${K.reset}     Switch to REAL mode (CRE-driven live prices)
  ${K.cyan}mock${K.reset}     Switch to MOCK mode (keeps current mock price)
  ${K.cyan}crash${K.reset}    Set a mock crash price and switch to MOCK mode
  ${K.cyan}set${K.reset}      Set the real price to a specific value
  ${K.cyan}help${K.reset}     Show this help
  ${K.cyan}exit${K.reset}     Quit
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n  ${K.bold}${K.cyan}Sonder — Oracle Manager${K.reset}`);
    console.log(`  Oracle:  ${ORACLE}`);
    console.log(`  Wallet:  ${account.address}`);
    console.log(`  Market:  ${MARKET_ID}\n`);

    await showStatus();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => rl.question(`  ${K.dim}oracle>${K.reset} `, async (cmd) => {
        const c = cmd.trim().toLowerCase();
        try {
            switch (c) {
                case "status": case "s": await showStatus(); break;
                case "real": case "r": await setMode(0, "REAL"); await showStatus(); break;
                case "mock": case "m": await setMode(1, "MOCK"); await showStatus(); break;
                case "crash": case "c": await setMockCrash(rl); await showStatus(); break;
                case "set": await setRealPrice(rl); await showStatus(); break;
                case "help": case "h": case "?": showHelp(); break;
                case "exit": case "quit": case "q":
                    console.log(`  ${K.dim}Bye!${K.reset}\n`);
                    rl.close();
                    process.exit(0);
                case "": break;
                default:
                    console.log(`  ${K.red}Unknown command: ${c}${K.reset}. Type ${K.cyan}help${K.reset} for commands.`);
            }
        } catch (e: any) {
            console.log(`  ${K.red}Error: ${e.message?.slice(0, 120) ?? e}${K.reset}`);
        }
        prompt();
    });
    prompt();
}

main().catch(e => { console.error(e); process.exit(1); });
