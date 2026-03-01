import { type Runtime, HTTPClient, type HTTPSendRequester, consensusIdenticalAggregation } from "@chainlink/cre-sdk";

type AnomalyContext = {
    marketId: string;
    currentPrice: number;
    previousPrice: number;
    priceDrop: number;
    geminiModel: string;
    recentComments: Array<{ body: string; createdAt: string; author: string }>;
};

export type AIDecision = {
    recommendation: "LIQUIDATE" | "MONITOR" | "HOLD";
    confidence: number; // 0–1
    reason: string;
    groundingSources?: string[];
    searchQueries?: string[];
    ranBy: "CRE" | "WATCHER"; // identifies which runner produced the verdict
};

type Config = Record<string, string>;

/**
 * AI Guardian — Gemini with Google Search Grounding, run inside CRE.
 *
 * Uses the correct CRE HTTP pattern:
 *   httpClient.sendRequest(runtime, callbackFn, consensusAggregation)
 * and base64-encodes the request body as required by CRE's HTTP capability.
 *
 * Secret: "GEMINI_API_KEY" maps to envVar GEMINI_API_KEY in secrets.yaml.
 */
export async function analyzeAnomaly(
    runtime: Runtime<Config>,
    context: AnomalyContext
): Promise<AIDecision> {
    const httpClient = new HTTPClient();

    // ─── Step A: Log the input signals ───────────────────────────────────
    runtime.log("[AI Guardian] ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓");
    runtime.log("[AI Guardian] ┃  ANOMALY ANALYSIS PIPELINE  [CRE] ┃");
    runtime.log("[AI Guardian] ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛");
    runtime.log(`[AI Guardian] Step A │ Price Signal`);
    runtime.log(`[AI Guardian]         ├ Previous:  $${context.previousPrice.toFixed(4)} (${(context.previousPrice * 100).toFixed(1)}%)`);
    runtime.log(`[AI Guardian]         ├ Current:   $${context.currentPrice.toFixed(4)} (${(context.currentPrice * 100).toFixed(1)}%)`);
    runtime.log(`[AI Guardian]         └ Swing:     ${(context.priceDrop * 100).toFixed(2)}% ⚠️ ANOMALY THRESHOLD CROSSED`);

    // ─── Step B: Summarise community comments ──────────────────────────
    runtime.log(`[AI Guardian] Step B │ Community Signals from Polymarket Gamma API`);
    if (context.recentComments.length === 0) {
        runtime.log(`[AI Guardian]         └ No comments available`);
    } else {
        runtime.log(`[AI Guardian]         ├ ${context.recentComments.length} comments fetched`);
        context.recentComments.slice(0, 3).forEach((c, i) => {
            const preview = c.body.length > 80 ? c.body.slice(0, 80) + "..." : c.body;
            const isLast = i === Math.min(2, context.recentComments.length - 1);
            runtime.log(`[AI Guardian]         ${isLast ? "└" : "├"} [${c.createdAt.slice(0, 10)}] ${c.author}: "${preview}"`);
        });
        if (context.recentComments.length > 3) {
            runtime.log(`[AI Guardian]           (+ ${context.recentComments.length - 3} more)`);
        }
    }

    // ─── Step C: Build prompt ─────────────────────────────────────────
    const prompt = buildPrompt(context);
    runtime.log(`[AI Guardian] Step C │ Prompt Built`);
    runtime.log(`[AI Guardian]         ├ Model:    ${context.geminiModel}`);
    runtime.log(`[AI Guardian]         ├ Tool:     googleSearch (grounding enabled)`);
    runtime.log(`[AI Guardian]         └ Signals:  ${(context.priceDrop * 100).toFixed(2)}% swing + ${context.recentComments.length} community comments`);

    // ─── Step D: Call Gemini via CRE HTTP capability ──────────────────
    runtime.log(`[AI Guardian] Step D │ Calling Gemini API via CRE HTTP Capability...`);

    try {
        // Get secret using the GEMINI_API_KEY id that maps in secrets.yaml
        const apiKeySecret = runtime.getSecret({ id: "GEMINI_API_KEY" }).result();
        const geminiApiKey = apiKeySecret.value;
        runtime.log(`[AI Guardian]         ├ Secret retrieved: ${geminiApiKey ? `✓ (${geminiApiKey.length} chars)` : "✗ EMPTY"}`);

        // Use key in URL (more reliable than header through CRE HTTP proxy)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${context.geminiModel}:generateContent?key=${geminiApiKey}`;

        const requestPayload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 },
            tools: [{ google_search: {} }],
        };

        // CRE HTTP capability requires the body to be base64-encoded
        const bodyBytes = new TextEncoder().encode(JSON.stringify(requestPayload));
        const body = Buffer.from(bodyBytes).toString("base64");

        // Use the correct CRE pattern: sendRequest(runtime, callbackFn, consensus)
        const responseBody = httpClient
            .sendRequest(
                runtime,
                (sendRequester: HTTPSendRequester) => {
                    const res = sendRequester
                        .sendRequest({
                            url: geminiUrl,
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                            },
                            body,
                        })
                        .result();
                    const statusCode = res.statusCode ?? 0;
                    const bodyText = new TextDecoder().decode(res.body);
                    // Embed status in the response so we can check it outside
                    return JSON.stringify({ _statusCode: statusCode, _body: bodyText });
                },
                consensusIdenticalAggregation<string>()
            )()
            .result();

        // Extract status and body from the wrapper
        const wrapper = JSON.parse(responseBody) as { _statusCode: number; _body: string };
        runtime.log(`[AI Guardian]         ├ HTTP Status: ${wrapper._statusCode}`);
        runtime.log(`[AI Guardian]         ├ Response body (first 300 chars): ${wrapper._body.slice(0, 300)}`);

        if (wrapper._statusCode >= 400 || !wrapper._body) {
            throw new Error(`Gemini API returned HTTP ${wrapper._statusCode}: ${wrapper._body.slice(0, 200)}`);
        }

        // ─── Step E: Parse response + grounding metadata ────────────────
        const parsed = JSON.parse(wrapper._body) as {
            candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                groundingMetadata?: {
                    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
                    webSearchQueries?: string[];
                };
            }>;
        };

        const candidate = parsed?.candidates?.[0];
        // Gemini may return prose + JSON when search grounding is active
        const rawText = candidate?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
        runtime.log(`[AI Guardian]         ├ Raw text (first 200 chars): ${rawText.slice(0, 200)}`);

        // Try to extract JSON from the response — Gemini may wrap it in prose
        let decision: Partial<AIDecision> = {};
        try {
            decision = JSON.parse(rawText) as Partial<AIDecision>;
        } catch {
            // Fallback: try to find JSON object in the prose
            const jsonMatch = rawText.match(/\{[\s\S]*?"recommendation"[\s\S]*?\}/);
            if (jsonMatch) {
                try { decision = JSON.parse(jsonMatch[0]) as Partial<AIDecision>; } catch { /* ignore */ }
            }
        }

        const meta = candidate?.groundingMetadata;
        const searchQueries = meta?.webSearchQueries ?? [];
        const sources = (meta?.groundingChunks ?? [])
            .map(c => c.web?.title ? `${c.web.title} (${c.web.uri})` : c.web?.uri ?? "")
            .filter(Boolean)
            .slice(0, 5);

        runtime.log(`[AI Guardian] Step E │ Gemini Response Received`);
        if (searchQueries.length > 0) {
            runtime.log(`[AI Guardian]         ├ Google Search Queries issued by Gemini:`);
            searchQueries.forEach((q, i) => {
                const isLast = i === searchQueries.length - 1 && sources.length === 0;
                runtime.log(`[AI Guardian]         ${isLast ? "└" : "├"}   🔍 "${q}"`);
            });
        } else {
            runtime.log(`[AI Guardian]         ├ No search queries issued`);
        }
        if (sources.length > 0) {
            runtime.log(`[AI Guardian]         ├ Grounding Sources Used:`);
            sources.forEach((s, i) => {
                runtime.log(`[AI Guardian]         ${i === sources.length - 1 ? "└" : "├"}   📰 ${s}`);
            });
        }

        // ─── Step F: Final Verdict ────────────────────────────────────────
        const rec = decision.recommendation ?? "MONITOR";
        const conf = decision.confidence ?? 0.5;
        const reason = decision.reason ?? "No analysis available.";
        const emoji = rec === "LIQUIDATE" ? "🔴" : rec === "MONITOR" ? "🟡" : "🟢";

        runtime.log(`[AI Guardian] Step F │ Verdict  [ran by: CRE]`);
        runtime.log(`[AI Guardian]         ├ ${emoji} Recommendation: ${rec}`);
        runtime.log(`[AI Guardian]         ├ Confidence:     ${(conf * 100).toFixed(0)}%`);
        runtime.log(`[AI Guardian]         └ Reason:         ${reason}`);
        runtime.log("[AI Guardian] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ (end)");

        return { recommendation: rec, confidence: conf, reason, groundingSources: sources, searchQueries, ranBy: "CRE" };

    } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        runtime.log(`[AI Guardian] Step E │ ⚠ Gemini API call failed`);
        runtime.log(`[AI Guardian]         └ Error: ${errMsg.slice(0, 150)}`);
        runtime.log(`[AI Guardian] Step F │ Verdict (fallback)  [ran by: CRE]`);
        runtime.log(`[AI Guardian]         ├ 🟡 Recommendation: MONITOR`);
        runtime.log(`[AI Guardian]         ├ Confidence:     50%`);
        runtime.log(`[AI Guardian]         └ Reason:         AI unavailable — manual review recommended`);
        runtime.log("[AI Guardian] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ (end)");
        return { recommendation: "MONITOR", confidence: 0.5, reason: `AI unavailable: ${errMsg.slice(0, 80)}`, ranBy: "CRE" };
    }
}

