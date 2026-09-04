/**
 * HedgePulse AI - Market Maker Test Runner
 * 
 * Supports both dry-run simulation mode (safe default) and live testnet execution.
 * 
 * Usage:
 *   npm run test:mm               # Runs in --dry-run mode
 *   npx tsx src/agent/testMarketMaker.ts --dry-run
 *   npx tsx src/agent/testMarketMaker.ts --live --size 2
 */

import { DreamDexMarketMaker, ONE } from "./marketMaker.js";

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");
  const dryRun = !isLive || args.includes("--dry-run");

  const sizeArgIdx = args.indexOf("--size");
  const sizeNum = sizeArgIdx !== -1 && args[sizeArgIdx + 1] ? Number(args[sizeArgIdx + 1]) : 2;
  const orderQuantity = BigInt(Math.round(sizeNum * 1_000_000));

  console.log("=========================================================");
  console.log(`  HedgePulse AI - Autonomous Market Maker Verification   `);
  console.log(`  Mode: ${dryRun ? "DRY-RUN (Simulation Only)" : "LIVE TESTNET EXECUTION"} `);
  console.log(`  Order Size: ${sizeNum} tUSDC (${orderQuantity} base units)`);
  console.log("=========================================================\n");

  const mm = new DreamDexMarketMaker({
    spreadBps: 180, // 180 bps full spread (+/- 90 bps)
    orderQuantity,
    volatility: 0.60,
    dryRun,
  });

  // Step 1: Discover Active Target Pool
  console.log("[1/5] Discovering active DreamDEX binary pool on Shannon testnet...");
  const poolParams = await mm.discoverActivePool("BTC");
  console.log("  Pool Discovered:");
  console.log(`  - Market ID:       ${poolParams.marketId}`);
  console.log(`  - Pool Address:    ${poolParams.poolAddress}`);
  console.log(`  - Underlying Asset: ${poolParams.asset}`);
  console.log(`  - Strike Price:    $${poolParams.strike.toLocaleString()}`);
  console.log(`  - Expiry:          ${new Date(poolParams.expiryTimestamp * 1000).toISOString()} (in ${Math.round((poolParams.expiryTimestamp - Math.floor(Date.now() / 1000)) / 60)} min)`);
  console.log(`  - Grid Params:     tickSize=${poolParams.tickSize}, lotSize=${poolParams.lotSize}, minQuantity=${poolParams.minQuantity}`);
  console.log(`  - Collateral:      ${poolParams.collateralAddress}`);
  console.log(`  - Status:          ${poolParams.clobStatus}`);

  // Step 2: Check Collateral & Allowance
  console.log("\n[2/5] Checking collateral (tUSDC) balance & router allowance...");
  const collCheck = await mm.checkCollateralAndAllowance(orderQuantity);
  console.log(`  - Account Balance:   ${Number(collCheck.balance) / 1e6} tUSDC`);
  console.log(`  - Pool Allowance:    ${Number(collCheck.allowance) / 1e6} tUSDC`);
  console.log(`  - Sufficient Funds:  ${collCheck.hasSufficientBalance ? "YES" : "NO"}`);
  console.log(`  - Approved:          ${collCheck.hasSufficientAllowance ? "YES" : "NO"}`);

  // Step 3: Complete-Set Minting
  console.log("\n[3/5] Testing Complete-Set Collateral Management (1 tUSDC -> 1 YES + 1 NO)...");
  const mintResult = await mm.mintCompleteSet(orderQuantity);
  console.log(`  - Mint Result: Amount=${Number(mintResult.amount) / 1e6}, TxHash=${mintResult.hash}`);

  // Step 4: Two-Sided Post-Only Quoting Engine
  console.log("\n[4/5] Executing Two-Sided Post-Only Quoting Engine (180 bps spread)...");
  const quoteResult = await mm.postTwoSidedQuotes();
  console.log("  Theoretical Pricing Outputs:");
  console.log(`  - Black-Scholes Fair P(YES): ${(quoteResult.pricing.fairProbabilityYes * 100).toFixed(2)}% (${quoteResult.pricing.priceYes})`);
  console.log(`  - Black-Scholes Fair P(NO):  ${(quoteResult.pricing.fairProbabilityNo * 100).toFixed(2)}% (${quoteResult.pricing.priceNo})`);
  console.log(`  - Option Greeks: Delta=${quoteResult.pricing.greeks.delta.toExponential(3)}, Vega=${quoteResult.pricing.greeks.vega.toFixed(4)}, Theta=${quoteResult.pricing.greeks.theta.toExponential(3)}/s`);
  console.log("  Order Book Snapped Quotes:");
  console.log(`  - YES Bid: ${quoteResult.quotes.yesBid} | YES Ask: ${quoteResult.quotes.yesAsk} (Spread: ${quoteResult.quotes.halfSpreadBps * 2} bps)`);
  console.log(`  - NO  Bid: ${quoteResult.quotes.noBid} | NO  Ask: ${quoteResult.quotes.noAsk}`);

  // Step 5: Verify Order Replacement / Stale Drift Handling
  console.log("\n[5/5] Verifying Stale Order Cancellation on Price Drift...");
  const simulatedDriftPrice = quoteResult.pricing.priceYes + poolParams.tickSize * 3n;
  const cancelled = await mm.cancelStaleOrders(simulatedDriftPrice);
  console.log(`  - Drift Simulation: Price shifted by +3 ticks. Cancelled ${cancelled} stale order(s).`);

  console.log("\n=========================================================");
  console.log("  [SUCCESS] Module 2: Market Maker Verification Complete!");
  console.log("=========================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[ERROR] Market maker test failed:", err);
  process.exit(1);
});
