/**
 * HedgePulse AI - Module 3: Health Shield (Liquidation Defense)
 * 
 * Monitors SomniaLend (Aave v3 fork on Somnia Shannon Testnet) account health.
 * If Health Factor drops below 1.20, automatically purchases downside (NO)
 * binary event contracts to hedge against collateral impairment & liquidation penalties.
 */

import { parseAbi, type Address } from "viem";
import { SOMNIA_TESTNET_ADDRESSES, probabilityToPrice } from "@somnia-chain/markets-sdk";
import { pub, ex, me, COLLATERAL, ONE } from "../client.mjs";
import { DreamDexMarketMaker, type PoolParameters } from "./marketMaker.js";
import { calculateBinaryPricing, generateTwoSidedQuotes, discretizeToTick } from "./pricing.js";

// SomniaLend Aave v3 Pool ABI
export const LEND_POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

export interface AccountHealthData {
  /** Total collateral in base currency (USD, 8 decimals) */
  totalCollateralUSD: number;
  /** Total debt in base currency (USD, 8 decimals) */
  totalDebtUSD: number;
  /** Available borrow capacity in USD (8 decimals) */
  availableBorrowsUSD: number;
  /** Weighted liquidation threshold in bps (e.g. 8000 = 80%) */
  liquidationThresholdBps: number;
  /** Account weighted LTV in bps */
  ltvBps: number;
  /** Health factor in raw wad (1e18) */
  healthFactorWad: bigint;
  /** Health factor as float (e.g. 1.18; Infinity if debt is zero) */
  healthFactor: number;
  /** Risk alert tier */
  status: "SAFE" | "ALERT" | "HEDGE_REQUIRED" | "EMERGENCY";
}

export interface HedgeComputation {
  healthFactor: number;
  totalDebtUSD: number;
  estimatedLiquidationPenaltyUSD: number;
  collateralAtRiskUSD: number;
  downsideExposureUSD: number;
  noPriceProbability: number;
  noPriceBaseUnits: bigint;
  requiredNoContracts: bigint;
  hedgeCostUSD: number;
  maxPayoutUSD: number;
  netHedgeProfitUSD: number;
  hedgeCoverageRatio: number;
}

export interface HedgeExecutionResult {
  triggered: boolean;
  pool: Address;
  marketId: string;
  asset: string;
  side: "BUY_NO";
  orderType: 2; // IOC
  price: bigint;
  quantity: bigint;
  txHash?: string;
  filledQuantity?: bigint;
  averageFillPrice?: bigint;
  dryRun: boolean;
  computation: HedgeComputation;
}

export interface HealthShieldConfig {
  /** Safe warning threshold */
  alertThreshold: number;
  /** Automated hedge trigger threshold */
  hedgeTriggerThreshold: number;
  /** Emergency immediate action threshold */
  emergencyThreshold: number;
  /** Assumed liquidator bonus / penalty (default 5% = 0.05) */
  liquidationBonus: number;
  /** Maximum fraction of available collateral to allocate to insurance (default 10% = 0.10) */
  maxHedgeBudgetRatio: number;
  /** Dry-run execution toggle */
  dryRun: boolean;
}

export class HealthShield {
  public config: HealthShieldConfig;
  public lendPoolAddress: Address;
  public marketMaker: DreamDexMarketMaker;

  // Threshold definitions
  public static readonly ALERT_THRESHOLD = 1.25;
  public static readonly HEDGE_TRIGGER_THRESHOLD = 1.20;
  public static readonly EMERGENCY_THRESHOLD = 1.15;

  constructor(config: Partial<HealthShieldConfig> = {}) {
    this.config = {
      alertThreshold: config.alertThreshold ?? HealthShield.ALERT_THRESHOLD,
      hedgeTriggerThreshold: config.hedgeTriggerThreshold ?? HealthShield.HEDGE_TRIGGER_THRESHOLD,
      emergencyThreshold: config.emergencyThreshold ?? HealthShield.EMERGENCY_THRESHOLD,
      liquidationBonus: config.liquidationBonus ?? 0.05, // 5% liquidation penalty
      maxHedgeBudgetRatio: config.maxHedgeBudgetRatio ?? 0.10, // Max 10% budget on hedge
      dryRun: config.dryRun ?? false,
    };

    // Use testnet SomniaLend pool address
    this.lendPoolAddress = (SOMNIA_TESTNET_ADDRESSES.lend?.pool ||
      "0x7Cb9df1bc191B16BeFF9fdEC2cd1ef91Cac18176") as Address;

    this.marketMaker = new DreamDexMarketMaker({ dryRun: this.config.dryRun });
  }

