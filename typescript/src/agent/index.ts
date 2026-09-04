/**
 * HedgePulse AI - Module 5: Reactive Orchestration Loop
 * 
 * Autonomous Market-Making & DeFi Liquidation Hedging Bot
 * Running on Somnia Shannon Testnet & DreamDEX Event Contracts CLOB.
 * 
 * Core Lifecycle:
 * 1. Discover active binary event pool & market parameters (BTC/USDC).
 * 2. Monitor SomniaLend collateral health; execute Downside (NO) IOC hedge if HF < 1.20.
 * 3. Calculate Black-Scholes fair probability \Phi(d_2) & submit two-sided PostOnly quotes.
 * 4. Monitor pool resolution, redeem winning tokens 1:1, and recycle collateral.
 * 5. Handle SIGINT/SIGTERM gracefully: purge resting maker orders on shutdown.
 */

import { DreamDexMarketMaker } from "./marketMaker.js";
import { HealthShield } from "./healthShield.js";
import { DreamDexSettler } from "./settler.js";
import { ex, me, COLLATERAL } from "../client.mjs";

interface AgentArgs {
  dryRun: boolean;
  pollIntervalMs: number;
  mockHF?: number;
  spreadBps: number;
  size: number;
}

function parseArgs(): AgentArgs {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");
  const dryRun = !isLive || args.includes("--dry-run");

  const intervalIdx = args.indexOf("--poll-interval");
  const pollIntervalMs = intervalIdx !== -1 && args[intervalIdx + 1] ? Number(args[intervalIdx + 1]) : 5000;

  const mockHfIdx = args.indexOf("--mock-hf");
  const mockHF = mockHfIdx !== -1 && args[mockHfIdx + 1] ? Number(args[mockHfIdx + 1]) : undefined;

  const spreadIdx = args.indexOf("--spread");
  const spreadBps = spreadIdx !== -1 && args[spreadIdx + 1] ? Number(args[spreadIdx + 1]) : 180;

  const sizeIdx = args.indexOf("--size");
  const size = sizeIdx !== -1 && args[sizeIdx + 1] ? Number(args[sizeIdx + 1]) : 2;

  return { dryRun, pollIntervalMs, mockHF, spreadBps, size };
}

export class HedgePulseAgent {
  public config: AgentArgs;
  public marketMaker: DreamDexMarketMaker;
  public healthShield: HealthShield;
  public settler: DreamDexSettler;
  public isRunning: boolean = false;
  public cycleCount: number = 0;
  public cumulativeVolumeUSD: number = 0;

  constructor(config: AgentArgs) {
    this.config = config;
    const orderQuantity = BigInt(Math.round(config.size * 1_000_000));

    this.marketMaker = new DreamDexMarketMaker({
      spreadBps: config.spreadBps,
      orderQuantity,
      dryRun: config.dryRun,
    });

    this.healthShield = new HealthShield({
      dryRun: config.dryRun,
    });

    this.settler = new DreamDexSettler({
      dryRun: config.dryRun,
    });
  }

  /**
   * Safe Shutdown Handler: Cancels all resting maker orders on exit.
   */
  public async handleShutdown() {
    console.log(`\n[Agent] Initiating graceful shutdown...`);
    this.isRunning = false;

    if (this.marketMaker.poolParams && this.marketMaker.activeOrders.size > 0) {
      console.log(`[Agent] Cancelling ${this.marketMaker.activeOrders.size} active resting orders...`);
      const pool = this.marketMaker.poolParams.poolAddress;

      for (const [side, order] of this.marketMaker.activeOrders.entries()) {
        if (!this.config.dryRun) {
          try {
            await ex.trader.cancelOrder({ pool, orderId: order.orderId });
            console.log(`[Agent] Cancelled ${side} (orderId=${order.orderId})`);
          } catch (e: any) {
            console.warn(`[Agent] Cancel failed for ${side}: ${e.message}`);
          }
        } else {
          console.log(`[DRY-RUN] Cancelled ${side} (orderId=${order.orderId})`);
        }
      }
      this.marketMaker.activeOrders.clear();
    }

    console.log(`[Agent] Liquidity cleaned up. HedgePulse AI shut down safely.`);
    process.exit(0);
  }