function buildPrompt(ctx: AnomalyContext): string {
    const commentLines = ctx.recentComments
        .slice(0, 10)
        .map(c => `[${c.createdAt.slice(0, 10)}] ${c.author}: ${c.body}`)
        .join("\n");

    return `You are a DeFi risk analyst monitoring a Polymarket prediction market collateral position.

PRICE SIGNAL:
- Market ID: ${ctx.marketId}
- Previous YES token price: $${ctx.previousPrice.toFixed(4)} (${(ctx.previousPrice * 100).toFixed(1)}% implied probability)
- Current YES token price:  $${ctx.currentPrice.toFixed(4)} (${(ctx.currentPrice * 100).toFixed(1)}% implied probability)
- Price swing: ${(ctx.priceDrop * 100).toFixed(2)}% (anomaly threshold crossed)

COMMUNITY COMMENTS FROM POLYMARKET (${ctx.recentComments.length} total):
${commentLines || "(no comments available)"}

TASK:
Use Google Search to verify whether this price move is justified by real-world news.
Determine whether the lending protocol should liquidate the YES-token collateral.

Respond ONLY with valid JSON (no markdown, no prose):
{"recommendation":"LIQUIDATE"|"MONITOR"|"HOLD","confidence":0.0-1.0,"reason":"<one concise sentence>"}`;
}