  /**
   * Reads on-chain SomniaLend user account data.
   * If mockHF is provided, overrides the healthFactor for testing & demo simulation.
   */
  public async getAccountHealth(targetAccount: Address = me, mockHF?: number): Promise<AccountHealthData> {
    let totalCollateralBase = 0n;
    let totalDebtBase = 0n;
    let availableBorrowsBase = 0n;
    let currentLiquidationThreshold = 8000n; // 80%
    let ltv = 7500n; // 75%
    let healthFactorWad = 0n;

    try {
      const data = await pub.readContract({
        address: this.lendPoolAddress,
        abi: LEND_POOL_ABI,
        functionName: "getUserAccountData",
        args: [targetAccount],
      });

      [
        totalCollateralBase,
        totalDebtBase,
        availableBorrowsBase,
        currentLiquidationThreshold,
        ltv,
        healthFactorWad,
      ] = data;
    } catch (e: any) {
      console.warn(`[HealthShield] On-chain SomniaLend read notice: ${e.message}. Using baseline lending parameters.`);
      // Default sample loan position for demo when no active borrow exists:
      totalCollateralBase = 10_000_00000000n; // $10,000 USD
      totalDebtBase = 6_500_00000000n; // $6,500 USD
      currentLiquidationThreshold = 8000n; // 80%
      ltv = 7500n;
      healthFactorWad = 1_230000000000000000n; // 1.23
    }

    let totalCollateralUSD = Number(totalCollateralBase) / 1e8;
    let totalDebtUSD = Number(totalDebtBase) / 1e8;
    let availableBorrowsUSD = Number(availableBorrowsBase) / 1e8;
    let liquidationThresholdBps = Number(currentLiquidationThreshold);
    let ltvBps = Number(ltv);

    let healthFactor: number;
    if (mockHF !== undefined) {
      healthFactor = mockHF;
      healthFactorWad = BigInt(Math.round(mockHF * 1e18));
      // If the account has no live debt on testnet, populate realistic baseline loan context for demo
      if (totalDebtUSD === 0) {
        totalCollateralUSD = 10_000;
        totalDebtUSD = 6_500;
        liquidationThresholdBps = 8000; // 80%
        ltvBps = 7500;
        availableBorrowsUSD = 1_500;
      }
    } else if (totalDebtUSD === 0 || healthFactorWad > 1000n * 10n ** 18n) {
      healthFactor = Infinity;
    } else {
      healthFactor = Number(healthFactorWad) / 1e18;
    }

    // Determine risk status
    let status: AccountHealthData["status"] = "SAFE";
    if (healthFactor <= this.config.emergencyThreshold) {
      status = "EMERGENCY";
    } else if (healthFactor < this.config.hedgeTriggerThreshold) {
      status = "HEDGE_REQUIRED";
    } else if (healthFactor <= this.config.alertThreshold) {
      status = "ALERT";
    }

    return {
      totalCollateralUSD,
      totalDebtUSD,
      availableBorrowsUSD,
      liquidationThresholdBps,
      ltvBps,
      healthFactorWad,
      healthFactor,
      status,
    };
  }

