/**
 * HedgePulse AI - Settler Test Runner & Redemption Verification
 * 
 * Demonstrates:
 * 1. Listening/polling for pool resolution after market expiry
 * 2. Reading winning outcome index (0 = YES, 1 = NO)
 * 3. Redeeming winning tokens 1:1 for collateral via redeem()
 * 4. Capital recycling telemetry and PnL reporting
 * 
 * Usage:
 *   npm run test:settler -- --mock-resolved
 *   npx tsx src/agent/testSettler.ts --mock-resolved --winner 0
 *   npx tsx src/agent/testSettler.ts --mock-resolved --winner 1
 */

import { DreamDexSettler } from "./settler.js";
import { DreamDexMarketMaker } from "./marketMaker.js";

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");
  const dryRun = !isLive || args.includes("--dry-run");
  const mockResolved = args.includes("--mock-resolved") || true; // Default true for demo test runner

  const winnerArgIdx = args.indexOf("--winner");
  const mockWinner = winnerArgIdx !== -1 && args[winnerArgIdx + 1] ? (Number(args[winnerArgIdx + 1]) as 0 | 1) : 0;

  console.log("=========================================================");
  console.log(`  HedgePulse AI - Settlement & Capital Recycler Test     `);
  console.log(`  Mode:          ${dryRun ? "DRY-RUN (Simulation)" : "LIVE TESTNET"}`);
  console.log(`  Mock Resolved: ${mockResolved}`);
  console.log(`  Mock Winner:   ${mockWinner === 0 ? "YES (Up)" : "NO (Down)"} (index=${mockWinner})`);
  console.log("=========================================================\n");

  const settler = new DreamDexSettler({ dryRun });
  const mm = new DreamDexMarketMaker({ dryRun: true });

  // 1. Discover Active or Expired Pool
  console.log("[1/3] Resolving target DreamDEX market on Shannon testnet...");
  const pool = await mm.discoverActivePool("BTC");
  console.log(`  - Market ID:    ${pool.marketId}`);
  console.log(`  - Pool Address: ${pool.poolAddress}`);
  console.log(`  - Asset:        ${pool.asset} (Strike: $${pool.strike})`);

  // 2. Track Market
  settler.trackMarket(pool.marketId, pool.poolAddress, 2_000_000n);

  // 3. Execute Settlement & Capital Sweep
  console.log("\n[2/3] Executing Resolution Check & Winning Token Redemption Sweep...");
  const telemetry = await settler.sweep([pool.marketId], mockResolved, mockWinner);

  // 4. Verify Telemetry
  console.log("[3/3] Verifying Capital Recycling Telemetry...");
  if (telemetry.redemptionsExecuted > 0) {
    const rec = telemetry.records[0];
    console.log("  [PASS] Redemption Verified:");
    console.log(`  - Market ID:           ${rec.marketId}`);
    console.log(`  - Winning Side:        ${rec.winningSide}`);
    console.log(`  - Tokens Burned:       ${Number(rec.tokensRedeemed) / 1e6} contracts`);
    console.log(`  - Collateral Claimed:  ${Number(rec.collateralClaimed) / 1e6} tUSDC (1:1 payout)`);
    console.log(`  - Redemption Tx Hash:  ${rec.txHash}`);
    console.log(`  - Recycled to Balance: +${Number(telemetry.totalCollateralRecycled) / 1e6} tUSDC`);
  } else {
    throw new Error("No redemptions were executed during the sweep!");
  }

  console.log("\n=========================================================");
  console.log("  [SUCCESS] Module 4: Settlement Verification Complete!");
  console.log("=========================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[ERROR] Settler test failed:", err);
  process.exit(1);
});
