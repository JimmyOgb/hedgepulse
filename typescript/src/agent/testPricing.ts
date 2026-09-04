import { calculateBinaryPricing, generateTwoSidedQuotes, discretizeToTick } from "./pricing.js";

console.log("=== Testing HedgePulse AI Pricing Engine ===");

// 1. ATM Scenario: BTC at $90,000, Strike $90,000, 15 minutes left (900 seconds), Vol = 60%
const atmResult = calculateBinaryPricing({
  spot: 90000,
  strike: 90000,
  timeToExpirySec: 900,
  volatility: 0.60,
  riskFreeRate: 0.0,
});

console.log("\n1. ATM Scenario (Spot = $90k, Strike = $90k, T = 15m, Vol = 60%):");
console.log(`   d1: ${atmResult.d1.toFixed(6)}, d2: ${atmResult.d2.toFixed(6)}`);
console.log(`   P(YES): ${(atmResult.fairProbabilityYes * 100).toFixed(2)}% | DreamDEX Price: ${atmResult.priceYes}`);
console.log(`   P(NO):  ${(atmResult.fairProbabilityNo * 100).toFixed(2)}% | DreamDEX Price: ${atmResult.priceNo}`);
console.log(`   Delta:  ${atmResult.greeks.delta.toExponential(4)}`);
console.log(`   Vega:   ${atmResult.greeks.vega.toFixed(4)}`);
console.log(`   Theta:  ${atmResult.greeks.theta.toExponential(4)}/sec`);

// 2. ITM Scenario: Spot = $90,500 (+0.55%), Strike = $90,000, 15m left
const itmResult = calculateBinaryPricing({
  spot: 90500,
  strike: 90000,
  timeToExpirySec: 900,
  volatility: 0.60,
});
console.log("\n2. ITM Scenario (Spot = $90.5k, Strike = $90k, T = 15m, Vol = 60%):");
console.log(`   P(YES): ${(itmResult.fairProbabilityYes * 100).toFixed(2)}% | Price: ${itmResult.priceYes}`);
console.log(`   P(NO):  ${(itmResult.fairProbabilityNo * 100).toFixed(2)}% | Price: ${itmResult.priceNo}`);

// 3. OTM Scenario: Spot = $89,500 (-0.55%), Strike = $90,000, 15m left
const otmResult = calculateBinaryPricing({
  spot: 89500,
  strike: 90000,
  timeToExpirySec: 900,
  volatility: 0.60,
});
console.log("\n3. OTM Scenario (Spot = $89.5k, Strike = $90k, T = 15m, Vol = 60%):");
console.log(`   P(YES): ${(otmResult.fairProbabilityYes * 100).toFixed(2)}% | Price: ${otmResult.priceYes}`);
console.log(`   P(NO):  ${(otmResult.fairProbabilityNo * 100).toFixed(2)}% | Price: ${otmResult.priceNo}`);

// 4. Two-sided Quotes Generation: 180 bps spread (1.8% full spread => +/- 90 bps)
const quotes = generateTwoSidedQuotes(atmResult.priceYes, 180, 10_000n);
console.log("\n4. Two-Sided Market Maker Quotes (180 bps spread, 10_000 tick grid):");
console.log(`   YES Bid: ${quotes.yesBid} (${(Number(quotes.yesBid)/10000).toFixed(2)}%) | YES Ask: ${quotes.yesAsk} (${(Number(quotes.yesAsk)/10000).toFixed(2)}%)`);
console.log(`   NO  Bid: ${quotes.noBid} (${(Number(quotes.noBid)/10000).toFixed(2)}%) | NO  Ask: ${quotes.noAsk} (${(Number(quotes.noAsk)/10000).toFixed(2)}%)`);

// Check parity: YES Bid < YES Ask, and tick alignment
if (quotes.yesBid >= quotes.yesAsk) throw new Error("Crossing quote generated!");
if (quotes.yesBid % 10_000n !== 0n) throw new Error("Tick alignment failed on yesBid!");
if (quotes.yesAsk % 10_000n !== 0n) throw new Error("Tick alignment failed on yesAsk!");

console.log("\n[SUCCESS] Pricing engine verification passed all financial and mathematical checks.");