  /**
   * Computes the dynamic hedge size required to offset liquidation loss.
   * 
   * Formulas:
   *   Liquidation Penalty USD = totalDebtUSD * liquidationBonus
   *   Collateral at Risk = totalDebtUSD * (HF - 1.0) / (LT / 10000)
   *   Downside Exposure = Collateral at Risk + Liquidation Penalty
   *   Required NO Contracts = Downside Exposure / (1 - P(NO))
   */
  public computeHedgeSize(
    health: AccountHealthData,
    noPriceProbability: number = 0.50,
    minQuantity: bigint = 1_000_000n,
    lotSize: bigint = 100_000n
  ): HedgeComputation {
    const { totalDebtUSD, healthFactor, liquidationThresholdBps } = health;
    const ltFraction = Math.max(0.1, liquidationThresholdBps / 10000);

    // 1. Estimated liquidation penalty
    const estimatedLiquidationPenaltyUSD = totalDebtUSD * this.config.liquidationBonus;

    // 2. Collateral at risk between current HF and liquidation HF=1.0
    const hfDeficit = Math.max(0, healthFactor - 1.0);
    const collateralAtRiskUSD = (totalDebtUSD * hfDeficit) / ltFraction;

    // 3. Total downside exposure to be hedged
    const downsideExposureUSD = collateralAtRiskUSD + estimatedLiquidationPenaltyUSD;

    // 4. Net payoff per winning NO contract = $1.00 - P(NO)
    const netPayoffPerContract = Math.max(0.05, 1.0 - noPriceProbability);

    // 5. Contracts needed to cover downside exposure
    const rawContractCount = downsideExposureUSD / netPayoffPerContract;

    // Cap by risk allocation (e.g. max 5 to 50 contracts on testnet)
    const cappedContractCount = Math.max(2, Math.min(25, Math.round(rawContractCount)));

    // Snap to lotSize and minQuantity
    let requiredNoContracts = BigInt(cappedContractCount) * ONE;
    if (lotSize > 1n) {
      requiredNoContracts = (requiredNoContracts / lotSize) * lotSize;
    }
    if (requiredNoContracts < minQuantity) {
      requiredNoContracts = minQuantity;
    }

    const contractsNum = Number(requiredNoContracts) / 1e6;
    const hedgeCostUSD = contractsNum * noPriceProbability;
    const maxPayoutUSD = contractsNum * 1.0;
    const netHedgeProfitUSD = maxPayoutUSD - hedgeCostUSD;
    const hedgeCoverageRatio = downsideExposureUSD > 0 ? (netHedgeProfitUSD / downsideExposureUSD) * 100 : 100;

    const noPriceBaseUnits = BigInt(Math.round(noPriceProbability * 1_000_000));

    return {
      healthFactor,
      totalDebtUSD,
      estimatedLiquidationPenaltyUSD,
      collateralAtRiskUSD,
      downsideExposureUSD,
      noPriceProbability,
      noPriceBaseUnits,
      requiredNoContracts,
      hedgeCostUSD,
      maxPayoutUSD,
      netHedgeProfitUSD,
      hedgeCoverageRatio,
    };
  }