  /**
   * Main Autonomous Reactive Loop
   */
  public async start() {
    this.isRunning = true;

    // Attach signal listeners for safe shutdown
    process.on("SIGINT", () => this.handleShutdown());
    process.on("SIGTERM", () => this.handleShutdown());

    console.log(`=====================================================================`);
    console.log(`   HedgePulse AI - Autonomous Market Making & DeFi Health Shield     `);
    console.log(`   Network: Somnia Shannon Testnet (Chain ID 50312)                  `);
    console.log(`   Operator / Account: ${me}`);
    console.log(`   Collateral:         ${COLLATERAL}`);
    console.log(`   Mode:               ${this.config.dryRun ? "DRY-RUN (Simulation)" : "LIVE TESTNET EXECUTION"}`);
    console.log(`   Loop Interval:      ${this.config.pollIntervalMs} ms`);
    console.log(`=====================================================================\n`);

    // Initial setup: check collateral balance
    try {
      const pool = await this.marketMaker.discoverActivePool("BTC");
      this.settler.trackMarket(pool.marketId, pool.poolAddress, this.marketMaker.config.orderQuantity);

      const collCheck = await this.marketMaker.checkCollateralAndAllowance();
      console.log(`[Init] Collateral Balance: ${Number(collCheck.balance) / 1e6} tUSDC | Allowance: ${Number(collCheck.allowance) / 1e6}`);

      // Ensure complete sets are available in inventory
      await this.marketMaker.mintCompleteSet(this.marketMaker.config.orderQuantity);
    } catch (e: any) {
      console.warn(`[Init] Pool initialization warning: ${e.message}`);
    }

    console.log(`\n[Agent] Starting reactive event loop. Press Ctrl+C to terminate cleanly.\n`);

    while (this.isRunning) {
      this.cycleCount++;
      const cycleStart = Date.now();

      try {
        console.log(`---------------------------------------------------------------------`);
        console.log(`[Tick #${this.cycleCount}] ${new Date().toISOString()}`);

        // Step 1: Synchronize Market Parameters
        const pool = await this.marketMaker.discoverActivePool("BTC");
        this.settler.trackMarket(pool.marketId, pool.poolAddress);
        const spot = await this.marketMaker.getSpotPrice(pool.asset);
        const now = Math.floor(Date.now() / 1000);
        const timeToExpiry = Math.max(0, pool.expiryTimestamp - now);

        console.log(`[Market] ${pool.asset} Spot: $${spot.toLocaleString()} | Strike: $${pool.strike.toLocaleString()} | Expiry: ${Math.round(timeToExpiry / 60)}m left`);

        // Step 2: Health Shield Inspection
        const health = await this.healthShield.getAccountHealth(me, this.config.mockHF);
        console.log(`[Shield] Health Factor: ${health.healthFactor === Infinity ? "Infinite" : health.healthFactor.toFixed(3)} | Status: [${health.status}]`);

        if (health.healthFactor < this.healthShield.config.hedgeTriggerThreshold) {
          console.log(`🚨 [HEDGE TRIGGER] Health factor below 1.20! Executing Downside Event Contract Shield...`);
          const hedgeResult = await this.healthShield.evaluateAndHedge(this.config.mockHF);
          if (hedgeResult) {
            this.cumulativeVolumeUSD += Number(hedgeResult.quantity) / 1e6;
          }
        }

        // Step 3: Market Maker Two-Sided Quoting
        const quotesResult = await this.marketMaker.postTwoSidedQuotes();
        this.cumulativeVolumeUSD += this.config.size * 2; // Bid + Ask volume

        // Step 4: Settlement & Capital Recycling Sweep
        if (timeToExpiry <= 0) {
          console.log(`[Settler] Market window reached expiry. Sweeping resolutions...`);
          await this.settler.sweep();
        }

        // Step 5: Telemetry Status Line
        console.log(`[Telemetry] Fair P(YES)=${(quotesResult.pricing.fairProbabilityYes * 100).toFixed(1)}% | Active Orders: ${this.marketMaker.activeOrders.size} | Cumulative Volume: $${this.cumulativeVolumeUSD.toFixed(2)} USD`);

      } catch (e: any) {
        console.error(`[Agent] Error during loop tick #${this.cycleCount}:`, e.shortMessage || e.message || e);
      }

      const elapsed = Date.now() - cycleStart;
      const sleepTime = Math.max(500, this.config.pollIntervalMs - elapsed);
      await new Promise((r) => setTimeout(r, sleepTime));
    }
  }
}

// Direct Execution Entry
const agentArgs = parseArgs();
const agent = new HedgePulseAgent(agentArgs);
agent.start().catch((err) => {
  console.error("[FATAL] Agent crashed:", err);
  process.exit(1);
});
