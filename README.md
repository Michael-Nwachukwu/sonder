# Sonder — AI-Powered Prediction Market Lending Protocol

> — *Where Polymarket meets DeFi lending, secured by Chainlink's decentralized oracle network and Google Gemini AI.*

![Sonder Banner](https://img.shields.io/badge/Chainlink-CRE-375BD2?style=for-the-badge&logo=chainlink&logoColor=white)
![Polygon](https://img.shields.io/badge/Polygon-8247E5?style=for-the-badge&logo=polygon&logoColor=white)
![Gemini AI](https://img.shields.io/badge/Google_Gemini-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Foundry](https://img.shields.io/badge/Foundry-0C0C0C?style=for-the-badge)
![Tenderly](https://img.shields.io/badge/Tenderly-0C0C0C?style=for-the-badge)


Tender virtual testnet explorer - <https://dashboard.tenderly.co/explorer/vnet/33d60b33-6396-4890-9faf-c352e608431b/transactions>

---

## 🔍 What is Sonder?

Sonder is a **decentralized lending protocol** that allows users to borrow USDC against their **Polymarket prediction market shares** (YES/NO tokens) as collateral.

Typically, prediction market shares (ERC-1155) are vault shares minted to the bettor in exchange for their USDC. This is a great model, but the only problem is that most prediction markets often take a long while before they are resolved, thats USD value locked for that same amount of time. One of the most popular markets right now on Polymarket is "Democratic Presidential Nominee 2028" with $758M Vol locked resolves Nov 7, 2028. That is $758M locked away from circulation for about 2 years. 

With select markets live on the protocol currently it allows shareholders of select market borrow up to 40% of the value of the shares they hold. 

Sonder's is powered by an **autonomous, AI-powered risk engine** — built entirely on **Chainlink's CRE (Compute Runtime Environment)** and **Google Gemini AI**. There is no centralized backend server. No manually-run bot with a hot private key.

### What Chainlink CRE Does in Sonder

CRE is the **automation and intelligence layer** of the protocol. It is a Decentralized Oracle Network that compiles TypeScript workflows into WebAssembly and runs them across multiple independent Chainlink nodes, reaching consensus before writing anything on-chain. Here is precisely what CRE handles in Sonder:

| CRE Responsibility | How |
|---|---|
| **Fetches live Polymarket prices** | HTTPClient calls the Polymarket CLOB API inside the DON — no centralized server needed |
| **Reads on-chain state** | EVMClient reads the current oracle price from `PriceOracle.sol` with a DON-verified contract call |
| **Writes price on-chain — DON signed** | EVMClient encodes and broadcasts `updatePrice()` with a report signed by the oracle network, not a single wallet |
| **Orchestrates the AI Guardian pipeline** | Detects price swing anomalies and calls Google Gemini API (with Polymarket comments in context) entirely within the workflow |
| **Monitors borrower health factors** | Calls `getHealthFactor()` for each borrower on every cycle — no off-chain tracking database needed |
| **Manages secrets securely** | API keys (Gemini, Polymarket) are injected by the DON at runtime — never exposed on-chain or in source code |

In short: **CRE is the autonomous heartbeat of Sonder.** Every N minutes it wakes up, reads the market, updates the oracle, analyzes the risk, and reports positions — all in a single decentralized, consensus-verified execution cycle.

---

## 🏗️ Architecture Overview

```
╔══════════════════════════════════════════════════════════════════════╗
║                          SONDER ARCHITECTURE                          ║
╚══════════════════════════════════════════════════════════════════════╝

  ┌─────────────────────┐       ┌────────────────────────────────────┐
  │   Polymarket CLOB   │       │      Chainlink CRE Workflow         │
  │  (price feed API)   │──────>│  (Decentralized Oracle Network)    │
  └─────────────────────┘  HTTP └────────────────┬───────────────────┘
                                                  │ EVM Write (DON signed)
                                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                  POLYGON (Tenderly Virtual Testnet)              │
  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
  │  │  PriceOracle │   │ MarketRegistry│  │      LendingPool     │ │
  │  │  .sol        │   │  .sol        │   │  .sol                │ │
  │  │              │   │              │   │  - borrow()          │ │
  │  │ REAL/MOCK    │   │ LTV configs  │   │  - repay()           │ │
  │  │ mode oracle  │   │ markets      │   │  - checkHealthFactor │ │
  │  └──────┬───────┘   └──────────────┘   │  - liquidate()       │ │
  │         │ getPrice()                    └──────────┬───────────┘ │
  │         └──────────────────────────────────────────┘            │
  │                          Vault.sol                              │
  │               (ERC1155 collateral custody)                      │
  └─────────────────────────────────────────────────────────────────┘
           ▲                               │
           │ Events/State                  │ Liquidation triggers
           │                               ▼
  ┌─────────────────────┐       ┌────────────────────────────────────┐
  │   watcher.ts daemon │       │  AI Guardian (aiGuardian.ts)       │
  │  - every 60s        │       │  - Google Gemini API               │
  │  - runs CRE sim     │       │  - Google Search grounding         │
  │  - email alerts     │       │  - Community comment analysis      │
  │  - health checks    │       │  - Structured JSON decision output  │
  └─────────────────────┘       └────────────────────────────────────┘
```

---

## 🔄 CRE Workflow — The Heart of Sonder

Chainlink's **CRE (Compute Runtime Environment)** is the backbone of Sonder's autonomous risk management. The workflow is a TypeScript program compiled to WebAssembly and executed across Chainlink's Decentralized Oracle Network, providing **tamper-proof, consensus-verified** off-chain computation and on-chain writes.

### How CRE Fits In

Traditional lending protocols need centralized backend servers to monitor prices and trigger risk actions. With CRE:

- **No centralized server needed.** The logic runs on Chainlink's DON.
- **On-chain writes are DON-signed.** The oracle network reaches consensus on what to write on-chain before the transaction hits Polygon.
- **Secrets are managed by CRE.** API keys (Gemini, Polymarket) are injected securely by the DON without exposing them on-chain.
- **Cron trigger.** The workflow runs on a configurable schedule — no manual invocation needed.

### CRE Workflow File Structure

```
sonder-workflow/
├── main.ts               # Entry point — registers cron trigger + handler
├── cronCallback.ts        # Core 6-step pipeline logic
├── aiGuardian.ts          # Gemini AI anomaly analysis module
├── config.staging.json    # Runtime config injected by CRE
├── workflow.yaml          # CRE deployment target config
├── project.yaml           # Chain + RPC routing (maps polygon-mainnet → Tenderly)
└── secrets.yaml           # Maps env vars to CRE-managed secrets
```

### The 6-Step CRE Pipeline

Every time the cron triggers, the workflow executes this exact pipeline:

```
┌─────────────────────────────────────────────────────────────────────┐
│   CRE CRON TRIGGER (configurable schedule, e.g. every 5 minutes)   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 1: Fetch Polymarket Price  │
              │  HTTPClient.sendRequest()        │
              │  → GET /midpoint?token_id=...    │
              │  → Returns float mid-price       │
              │  → Converts to 6-decimal integer  │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 2: Read On-Chain Price     │
              │  EVMClient.callContract()         │
              │  → PriceOracle.getPrice(1)       │
              │  → ABI-decode Uint8Array response │
              │  → Compute % swing from last price│
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 3: Update Oracle On-Chain  │
              │  runtime.report() + writeReport() │
              │  → DON signs the EVM calldata    │
              │  → Broadcasts updatePrice(1, P)  │
              │  → PriceOracle persists new price │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 4: Anomaly Detection       │
              │  If swing% ≥ threshold (e.g 10%) │
              │    → Check for active borrowers  │
              │    → Fetch Polymarket comments   │
              │       (Gamma API, 20 comments)   │
              │    → AI GUARDIAN PIPELINE ──┐    │
              │         Gemini Flash 2.0    │    │
              │         + Google Search     │    │
              │         + Comment sentiment │    │
              │         → Verdict: REAL /   │    │
              │           NOISE / UNCERTAIN ◄────┘
              └────────────────┬────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 5: Health Factor Check     │
              │  EVMClient.callContract()         │
              │  → LendingPool.getHealthFactor() │
              │  → Loop through borrowers        │
              │  🟢 HF > 1.1: Healthy            │
              │  🟡 HF < 1.1: At Risk (email!)  │
              │  🔴 HF < 1.0: Liquidatable       │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  STEP 6: Return Structured Report│
              │  "price=...,anomaly=1,drop=..."  │
              │  → watcher.ts reads this output  │
              │  → Executes liquidation on-chain │
              └─────────────────────────────────┘
```

### Why CRE Was Critical

| Problem | Without CRE | With CRE |
|---|---|---|
| Price feed updates | Centralized cron server | DON-consensus EVM write |
| Secret management | Exposed in ENV or server | Encrypted CRE secret injection |
| Anomaly analysis | Manual monitoring | AI-triggered pipeline |
| On-chain writes | Centralized hot wallet | Multi-node consensus before broadcast |
| Oracle security | Single point of failure | Decentralized validators |

---

## 🤖 AI Guardian — Google Gemini Integration

When a price anomaly is detected, the workflow triggers the **AI Guardian** module (`aiGuardian.ts`), which calls the Google Gemini API with:

1. **The quantitative data**: market ID, current price, previous price, % swing.
2. **Community sentiment**: Up to 20 recent Polymarket comments fetched from the Gamma API.
3. **Google Search grounding**: Gemini searches the web in real time for news about the Polymarket event with the fetched price and comments from polymarket in context.

The AI Guardian uses a structured system prompt to force a deterministic JSON response:

```json
{
  "verdict": "REAL_ANOMALY | MARKET_NOISE | UNCERTAIN",
  "confidence": 0.0-1.0,
  "reasoning": "...",
  "action": "LIQUIDATE | MONITOR | NO_ACTION",
  "sources": ["...", "..."]
}
```

The verdict and action recommendation are logged and used by the `watcher.ts` execution arm to decide whether to proceed with on-chain liquidation.

---

## 📦 Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Decentralized Compute** | Chainlink CRE | Autonomous price monitoring, DON-signed oracle writes, AI pipeline orchestration |
| **AI Model** | Google Gemini Flash 2.5 | Anomaly analysis, verdict generation |
| **Search Grounding** | Google Search API (via Gemini) | Real-world context for AI decisions |
| **Blockchain** | Polygon (+ Tenderly Virtual Testnet) | Smart contract execution environment |
| **Smart Contracts** | Solidity + Foundry | Lending protocol, oracle, collateral vault |
| **Contract Libraries** | OpenZeppelin v5.6.0 | ERC20, ERC1155, Ownable, ReentrancyGuard |
| **Prediction Markets** | Polymarket CLOB API + Gamma API | Live YES/NO token price feed + community comments |
| **Runtime** | Bun (TypeScript) | Off-chain watcher daemon, scripts |
| **SDK** | `@chainlink/cre-sdk` v1.1.2 | CRE workflow SDK (EVMClient, HTTPClient, report/writeReport) |
| **EVM Tools** | viem, cast (Foundry) | ABI encoding/decoding, contract reads/writes |
| **Email Alerts** | Resend | Risk notification emails |
| **Dev Environment** | Tenderly Virtual TestNet | Mainnet fork for testing (Polygon, chain 999137) |

---

## 📄 Smart Contracts

All contracts are written in Solidity `^0.8.24` and deployed to the **Tenderly Virtual TestNet** (Polygon mainnet fork, Chain ID: `999137`).

### Contract System

```
PriceOracle.sol
  ├── REAL mode: reads from realPrices[] (written by CRE workflow)
  └── MOCK mode: reads from mockPrices[] (admin-set, for crash demos)

MarketRegistry.sol
  └── Stores per-market config: LTV (35%), liquidation threshold (45%),
      liquidation bonus (8%), token address, tokenId, resolution time

Vault.sol
  └── ERC1155 custodian — holds user YES/NO token collateral
      Enforces only LendingPool can seize or release collateral

LendingPool.sol
  ├── deposit() — n/a (calls Vault.deposit() directly)
  ├── borrow() — max 35% LTV, probability-based interest rate
  ├── repay() — repay all debt, return all collateral
  ├── checkAndEmitRiskEvents() — emit AtRisk / LiquidationTriggered
  └── finalizeLiquidation() — close loan after collateral seizure
```

### Interest Rate Model (Novel — Probability-Based)

Unlike Aave/Compound's utilization-based rates, Sonder uses a **probability-based interest rate** tied to the prediction market's implied outcome probability:

```
Rate = BASE_RATE + (1 - probability) × RISK_MULTIPLIER
     = 5% + (1 - P) × 20%

Examples:
  P = 0.90 (90% YES) → Rate =  7%  (low risk collateral)
  P = 0.65 (65% YES) → Rate = 12%  (moderate risk)
  P = 0.10 (10% YES) → Rate = 23%  (very risky collateral)
```

### Deployed Addresses (Tenderly, Chain 999137)

Tender virtual testnet explorer - https://dashboard.tenderly.co/explorer/vnet/33d60b33-6396-4890-9faf-c352e608431b/transactions

| Contract | Address |
|---|---|
| PriceOracle | `0x323117CE686E0FdF05546145af1078A1Eb855295` |
| MarketRegistry | `0xDb4F9Fd48FcEbc9D575147c990aB24ce45F9EE19` |
| Vault | `0xfaC4312AcA9a0527203f0d87F9E34C2ccB02fc1C` |
| LendingPool | `0x6Bf79FAEbf328B195B8910dc0bf551EE1d2e032B` |

---

## 🗂️ Repository Structure

```
sonder/
├── contracts/                    # Foundry smart contract project
│   ├── src/
│   │   ├── LendingPool.sol       # Core lending engine
│   │   ├── PriceOracle.sol       # REAL/MOCK mode price feed
│   │   ├── MarketRegistry.sol    # Market config registry
│   │   └── Vault.sol             # ERC1155 collateral custody
│   ├── test/
│   │   └── PolyLend.t.sol        # 18/18 unit tests
│   └── script/
│       └── Deploy.s.sol          # Full deploy + wire script
│
├── sonder-workflow/              # Chainlink CRE workflow (TypeScript)
│   ├── main.ts                   # Entry point, cron trigger setup
│   ├── cronCallback.ts           # 6-step autonomous pipeline
│   ├── aiGuardian.ts             # Gemini AI anomaly analysis
│   ├── config.staging.json       # Runtime configuration
│   ├── workflow.yaml             # CRE deployment targets
│   ├── project.yaml              # Chain RPC routing
│   └── secrets.yaml              # Env var → CRE secret mapping
│
├── scripts/                      # Off-chain management scripts (Bun)
│   ├── setup.ts                  # Fund wallets, whale impersonation
│   ├── demo.ts                   # Interactive 6-step demo runner
│   ├── oracle.ts                 # Manual oracle mode/price manager
│   └── watcher.ts                # Autonomous CRE watcher daemon
│
└── tasks/
    ├── todo.md                   # Project progress tracker
    └── lessons.md                # CRE SDK lessons learned
```

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- [Foundry](https://book.getfoundry.sh/getting-started/installation) — `curl -L https://foundry.paradigm.xyz | bash`
- [CRE CLI](https://docs.chain.link/cre) — `npm install -g @chainlink/cre-cli`
- A [Tenderly](https://tenderly.co/) account (free tier is fine)
- A [Google AI Studio](https://aistudio.google.com/app/apikey) key (Gemini)
- A [Resend](https://resend.com) account for email alerts (optional)

### 1. Clone and install

```bash
git clone https://github.com/Michael-Nwachukwu/sonder.git
cd sonder

# Install off-chain script dependencies
bun install

# Install CRE workflow dependencies
cd sonder-workflow && bun install && cd ..

# Install contract dependencies
cd contracts && forge install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
CRE_ETH_PRIVATE_KEY=0x...       # Your deployer wallet private key
GEMINI_API_KEY=...               # Google Gemini API key
TENDERLY_RPC_URL=https://virtual.polygon.eu.rpc.tenderly.co/YOUR_FORK_ID
POLYGON_RPC_URL=https://polygon-rpc.com

# Filled in after step 3:
PRICE_ORACLE_ADDRESS=
MARKET_REGISTRY_ADDRESS=
VAULT_ADDRESS=
LENDING_POOL_ADDRESS=

RESEND_API_KEY=re_...            # Optional: for email alerts
NOTIFY_EMAIL=you@email.com
```

Update `project.yaml` with your Tenderly RPC URL:

```yaml
staging-settings:
  rpcs:
    - chain-name: polygon-mainnet
      url: https://virtual.polygon.eu.rpc.tenderly.co/YOUR_FORK_ID
```

### 3. Deploy contracts

```bash
cd contracts

# Fund your deployer wallet on Tenderly
curl $TENDERLY_RPC_URL -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tenderly_addBalance","params":[["YOUR_WALLET_ADDRESS"],"0x56BC75E2D63100000"],"id":1}'

# Deploy all contracts
source ../.env
forge script script/Deploy.s.sol:Deploy --broadcast --slow \
  --rpc-url $TENDERLY_RPC_URL --private-key $CRE_ETH_PRIVATE_KEY

# Copy the printed contract addresses into your .env
cd ..
```

### 4. Set up the demo environment

```bash
# Fund test user wallet + transfer Polymarket YES tokens from whale
bun run scripts/setup.ts
```

### 5. Run the CRE workflow

```bash
# Simulate ONE cycle (no broadcast — dry run)
cre workflow simulate sonder-workflow

# Simulate with real on-chain writes
cre workflow simulate sonder-workflow --broadcast
```

### 6. Start the autonomous watcher daemon

```bash
# Runs CRE every 60s, monitors health factors, sends email alerts
bun run scripts/watcher.ts
```

### 7. Run the interactive demo

```bash
# Interactive 6-step demo: deposit → borrow → crash → liquidate
bun run scripts/demo.ts

# Manage oracle mode (REAL ↔ MOCK) and prices manually
bun run scripts/oracle.ts
```

---

## 🎭 Demo Flow

The full demo script (`scripts/demo.ts`) walks through the entire protocol lifecycle:

| Step | Action | What Happens |
|---|---|---|
| 1 | **Deposit Collateral** | Alice deposits 100 YES tokens into the Vault |
| 2 | **Borrow USDC** | Alice borrows USDC at 35% LTV against her YES tokens |
| 3 | **Check Health Factor** | Protocol reads HF via CRE — currently healthy (> 1.1) |
| 4 | **Crash the Oracle** | `oracle.ts crash` → sets mock price to $0.03 (95% drop) |
| 5 | **CRE Detects Anomaly** | Next CRE cycle reads the crashed price, triggers AI Guardian |
| 6 | **AI Guardian Analyzes** | Gemini searches the web, reads community comments, outputs verdict |
| 7 | **Liquidation** | HF < 1.0 → `seizeCollateral()` — Alice's YES tokens seized |
| 8 | **Email Alert** | `watcher.ts` sends liquidation email to Alice |

---

## 🔬 Contract Testing

```bash
cd contracts

# Run all tests
forge test -v

# Run with gas report
forge test --gas-report
```

**18/18 tests pass**, covering:

- Full borrow lifecycle (deposit → borrow → accrue interest → repay)
- Health factor calculations
- Liquidation triggers at correct HF thresholds
- Interest rate model (probability-based)
- Admin guards and edge cases

---

## 🌐 CRE Workflow Commands

```bash
# Run one simulation cycle (no blockchain writes)
cre workflow simulate sonder-workflow

# Run with real on-chain writes (broadcasts to Tenderly/configured RPC)
cre workflow simulate sonder-workflow --broadcast

# Deploy to Chainlink DON (requires deployment access)
cre account access
cre workflow deploy sonder-workflow
```

---

## 🔐 Security Notes

- **Oracle access control**: Only the wallet specified as `updater` (the CRE bot wallet) can call `updatePrice()`. Only the owner can call `setMode()` or `setMockPrice()`.
- **Vault isolation**: Only the `lendingPool` address can call `seizeCollateral()` or `withdraw()`.
- **Reentrancy guard**: All state-changing functions in `LendingPool` use OpenZeppelin's `ReentrancyGuard`.
- **Liquidation threshold > LTV**: The `MarketRegistry` enforces that `liquidationThreshold > maxLTV` at market creation — collateral can never be seizable before borrowing is even allowed.
- **Resolution cutoff**: No new borrows are allowed within 72 hours of a market's resolution time.

---

## 🛣️ Roadmap

| Version | Feature |
|---|---|
| **V1 (current)** | CRE oracle, AI Guardian, USDC lending, ERC1155 collateral, liquidation |
| **V2** | Aave-style open `liquidateCall()` — public liquidators earn 8% bonus |
| **V3** | Multi-market support, Polymarket CLOB liquidator bot integration |
| **V4** | Next.js frontend with live HF dashboard and wallet connection |

---

## 👥 Team

Built for the **Chainlink CRE × Google AI Hackathon**.

---

## 📜 License

MIT
