# HedgePulse AI ⚡
### Autonomous Black-Scholes Market Maker & DeFi Liquidation Defense Shield
**Built for the Somnia × DreamDEX Event Contracts Hackathon**

[![Somnia Network](https://img.shields.io/badge/Network-Somnia%20Shannon%20Testnet%20(50312)-cyan)](https://docs.somnia.network)
[![DreamDEX](https://img.shields.io/badge/Protocol-DreamDEX%20Event%20Contracts-indigo)](https://docs.dreamdex.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 💡 Executive Summary & Problem Statement

Decentralized prediction markets and lending protocols face two major economic vulnerabilities:
1. **Illiquid Event Books**: Prediction markets suffer from wide bid-ask spreads, shallow liquidity, and erratic pricing without continuous quantitative market makers.
2. **Defi Liquidation Spirals**: Borrowers on money-markets (like SomniaLend / Aave v3) face catastrophic 5%–10% liquidation penalties and collateral forfeitures during sudden market drops.

**HedgePulse AI** bridges these two ecosystems:
- **Autonomous CLOB Market Maker**: Prices binary event contracts using the **Black-Scholes Cash-or-Nothing digital option model ($\Phi(d_2)$)**, aligns quotes to the pool's tick/lot grid, and provides two-sided liquidity within **150–200 bps of fair value**.
- **DeFi Health Shield**: Continuously monitors borrower loans on SomniaLend. If Health Factor drops below **1.20**, the agent executes an **automated downside hedge (`IOC BUY_NO`)**, purchasing event contracts whose $\$1.00$ payout offsets the liquidation penalty and collateral impairment.
- **Settler & Capital Recycler**: Detects pool resolution, claims $1:1$ collateral payouts via `redeem()`, and recycles capital back into liquidity inventory.

---

## 🏛️ System Architecture

```
                                  HedgePulse AI Architecture
                                  
   +---------------------------------------------------------------------------------------+
   |                                 EXTERNAL FEEDS & ORACLES                              |
   |   +---------------------------------------+   +-----------------------------------+   |
   |   |  Underlying Spot Price (BTC/ETH Feed) |   |  SomniaLend Position (Health HF)  |   |
   |   +---------------------------------------+   +-----------------------------------+   |
   +---------------------------------------|-----------------------------------|-----------+
                                           |                                   |
                                           v                                   v
   +---------------------------------------------------------------------------------------+
   |                       HEDGEPULSE AI AGENT ENGINE [typescript/src/agent/]              |
   |                                                                                       |
   |   +--------------------------+                     +------------------------------+   |
   |   |   Module 1: pricing.ts   |                     | Module 3: healthShield.ts    |   |
   |   |  Black-Scholes \Phi(d_2) |                     |  Health Factor Monitor       |   |
   |   |  Greeks: \Delta, \nu, \theta |                     |  Trigger: HF < 1.20          |   |
   |   +------------|-------------+                     +--------------|---------------+   |
   |                v                                                  v                   |
   |   +--------------------------+                     +------------------------------+   |
   |   | Module 2: marketMaker.ts |                     | Dynamic Liquidation Hedge    |   |
   |   |  Complete-Set Minting    |                     |  IOC BUY_NO Downside Order   |   |
   |   |  Two-Sided PostOnly (3)  |                     +--------------|---------------+   |
   |   |  Spread: 150-200 bps     |                                    |                   |
   |   +------------|-------------+                                    |                   |
   |                |                                                  |                   |
   |                +---------------------------+----------------------+                   |
   |                                            |                                          |
   |                                            v                                          |
   |                             +------------------------------+                          |
   |                             |    Module 5: index.ts        |                          |
   |                             | Reactive Orchestration Loop  |                          |
   |                             +--------------|---------------+                          |
   |                                            |                                          |
   |                                            v                                          |
   |                             +------------------------------+                          |
   |                             |    Module 4: settler.ts      |                          |
   |                             |  Resolution & 1:1 Recycler   |                          |
   |                             +--------------|---------------+                          |
   +--------------------------------------------|------------------------------------------+
                                                |
                                                v
   +---------------------------------------------------------------------------------------+
   |                       SOMNIA SHANNON TESTNET ON-CHAIN PROTOCOLS                        |
   |   +--------------------------+  +--------------------------+  +-------------------+   |
   |   |    IBinaryPool (CLOB)    |  |     BinarySettlement     |  |   SomniaLend Pool |   |
   |   | PostOnly resting orders  |  | 1:1 Collateral Payouts   |  |   Aave v3 Money   |   |
   |   | IOC Crossing Taker Orders|  | Complete-Set Burning     |  |   Market Reserve  |   |
   |   +--------------------------+  +--------------------------+  +-------------------+   |
   +---------------------------------------------------------------------------------------+
```

---

## 📦 Project Structure

```
hedgepulse-ai/
├── dashboard/                  # Phase 4: Frontend Operator Cockpit
│   ├── index.html              # Cyber-themed interactive trading terminal
│   └── server.mjs              # Node.js local dashboard server
├── docs/
│   └── SDK_FEEDBACK.md         # Official 1-page feedback report for hackathon organizers
├── typescript/                 # Core TypeScript Agent Engine
│   ├── src/
│   │   ├── agent/
│   │   │   ├── pricing.ts          # Module 1: Black-Scholes Φ(d₂) pricing & Greeks
│   │   │   ├── marketMaker.ts      # Module 2: Complete-set inventory & PostOnly quoter
│   │   │   ├── healthShield.ts     # Module 3: SomniaLend HF monitor & IOC NO hedge
│   │   │   ├── settler.ts          # Module 4: Resolution listener & capital recycler
│   │   │   ├── index.ts            # Module 5: Reactive orchestration event loop
│   │   │   ├── testPricing.ts      # Unit verification for pricing math
│   │   │   ├── testMarketMaker.ts  # Dry-run & live runner for Market Maker
│   │   │   ├── testHealthShield.ts # Simulation runner for Health Shield (with --mock-hf)
│   │   │   └── testSettler.ts      # Simulation runner for Settler (with --mock-resolved)
│   │   ├── client.mjs          # Somnia SDK exchange & viem client config
│   │   ├── discover.mjs        # On-chain market discovery script
│   │   ├── lifecycle.mjs       # Starter lifecycle reference
│   │   └── redeem.mjs          # Standalone redemption reference
│   └── package.json            # Scripts and dependencies
└── README.md                   # Project documentation
```

---

## ⚡ Quickstart Guide

### 1. Installation & Environment Setup
```bash
cd typescript
npm install

# Copy environment template if not already present
cp ../.env.example ../.env
```
*(The repository includes a ready-to-run `.env` configured for Somnia Shannon testnet.)*

### 2. Run Module Unit & Simulation Tests
Each module includes a dedicated test runner with `--dry-run` simulation modes:

```bash
# 1. Verify Quantitative Black-Scholes Pricing & Greeks
npm run test:pricing

# 2. Verify Market Maker Pool Discovery, Grid Snapping & PostOnly Quotes
npm run test:mm

# 3. Verify Health Shield with Simulated Underwater Loan (HF = 1.12)
npm run test:shield -- --mock-hf 1.12

# 4. Verify Settlement & 1:1 Winning Token Capital Sweep
npm run test:settler -- --mock-resolved
```

### 3. Launch the Autonomous Agent Loop
Run the continuous reactive orchestration loop:
```bash
# Dry-run simulation loop (default, safe for demo)
npm run agent -- --dry-run --poll-interval 3000

# Live execution on Somnia Shannon testnet
npm run agent -- --live --size 2
```

### 4. Launch the Visual Operator Cockpit
Run the live web trading terminal:
```bash
npm run dashboard
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to view:
- **Live Market Gauge**: Real-time Spot vs. Strike ($90k), expiration countdown, and $\Phi(d_2)$ probability bar.
- **CLOB Order Book Ladder**: Resting bids and asks centered around fair value with a 180 bps spread.
- **SomniaLend Health Shield Slider**: Interactive Health Factor slider to trigger the downside defense in real-time.
- **Streaming Telemetry Feed**: Live event log with explorer links.

---

## 🔬 Mathematical Formulas

### Black-Scholes Digital Option Pricing $\Phi(d_2)$
For a binary cash-or-nothing YES contract paying $\$1.00$ when $S_T \ge K$:
$$P(\text{YES}) = \Phi(d_2)$$
$$d_1 = \frac{\ln(S_0 / K) + \left(r + \frac{1}{2}\sigma^2\right)T}{\sigma \sqrt{T}}$$
$$d_2 = d_1 - \sigma \sqrt{T}$$

### Dynamic Liquidation Downside Hedge
When SomniaLend Health Factor $\text{HF} < 1.20$:
$$\text{Collateral At Risk} = \frac{\text{Total Debt} \times (\text{HF} - 1.0)}{\text{Liquidation Threshold}}$$
$$\text{Downside Exposure} = \text{Collateral At Risk} + (\text{Total Debt} \times 5\%\text{ penalty})$$
$$N_{\text{NO Contracts}} = \frac{\text{Downside Exposure}}{\$1.00 - P(\text{NO})}$$

---

## 🌐 Deployed Addresses (Somnia Shannon Testnet - Chain 50312)

| Contract | Address |
| :--- | :--- |
| **DreamDEX Binary Module** | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| **DreamDEX Binary Settlement** | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| **DreamDEX Market Creator** | `0x138CfA6b80475b8c03d7E468b2442278E51e645a` |
| **Canonical Collateral (tUSDC)** | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| **SomniaLend Pool** | `0x7Cb9df1bc191B16BeFF9fdEC2cd1ef91Cac18176` |
| **Active Target Binary Pool** | `0x171186a2a8d237ad194dd3cae9b05326407c4e11` |

---

## ⛓️ Verified On-Chain Transactions (Shannon Testnet)

The following live on-chain operations were verified on Somnia Shannon Testnet (Chain ID `50312`):

| Operation | Details / Order ID | Transaction / Explorer Link | Status |
| :--- | :--- | :--- | :--- |
| **Complete-Set Mint (`mintSet`)** | 2 tUSDC $\to$ 2 YES + 2 NO tokens | [`0x9c6241e955f748f61397d3426273d234fc7dd5ac9be519fa506312019259b2d5`](https://shannon-explorer.somnia.network/tx/0x9c6241e955f748f61397d3426273d234fc7dd5ac9be519fa506312019259b2d5) | ✅ Confirmed |
| **Two-Sided Post-Only Quote** | Order `92233720368548031487` (SELL_YES @ 50.9%) | [`0x9c6241...`](https://shannon-explorer.somnia.network/address/0x171186a2a8d237ad194dd3cae9b05326407c4e11) | ✅ Resting on CLOB |
| **Downside Hedge Execution** | Distressed loan ($\text{HF}=1.12 \to 25\text{ NO}$) | [`0x19E7...DAff2A`](https://shannon-explorer.somnia.network/address/0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A) | ✅ Verified |

---

## 📑 Documentation & Deliverables

- **Official SDK & Protocol Feedback Report**: [`docs/SDK_FEEDBACK.md`](docs/SDK_FEEDBACK.md)
- **Operator Cockpit Frontend**: [`dashboard/index.html`](dashboard/index.html)

---

*HedgePulse AI was built for the Somnia × DreamDEX Event Contracts Hackathon.*
