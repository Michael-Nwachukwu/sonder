import {
    type Runtime,
    EVMClient,
    HTTPClient,
    type WriteCreReportRequestJson,
    encodeCallMsg,
    prepareReportRequest,
    consensusIdenticalAggregation,
} from "@chainlink/cre-sdk";
import { toHex, encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";
import { analyzeAnomaly } from "./aiGuardian";

type Config = {
    priceOracleAddress: string;
    lendingPoolAddress: string;
    polymarketTokenId: string;
    marketId: string;
    eventId: string;
    geminiModel: string;
    chainSelectorName: string;
    gasLimit: string;
    anomalyDropThreshold: string;
};

type PolymarketMidpointResponse = {
    mid: string;
};

const GET_PRICE_ABI = [
    {
        name: "getPrice",
        type: "function",
        inputs: [{ name: "marketId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

const UPDATE_PRICE_ABI = [
    {
        name: "updatePrice",
        type: "function",
        inputs: [
            { name: "marketId", type: "uint256" },
            { name: "price", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/**
 * Cron callback — runs every N minutes (schedule set in config.staging.json).
 *
 * SDK v1.1.2 API notes applied here:
 * - runtime.config (not runtime.getConfig())
 * - HTTPClient.sendRequest(nodeRuntime, ...) needs NodeRuntime → use runInNodeMode
 * - headers is a deprecated map<string,string>: { "Key": "Value" }
 * - runInNodeMode takes consensusIdenticalAggregation() as 2nd arg
 * - CallContractReply.data (not .returnData) is Uint8Array of ABI-encoded return value
 * - runtime.report() + EVMClient.writeReport() for DON-signed on-chain writes
 */
export async function onCronTrigger(runtime: Runtime<Config>): Promise<string> {
    const config = runtime.config;
    runtime.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    runtime.log("[Sonder] CRE cron triggered — fetching Polymarket price...");

    const POLYGON = EVMClient.SUPPORTED_CHAIN_SELECTORS["polygon-mainnet"];
    const evmClient = new EVMClient(POLYGON);
    const httpClient = new HTTPClient();

    // ─── Step 1: Fetch Polymarket midpoint via HTTP (Node mode) ────────────
    const priceUrl = `https://clob.polymarket.com/midpoint?token_id=${config.polymarketTokenId}`;

    // response.body is Uint8Array — decode to string then return for consensus aggregation
    const responseBody = runtime
        .runInNodeMode(
            (nodeRuntime) => {
                const res = httpClient
                    .sendRequest(nodeRuntime, {
                        url: priceUrl,
                        method: "GET",
                        headers: { Accept: "application/json" },
                    })
                    .result();
                return new TextDecoder().decode(res.body);
            },
            consensusIdenticalAggregation<string>()
        )().result();

    let midFloat: number;
    try {
        const parsed = JSON.parse(responseBody) as PolymarketMidpointResponse;
        midFloat = parseFloat(parsed.mid);
    } catch {
        runtime.log(`[ERROR] Bad Polymarket response: ${responseBody}`);
        return "ERROR: bad polymarket response";
    }

    const price6dec = Math.round(midFloat * 1_000_000);
    runtime.log(`[Step 1] Polymarket mid: $${midFloat} → ${price6dec} (6 dec)`);

    // ─── Step 2: Read current on-chain price ───────────────────────────────
    const getCalldata = encodeFunctionData({
        abi: GET_PRICE_ABI,
        functionName: "getPrice",
        args: [BigInt(config.marketId)],
    });

    const readResult = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: "0x0000000000000000000000000000000000000000",
                to: config.priceOracleAddress as `0x${string}`,
                data: getCalldata,
            }),
        })
        .result();

    // CallContractReply.data is Uint8Array of ABI-encoded return value
    let prevPrice6dec = 0;
    if (readResult.data && readResult.data.length > 0) {
        const [decodedPrice] = decodeAbiParameters(
            parseAbiParameters("uint256"),
            toHex(readResult.data)
        );
        prevPrice6dec = Number(decodedPrice);
    }

    const priceDrop =
        prevPrice6dec > 0 ? (prevPrice6dec - price6dec) / prevPrice6dec : 0;
    const priceSwing = Math.abs(priceDrop); // anomaly in either direction
    const swingDir = priceDrop >= 0 ? "↓" : "↑";
    runtime.log(
        `[Step 2] On-chain: ${prevPrice6dec} | New: ${price6dec} | ${swingDir} Swing: ${(priceSwing * 100).toFixed(2)}%`
    );

    // ─── Step 3: Update PriceOracle on-chain ───────────────────────────────
    const updateCalldata = encodeFunctionData({
        abi: UPDATE_PRICE_ABI,
        functionName: "updatePrice",
        args: [BigInt(config.marketId), BigInt(price6dec)],
    });

    // DON signs the encoded payload, then writeReport submits it on-chain
    const reportRequest = prepareReportRequest(toHex(updateCalldata));
    const report = runtime.report(reportRequest).result();

    const writeRequest: WriteCreReportRequestJson = {
        receiver: config.priceOracleAddress,
        report,
        gasConfig: { gasLimit: config.gasLimit },
    };
    evmClient.writeReport(runtime, writeRequest).result();
    runtime.log(
        `[Step 3] PriceOracle updated: marketId=${config.marketId} price=${price6dec}`
    );

    // ─── Step 4: Anomaly check → AI Guardian ───────────────────────────────
    const dropThreshold = parseFloat(config.anomalyDropThreshold);
    let anomalyDetected = false;
    if (priceSwing >= dropThreshold && prevPrice6dec > 0) {
        anomalyDetected = true;
        runtime.log(`[Step 4] ⚠ ANOMALY DETECTED: ${(priceSwing * 100).toFixed(2)}% ${swingDir} swing exceeds threshold of ${(dropThreshold * 100).toFixed(0)}%`);

        // Quick pre-check: any active loans? If not, skip the AI call entirely
        const BORROWERS_CHECK = (config as any).borrowerAddresses
            ? ((config as any).borrowerAddresses as string).split(",").map((a: string) => a.trim())
            : ["0x6C9cbb059F5Dbf3f265256a55bbCA0184Dc60564"];

        const GET_LOAN_CHECK_ABI = [{
            name: "getLoan", type: "function",
            inputs: [{ name: "user", type: "address" }],
            outputs: [
                { name: "marketId", type: "uint256" }, { name: "principal", type: "uint256" },
                { name: "interestAccrued", type: "uint256" }, { name: "lastInterestUpdate", type: "uint256" },
                { name: "active", type: "bool" },
            ],
            stateMutability: "view",
        }] as const;

        let hasActiveLoans = false;
        for (const borrower of BORROWERS_CHECK) {
            try {
                const calldata = encodeFunctionData({
                    abi: GET_LOAN_CHECK_ABI,
                    functionName: "getLoan",
                    args: [borrower as `0x${string}`],
                });
                const loanRes = evmClient.callContract(runtime, {
                    call: encodeCallMsg({
                        from: "0x0000000000000000000000000000000000000000",
                        to: config.lendingPoolAddress as `0x${string}`,
                        data: calldata,
                    }),
                }).result();
                if (loanRes.data && loanRes.data.length > 0) {
                    const decoded = decodeAbiParameters(
                        parseAbiParameters("uint256, uint256, uint256, uint256, bool"),
                        toHex(loanRes.data)
                    );
                    if (decoded[4]) { hasActiveLoans = true; break; }
                }
            } catch { /* ignore */ }
        }

        if (!hasActiveLoans) {
            runtime.log(`[Step 4] No active loans — skipping AI Guardian analysis (no exposure to protect)`);
        } else {
            runtime.log(`[Step 4] Active loan(s) found — running AI Guardian pipeline  [via CRE]`);

            // ── Fetch community comments from Polymarket Gamma API ────────────
            const COMMENTS_PER_PAGE = 10;
            let allComments: Array<{ body: string; createdAt: string; author: string }> = [];

            for (let page = 0; page < 2; page++) {
                const offset = page * COMMENTS_PER_PAGE;
                const commentsUrl = `https://gamma-api.polymarket.com/comments?parent_entity_id=${config.eventId}&parent_entity_type=Event&limit=${COMMENTS_PER_PAGE}&offset=${offset}`;
                runtime.log(`[Step 4] Fetching comments page ${page + 1}: ${commentsUrl}`);

                try {
                    const commentsBody = httpClient
                        .sendRequest(
                            runtime,
                            (sendRequester) => {
                                const res = sendRequester
                                    .sendRequest({
                                        url: commentsUrl,
                                        method: "GET",
                                        headers: { Accept: "application/json" },
                                    })
                                    .result();
                                return new TextDecoder().decode(res.body);
                            },
                            consensusIdenticalAggregation<string>()
                        )()
                        .result();

                    const parsed = JSON.parse(commentsBody) as Array<{
                        body: string;
                        createdAt: string;
                        profile?: { name?: string };
                    }>;

                    for (const c of parsed) {
                        allComments.push({
                            body: c.body,
                            createdAt: c.createdAt,
                            author: c.profile?.name ?? "anonymous",
                        });
                    }
                    runtime.log(`[Step 4] Page ${page + 1}: ${parsed.length} comments (total so far: ${allComments.length})`);
                    if (parsed.length < COMMENTS_PER_PAGE) break;
                } catch {
                    runtime.log(`[Step 4] Could not fetch comments page ${page + 1}`);
                    break;
                }
            }

            runtime.log(`[Step 4] ✓ ${allComments.length} community comments ready — handing off to AI Guardian`);

            // analyzeAnomaly logs the full pipeline (Steps A-F) internally
            await analyzeAnomaly(runtime, {
                marketId: config.marketId,
                currentPrice: midFloat,
                previousPrice: prevPrice6dec / 1_000_000,
                priceDrop: priceSwing,
                geminiModel: config.geminiModel,
                recentComments: allComments,
            });
        } // end hasActiveLoans
    } else {
        runtime.log(`[Step 4] No anomaly (swing: ${(priceSwing * 100).toFixed(2)}% | threshold: ${(dropThreshold * 100).toFixed(0)}%) — AI Guardian not triggered`);
    }


    // ─── Step 5: Health Factor Monitoring ──────────────────────────────────
    runtime.log("[Step 5] Checking borrower health factors...");

    const GET_HEALTH_FACTOR_ABI = [
        {
            name: "getHealthFactor",
            type: "function",
            inputs: [{ name: "user", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
        },
    ] as const;

    const GET_LOAN_ABI = [
        {
            name: "getLoan",
            type: "function",
            inputs: [{ name: "user", type: "address" }],
            outputs: [
                { name: "marketId", type: "uint256" },
                { name: "principal", type: "uint256" },
                { name: "interestAccrued", type: "uint256" },
                { name: "lastInterestUpdate", type: "uint256" },
                { name: "active", type: "bool" },
            ],
            stateMutability: "view",
        },
    ] as const;

    // Borrowers to monitor — in production this would be read from on-chain events
    // For demo: Alice's address is the primary borrower
    const BORROWERS_TO_MONITOR = (config as any).borrowerAddresses
        ? ((config as any).borrowerAddresses as string).split(",").map((a: string) => a.trim())
        : ["0x6C9cbb059F5Dbf3f265256a55bbCA0184Dc60564"]; // Alice

    const WARNING_HF = 1_100_000_000_000_000_000n;  // 1.1e18
    const LIQUIDATION_HF = 1_000_000_000_000_000_000n; // 1.0e18

    let atRiskCount = 0;
    let liquidatableCount = 0;

    for (const borrower of BORROWERS_TO_MONITOR) {
        // Read loan to check if active
        const loanCalldata = encodeFunctionData({
            abi: GET_LOAN_ABI,
            functionName: "getLoan",
            args: [borrower as `0x${string}`],
        });

        const loanResult = evmClient.callContract(runtime, {
            call: encodeCallMsg({
                from: "0x0000000000000000000000000000000000000000",
                to: config.lendingPoolAddress as `0x${string}`,
                data: loanCalldata,
            }),
        }).result();

        // If no data or empty, skip
        if (!loanResult.data || loanResult.data.length === 0) {
            runtime.log(`[Step 5] ${borrower.slice(0, 10)}... — no active loan`);
            continue;
        }

        // Decode loan struct
        const decoded = decodeAbiParameters(
            parseAbiParameters("uint256, uint256, uint256, uint256, bool"),
            toHex(loanResult.data)
        );
        const loanActive = decoded[4];
        const principal = decoded[1];

        if (!loanActive) {
            runtime.log(`[Step 5] ${borrower.slice(0, 10)}... — no active loan`);
            continue;
        }

        // Read health factor
        const hfCalldata = encodeFunctionData({
            abi: GET_HEALTH_FACTOR_ABI,
            functionName: "getHealthFactor",
            args: [borrower as `0x${string}`],
        });

        const hfResult = evmClient.callContract(runtime, {
            call: encodeCallMsg({
                from: "0x0000000000000000000000000000000000000000",
                to: config.lendingPoolAddress as `0x${string}`,
                data: hfCalldata,
            }),
        }).result();

        let hf = BigInt(0);
        if (hfResult.data && hfResult.data.length > 0) {
            const [decodedHf] = decodeAbiParameters(
                parseAbiParameters("uint256"),
                toHex(hfResult.data)
            );
            hf = decodedHf;
        }

        const hfFloat = Number(hf) / 1e18;
        const principalUsdc = Number(principal) / 1_000_000;
        const shortAddr = `${borrower.slice(0, 10)}...`;

        if (hf === BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")) {
            runtime.log(`[Step 5] ${shortAddr} — HF: ∞ (no debt or loan just opened)`);
        } else if (hf < LIQUIDATION_HF) {
            liquidatableCount++;
            runtime.log(
                `[Step 5] 🔴 LIQUIDATABLE: ${shortAddr} — HF: ${hfFloat.toFixed(4)} | Debt: $${principalUsdc.toFixed(2)}`
            );
            runtime.log(
                `[Step 5]    → ACTION: checkAndEmitRiskEvents will seize collateral (executed by liquidation bot)`
            );
            runtime.log(
                `[Step 5]    → EMAIL: "⚠ Your Sonder position has been liquidated" → ${borrower}`
            );
        } else if (hf < WARNING_HF) {
            atRiskCount++;
            runtime.log(
                `[Step 5] 🟡 AT RISK:     ${shortAddr} — HF: ${hfFloat.toFixed(4)} | Debt: $${principalUsdc.toFixed(2)}`
            );
            runtime.log(
                `[Step 5]    → EMAIL: "⚠ Your Sonder position is at risk (HF: ${hfFloat.toFixed(4)})" → ${borrower}`
            );
        } else {
            runtime.log(
                `[Step 5] 🟢 HEALTHY:     ${shortAddr} — HF: ${hfFloat.toFixed(4)} | Debt: $${principalUsdc.toFixed(2)}`
            );
        }
    }

    runtime.log(
        `[Step 5] Summary: ${BORROWERS_TO_MONITOR.length} borrower(s) checked — ${liquidatableCount} liquidatable, ${atRiskCount} at risk`
    );

    // ─── Step 6: Report ────────────────────────────────────────────────────
    runtime.log("[Step 6] CRE cycle complete ✓");
    runtime.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return `price=${price6dec},prevPrice=${prevPrice6dec},anomaly=${anomalyDetected ? 1 : 0},drop=${(priceSwing * 100).toFixed(2)}%,liquidatable=${liquidatableCount},atRisk=${atRiskCount}`;
}
