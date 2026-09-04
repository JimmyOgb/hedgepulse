/**
 * HedgePulse AI - Health Shield Test Runner & Demo Simulation Harness
 * 
 * Demonstrates:
 * 1. SomniaLend account health monitoring (Collateral, Debt, Liquidation Threshold, Health Factor)
 * 2. Alert threshold detection (HF < 1.25 Alert, HF < 1.20 Hedge Trigger, HF < 1.15 Emergency)
 * 3. Dynamic liquidation delta & downside exposure calculation
 * 4. Automated execution of IOC BUY_NO event contracts to hedge against liquidation
 * 
 * Usage:
 *   npm run test:shield                      # Runs with default simulated mock-hf 1.12 in dry-run
 *   npx tsx src/agent/testHealthShield.ts --mock-hf 1.12
 *   npx tsx src/agent/testHealthShield.ts --mock-hf 1.18
 *   npx tsx src/agent/testHealthShield.ts --live --mock-hf 1.12
 */

import { HealthShield } from "./healthShield.js";

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");
  const dryRun = !isLive || args.includes("--dry-run");

  // Parse --mock-hf argument
  const mockHfIdx = args.indexOf("--mock-hf");
  const mockHf = mockHfIdx !== -1 && args[mockHfIdx + 1] ? Number(args[mockHfIdx + 1]) : 1.12;

  console.log("=========================================================");
  console.log(`  HedgePulse AI - Health Shield (Liquidation Defense)   `);
  console.log(`  Mode:     ${dryRun ? "DRY-RUN (Simulation Only)" : "LIVE TESTNET EXECUTION"}`);
  console.log(`  Mock HF:  ${mockHf}`);
  console.log("=========================================================\n");

  const shield = new HealthShield({
    alertThreshold: 1.25,
    hedgeTriggerThreshold: 1.20,
    emergencyThreshold: 1.15,
    liquidationBonus: 0.05, // 5% penalty
    dryRun,
  });

  // Scenario 1: Baseline Safe Position Check (HF = 1.45)
  console.log("[Test 1/2] Checking Healthy Position (Simulated HF = 1.45)...");
  const safeResult = await shield.evaluateAndHedge(1.45);
  if (safeResult === null) {
    console.log("  [PASS] Safe position confirmed: Shield remained idle, no unnecessary gas spent.\n");
  } else {
    throw new Error("Shield triggered erroneously on a healthy position!");
  }

  // Scenario 2: Distressed Position Check (HF < 1.20, e.g. 1.12)
  console.log(`[Test 2/2] Simulating Underwater Loan (HF = ${mockHf} < 1.20 Threshold)...`);
  const hedgeResult = await shield.evaluateAndHedge(mockHf);

  if (hedgeResult && hedgeResult.triggered) {
    console.log("\n  [PASS] Liquidation Defense Successfully Triggered!");
    console.log("  Hedge Summary:");
    console.log(`  - Target Pool:     ${hedgeResult.pool}`);
    console.log(`  - Event Contract:  BUY_NO (Downside Protection)`);
    console.log(`  - Order Type:      IOC (Immediate-Or-Cancel, Taker)`);
    console.log(`  - Contracts:       ${Number(hedgeResult.quantity) / 1e6} contracts`);
    console.log(`  - Max Payout:      $${hedgeResult.computation.maxPayoutUSD.toFixed(2)} USD`);
    console.log(`  - Net Protection:  +$${hedgeResult.computation.netHedgeProfitUSD.toFixed(2)} USD`);
    console.log(`  - Tx Hash:         ${hedgeResult.txHash}`);
  } else {
    throw new Error(`Shield failed to trigger on distressed position (HF = ${mockHf})!`);
  }

  console.log("\n=========================================================");
  console.log("  [SUCCESS] Module 3: Health Shield Verification Complete!");
  console.log("=========================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[ERROR] Health shield test failed:", err);
  process.exit(1);
});