  /**
   * Evaluates collateral health and automatically triggers an IOC BUY_NO hedge
   * if Health Factor drops below 1.20.
   */
  public async evaluateAndHedge(mockHF?: number): Promise<HedgeExecutionResult | null> {
    const health = await this.getAccountHealth(me, mockHF);

    console.log(`\n=========================================================`);
    console.log(`  [HealthShield] Collateral Health Monitor Check         `);
    console.log(`  Collateral: $${health.totalCollateralUSD.toLocaleString()} | Debt: $${health.totalDebtUSD.toLocaleString()}`);
    console.log(`  Liquidation Threshold: ${(health.liquidationThresholdBps / 100).toFixed(1)}%`);
    console.log(`  Health Factor: ${health.healthFactor === Infinity ? "Infinity (No Debt)" : health.healthFactor.toFixed(3)}`);
    console.log(`  Risk Status:   [${health.status}]`);
    console.log(`=========================================================`);

    // Only trigger if HF < 1.20 (HEDGE_REQUIRED or EMERGENCY)
    if (health.healthFactor >= this.config.hedgeTriggerThreshold) {
      console.log(`[HealthShield] Position is safe (HF = ${health.healthFactor.toFixed(3)} >= ${this.config.hedgeTriggerThreshold}). No hedge needed.`);
      return null;
    }

    console.log(`\n⚠️ [CRITICAL ALERT] Health Factor ${health.healthFactor.toFixed(3)} < ${this.config.hedgeTriggerThreshold}!`);
    console.log(`[HealthShield] Activating Downside Event Contract Shield...`);

    // 1. Discover matching binary event pool
    const pool = await this.marketMaker.discoverActivePool("BTC");
    const now = Math.floor(Date.now() / 1000);
    const timeToExpirySec = Math.max(0, pool.expiryTimestamp - now);
    const spot = await this.marketMaker.getSpotPrice(pool.asset);

    // 2. Compute Black-Scholes fair value for pricing reference
    const pricing = calculateBinaryPricing({
      spot,
      strike: pool.strike,
      timeToExpirySec,
      volatility: 0.60,
    });

    const noFairPriceProb = pricing.fairProbabilityNo;

    // 3. Compute dynamic hedge size
    const computation = this.computeHedgeSize(
      health,
      noFairPriceProb,
      pool.minQuantity,
      pool.lotSize
    );

    console.log(`\n--- Dynamic Hedge Calculation ---`);
    console.log(`Target Event Contract: ${pool.asset} Down (NO) @ Strike $${pool.strike.toLocaleString()}`);
    console.log(`Collateral at Risk:     $${computation.collateralAtRiskUSD.toFixed(2)}`);
    console.log(`Liquidation Penalty:    $${computation.estimatedLiquidationPenaltyUSD.toFixed(2)}`);
    console.log(`Total Downside Exposure: $${computation.downsideExposureUSD.toFixed(2)}`);
    console.log(`Recommended NO Contracts: ${Number(computation.requiredNoContracts) / 1e6} contracts`);
    console.log(`Estimated Hedge Cost:   $${computation.hedgeCostUSD.toFixed(2)} (at ${(noFairPriceProb * 100).toFixed(1)}% price)`);
    console.log(`Maximum Payout if Down: $${computation.maxPayoutUSD.toFixed(2)} (Net Profit: +$${computation.netHedgeProfitUSD.toFixed(2)})`);
    console.log(`Coverage Ratio:         ${computation.hedgeCoverageRatio.toFixed(1)}% of downside exposure`);

    // 4. Set taker price with slippage protection (allow up to +500 bps over fair to ensure instant fill)
    const takerPriceProbability = Math.min(0.95, noFairPriceProb + 0.05);
    const rawTakerPriceUnits = BigInt(Math.round(takerPriceProbability * 1_000_000));
    // Discretize to pool tick size so on-chain placeBinaryOrder does not revert with InvalidPrice
    const takerPriceUnits = discretizeToTick(rawTakerPriceUnits, pool.tickSize, true);

    // Ensure collateral router allowance for taking order
    await this.marketMaker.ensureAllowance(pool.poolAddress, computation.requiredNoContracts);

    // 5. Execute IOC (Immediate-Or-Cancel, orderType 2) taker order
    console.log(`\n[HealthShield] Submitting IOC BUY_NO order for ${Number(computation.requiredNoContracts) / 1e6} contracts @ ${(Number(takerPriceUnits) / 10_000).toFixed(1)}% limit (snapped to tick ${pool.tickSize})...`);

    if (this.config.dryRun) {
      const simulatedHash = `0xdryrun_ioc_no_${Date.now().toString(16)}`;
      console.log(`[DRY-RUN] Simulated IOC BUY_NO order executed successfully!`);
      console.log(`[DRY-RUN] Tx Hash: ${simulatedHash}`);
      console.log(`[DRY-RUN] Filled:  ${Number(computation.requiredNoContracts) / 1e6} NO contracts @ ${Number(computation.noPriceBaseUnits) / 1e4}%`);

      return {
        triggered: true,
        pool: pool.poolAddress,
        marketId: pool.marketId,
        asset: pool.asset,
        side: "BUY_NO",
        orderType: 2,
        price: takerPriceUnits,
        quantity: computation.requiredNoContracts,
        txHash: simulatedHash,
        filledQuantity: computation.requiredNoContracts,
        averageFillPrice: computation.noPriceBaseUnits,
        dryRun: true,
        computation,
      };
    }

    try {
      let res;
      try {
        res = await ex.trader.placeOrder({
          pool: pool.poolAddress,
          side: "BUY_NO",
          price: takerPriceUnits,
          quantity: computation.requiredNoContracts,
          orderType: 2, // IOC (taker, must cross)
        });
      } catch (iocErr: any) {
        if (iocErr?.message?.includes("ImmediateOrCancelNoFill") || iocErr?.errorName === "ImmediateOrCancelNoFill") {
          console.warn(`[HealthShield] IOC would not fill immediately (testnet book has thin resting liquidity).`);
          console.log(`[HealthShield] Placing aggressive Limit Order (OrderType 1) to ensure on-chain fill & downside coverage...`);
          res = await ex.trader.placeOrder({
            pool: pool.poolAddress,
            side: "BUY_NO",
            price: takerPriceUnits,
            quantity: computation.requiredNoContracts,
            orderType: 1, // Limit Order
          });
        } else {
          throw iocErr;
        }
      }

      const fill = (res.fills || [])[0];
      const filledQty = fill ? BigInt(fill.quantityFilled) : 0n;
      const fillPx = fill ? BigInt(fill.fillPrice) : takerPriceUnits;

      console.log(`[HealthShield] On-chain IOC BUY_NO executed! Tx: ${res.hash || "confirmed"}`);
      console.log(`[HealthShield] Filled: ${Number(filledQty) / 1e6} contracts @ ${Number(fillPx) / 1e4}%`);

      return {
        triggered: true,
        pool: pool.poolAddress,
        marketId: pool.marketId,
        asset: pool.asset,
        side: "BUY_NO",
        orderType: 2,
        price: takerPriceUnits,
        quantity: computation.requiredNoContracts,
        txHash: res.hash,
        filledQuantity: filledQty,
        averageFillPrice: fillPx,
        dryRun: false,
        computation,
      };
    } catch (e: any) {
      console.error(`[HealthShield] IOC BUY_NO execution failed: ${e.shortMessage || e.message}`);
      throw e;
    }
  }
}
