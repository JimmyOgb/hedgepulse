/**
 * HedgePulse AI - Module 2: Autonomous Market Maker
 * 
 * Manages complete-set inventory (tUSDC -> 1 YES + 1 NO),
 * aligns quotes to pool tick and lot grids, and posts two-sided
 * Post-Only limit orders (OrderType 3) within 150-200 bps of Black-Scholes fair value.
 */

import { parseAbi, type Address, type PublicClient } from "viem";
import { SOMNIA_TESTNET_ADDRESSES, probabilityToPrice } from "@somnia-chain/markets-sdk";
import {
  calculateBinaryPricing,
  generateTwoSidedQuotes,
  discretizeToTick,
  PRICE_SCALE,
  type TwoSidedQuotes,
  type PricingOutputs
} from "./pricing.js";
import { ex, pub, me, COLLATERAL, ONE } from "../client.mjs";

export { ONE };

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
]);

export interface PoolParameters {
  marketId: string;
  poolAddress: Address;
  asset: string;
  strike: number;
  expiryTimestamp: number;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  collateralAddress: Address;
  clobStatus: string;
}

export interface MarketMakerConfig {
  /** Spread in basis points (e.g., 180 bps = 1.8% full spread, +/- 90 bps) */
  spreadBps: number;
  /** Collateral quantity per quote in base units (e.g. 2_000_000n = 2 tUSDC) */
  orderQuantity: bigint;
  /** Assumed annualized volatility for asset */
  volatility: number;
  /** Dry-run mode: skips on-chain state mutations if true */
  dryRun: boolean;
}

export interface RestingOrder {
  orderId: bigint;
  side: "SELL_YES" | "BUY_YES" | "SELL_NO" | "BUY_NO";
  price: bigint;
  quantity: bigint;
  timestamp: number;
  txHash?: string;
}

export class DreamDexMarketMaker {
  public config: MarketMakerConfig;
  public poolParams: PoolParameters | null = null;
  public activeOrders: Map<string, RestingOrder> = new Map();

  constructor(config: Partial<MarketMakerConfig> = {}) {
    this.config = {
      spreadBps: config.spreadBps ?? 180, // 180 bps default (150-200 bps range)
      orderQuantity: config.orderQuantity ?? 2n * ONE, // 2 tUSDC default
      volatility: config.volatility ?? 0.60, // 60% default crypto volatility
      dryRun: config.dryRun ?? false,
    };
  }

  /**
   * Discovers the earliest-resolving live binary market for the canonical collateral.
   * Reads from the public GraphQL indexer with fallback to on-chain params.
   */
  public async discoverActivePool(preferredAsset?: string): Promise<PoolParameters> {
    const indexerUrl = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
    const now = Math.floor(Date.now() / 1000);

    let marketData: any = null;

    try {
      const query = `
        query GetLiveBinaryMarkets {
          Market(
            where: {
              marketType: { _eq: "BINARY" }
              clobStatus: { _eq: "Trading" }
              finalized: { _eq: false }
            }
            order_by: { expiry: asc }
            limit: 20
          ) {
            id
            marketId
            poolAddress
            asset
            strike
            expiry
            collateral
            clobStatus
          }
        }
      `;

      const response = await fetch(indexerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const json = await response.json();
      const markets = json?.data?.Market || [];

      // Filter for markets with expiry > now + 60s and matching collateral
      const viable = markets.filter((m: any) => {
        const expiry = Number(m.expiry);
        const matchesCollateral = m.collateral?.toLowerCase() === COLLATERAL.toLowerCase();
        const matchesAsset = !preferredAsset || m.asset?.toUpperCase() === preferredAsset.toUpperCase();
        return expiry > now + 60 && matchesCollateral && matchesAsset;
      });

      if (viable.length > 0) {
        marketData = viable[0];
      }
    } catch (e: any) {
      console.warn(`[MarketMaker] Indexer query failed: ${e.message}. Falling back to default testnet pool.`);
    }

    if (!marketData) {
      // Fallback: use the known active Shannon testnet binary market
      marketData = {
        marketId: "0x0000000000000000000000000000000000000000000000000000000000012baf",
        poolAddress: "0x171186a2a8d237ad194dd3cae9b05326407c4e11",
        asset: "BTC",
        strike: "90000",
        expiry: String(now + 900), // 15 min window
        collateral: COLLATERAL,
        clobStatus: "Trading",
      };
    }

    const poolAddress = marketData.poolAddress as Address;
    const marketId = marketData.marketId;
    const asset = marketData.asset || "BTC";
    const expiryTimestamp = Number(marketData.expiry);
    let strike = Number(marketData.strike);
    if (!strike || strike <= 0) {
      // If strike is 0 (ATM rolling series), default to nominal asset benchmark
      strike = asset.toUpperCase() === "BTC" ? 90000 : asset.toUpperCase() === "ETH" ? 3000 : 1;
    }

    // Read on-chain grid parameters: tickSize, lotSize, minQuantity
    let tickSize = 10_000n; // 0.01 default
    let lotSize = 100_000n; // 0.1 default
    let minQuantity = 1_000_000n; // 1 whole contract default

    try {
      const bookParams = await ex.client.getBinaryBookParams(poolAddress);
      if (bookParams) {
        tickSize = bookParams.tickSize > 0n ? bookParams.tickSize : tickSize;
        lotSize = bookParams.lotSize > 0n ? bookParams.lotSize : lotSize;
        minQuantity = bookParams.minQuantity > 0n ? bookParams.minQuantity : minQuantity;
      }
    } catch (e) {
      // Gracefully fall back to standard grid
    }

    this.poolParams = {
      marketId,
      poolAddress,
      asset,
      strike,
      expiryTimestamp,
      tickSize,
      lotSize,
      minQuantity,
      collateralAddress: marketData.collateral as Address,
      clobStatus: marketData.clobStatus || "Trading",
    };

    return this.poolParams;
  }

  /**
   * Fetches the current spot price for the underlying asset.
   */
  public async getSpotPrice(asset: string): Promise<number> {
    try {
      // Try Somnia testnet oracle price feed via GraphQL
      const priceInfo = await ex.client.fetchPrice(asset).catch(() => null);
      if (priceInfo && priceInfo.price) {
        return Number(priceInfo.price);
      }
    } catch {}

    try {
      // Fallback: fetch from public Coinbase / Binance ticker for real-world spot reference
      const sym = asset.toUpperCase() === "BTC" ? "BTC-USD" : asset.toUpperCase() === "ETH" ? "ETH-USD" : null;
      if (sym) {
        const res = await fetch(`https://api.coinbase.com/v2/prices/${sym}/spot`);
        const json = await res.json();
        const price = Number(json?.data?.amount);
        if (price > 0) return price;
      }
    } catch {}

    // Nominal fallback
    return asset.toUpperCase() === "BTC" ? 90000 : asset.toUpperCase() === "ETH" ? 3000 : 1.0;
  }

  /**
   * Checks collateral balance and token allowance for the pool router.
   */
  public async checkCollateralAndAllowance(requiredAmount: bigint = this.config.orderQuantity): Promise<{
    balance: bigint;
    allowance: bigint;
    hasSufficientBalance: boolean;
    hasSufficientAllowance: boolean;
  }> {
    if (!this.poolParams) throw new Error("Pool not discovered. Call discoverActivePool() first.");

    const collateral = this.poolParams.collateralAddress;
    const pool = this.poolParams.poolAddress;

    let balance = 0n;
    let allowance = 0n;

    try {
      [balance, allowance] = await Promise.all([
        pub.readContract({
          address: collateral,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [me],
        }),
        pub.readContract({
          address: collateral,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [me, pool],
        }),
      ]);
    } catch (e: any) {
      console.warn(`[MarketMaker] Allowance read fallback: ${e.message}`);
    }

    return {
      balance,
      allowance,
      hasSufficientBalance: balance >= requiredAmount,
      hasSufficientAllowance: allowance >= requiredAmount,
    };
  }

  /**
   * Ensures the pool router has sufficient collateral token allowance.
   */
  public async ensureAllowance(spender: Address, requiredAmount: bigint): Promise<void> {
    const collateral = this.poolParams?.collateralAddress || COLLATERAL;
    try {
      const currentAllowance = await pub.readContract({
        address: collateral,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [me, spender],
      });

      if (currentAllowance < requiredAmount) {
        console.log(`[MarketMaker] Approving ${spender} for collateral ${collateral}...`);
        await ex.trader.approve({ token: collateral, spender, amount: 2n ** 256n - 1n });
        console.log(`[MarketMaker] Allowance approved successfully.`);
      }
    } catch (e: any) {
      console.warn(`[MarketMaker] ensureAllowance notice: ${e.message}`);
    }
  }

  /**
   * Converts collateral into 1:1 complete sets of YES and NO outcome tokens.
   */
  public async mintCompleteSet(amount: bigint = this.config.orderQuantity): Promise<{ hash: string; amount: bigint }> {
    if (!this.poolParams) throw new Error("Pool not discovered.");
    const pool = this.poolParams.poolAddress;

    console.log(`[MarketMaker] Minting complete set: ${Number(amount) / 1e6} collateral -> 1:1 YES + NO...`);

    if (this.config.dryRun) {
      const mockHash = `0xdryrun_mint_${Date.now().toString(16)}`;
      console.log(`[DRY-RUN] Simulated mintSet tx: ${mockHash}`);
      return { hash: mockHash, amount };
    }

    const tx = await ex.trader.mintSet({ pool, amount });
    console.log(`[MarketMaker] mintSet confirmed on-chain: ${tx.hash}`);
    return { hash: tx.hash, amount };
  }

  /**
   * Snaps quantity to lotSize and enforces minQuantity.
   */
  public snapQuantity(quantity: bigint): bigint {
    if (!this.poolParams) return quantity;
    const { lotSize, minQuantity } = this.poolParams;
    let snapped = quantity;
    if (lotSize > 1n) {
      snapped = (quantity / lotSize) * lotSize;
    }
    return snapped < minQuantity ? minQuantity : snapped;
  }

  /**
   * Cancels stale orders that have drifted more than 1 tick from current fair quotes.
   */
  public async cancelStaleOrders(newFairYesPrice: bigint): Promise<number> {
    if (!this.poolParams) return 0;
    const pool = this.poolParams.poolAddress;
    const tickSize = this.poolParams.tickSize;
    let cancelledCount = 0;

    for (const [key, order] of this.activeOrders.entries()) {
      // Check price drift
      const drift = order.price > newFairYesPrice ? order.price - newFairYesPrice : newFairYesPrice - order.price;

      if (drift > tickSize) {
        console.log(`[MarketMaker] Order ${order.orderId} drifted by ${drift} (>${tickSize} ticks). Cancelling...`);
        if (!this.config.dryRun) {
          try {
            await ex.trader.cancelOrder({ pool, orderId: order.orderId });
          } catch (e: any) {
            console.warn(`[MarketMaker] Cancel failed for order ${order.orderId}: ${e.message}`);
          }
        } else {
          console.log(`[DRY-RUN] Simulated cancelOrder(${order.orderId})`);
        }
        this.activeOrders.delete(key);
        cancelledCount++;
      }
    }

    return cancelledCount;
  }

  /**
   * Calculates quotes and submits two-sided PostOnly limit orders (OrderType 3).
   * Catches PostOnlyWouldCross() defensively to prevent crashes when books are tight.
   */
  public async postTwoSidedQuotes(): Promise<{
    pricing: PricingOutputs;
    quotes: TwoSidedQuotes;
    yesOrder?: RestingOrder | null;
    noOrder?: RestingOrder | null;
  }> {
    if (!this.poolParams) throw new Error("Pool not discovered.");

    const now = Math.floor(Date.now() / 1000);
    const timeToExpirySec = Math.max(0, this.poolParams.expiryTimestamp - now);
    const spot = await this.getSpotPrice(this.poolParams.asset);

    // 1. Calculate Black-Scholes probability and fair quotes
    const pricing = calculateBinaryPricing({
      spot,
      strike: this.poolParams.strike,
      timeToExpirySec,
      volatility: this.config.volatility,
    });

    const quotes = generateTwoSidedQuotes(
      pricing.priceYes,
      this.config.spreadBps,
      this.poolParams.tickSize
    );

    // 2. Cancel stale orders before refreshing quotes
    await this.cancelStaleOrders(pricing.priceYes);

    const quantity = this.snapQuantity(this.config.orderQuantity);
    const pool = this.poolParams.poolAddress;

    console.log(`\n--- Market Maker Update ---`);
    console.log(`Asset: ${this.poolParams.asset} | Spot: $${spot.toLocaleString()} | Strike: $${this.poolParams.strike.toLocaleString()}`);
    console.log(`Time to Expiry: ${Math.round(timeToExpirySec / 60)}m (${timeToExpirySec}s)`);
    console.log(`Fair P(YES): ${(pricing.fairProbabilityYes * 100).toFixed(2)}% | Price: ${pricing.priceYes}`);
    console.log(`Fair P(NO):  ${(pricing.fairProbabilityNo * 100).toFixed(2)}% | Price: ${pricing.priceNo}`);
    console.log(`Quoting Spread: ${this.config.spreadBps} bps | Quantity: ${Number(quantity) / 1e6} contracts`);
    console.log(`Quotes: YES Bid=${quotes.yesBid} Ask=${quotes.yesAsk} | NO Bid=${quotes.noBid} Ask=${quotes.noAsk}`);

    let yesOrder: RestingOrder | null = null;
    let noOrder: RestingOrder | null = null;

    // 3. Post Maker SELL_YES at yesAsk (rests above best bid)
    try {
      if (this.config.dryRun) {
        const simulatedId = BigInt(Date.now() + 1);
        yesOrder = { orderId: simulatedId, side: "SELL_YES", price: quotes.yesAsk, quantity, timestamp: Date.now() };
        this.activeOrders.set("SELL_YES", yesOrder);
        console.log(`[DRY-RUN] Resting SELL_YES @ ${Number(quotes.yesAsk) / 1e4}% (id=${simulatedId})`);
      } else {
        const res = await ex.trader.placeOrder({
          pool,
          side: "SELL_YES",
          price: quotes.yesAsk,
          quantity,
          orderType: 3, // PostOnly (maker)
        });
        if (res?.orderId) {
          const txHash = res.hash || res.txHash || "";
          yesOrder = { orderId: BigInt(res.orderId), side: "SELL_YES", price: quotes.yesAsk, quantity, timestamp: Date.now(), txHash };
          this.activeOrders.set("SELL_YES", yesOrder);
          console.log(`[MarketMaker] Posted maker SELL_YES @ ${Number(quotes.yesAsk) / 1e4}% (orderId=${res.orderId}, tx=${txHash})`);
        }
      }
    } catch (e: any) {
      const msg = e.shortMessage || e.message || "";
      if (msg.includes("PostOnlyWouldCross") || msg.includes("0xb99933ee")) {
        console.warn(`[MarketMaker] SELL_YES skipped: PostOnlyWouldCross (spread too tight).`);
      } else {
        console.error(`[MarketMaker] Failed placing SELL_YES: ${msg}`);
      }
    }

    // 4. Post Maker SELL_NO at noAsk (mathematically equivalent to bidding YES @ 1 - noAsk)
    try {
      if (this.config.dryRun) {
        const simulatedId = BigInt(Date.now() + 2);
        noOrder = { orderId: simulatedId, side: "SELL_NO", price: quotes.noAsk, quantity, timestamp: Date.now() };
        this.activeOrders.set("SELL_NO", noOrder);
        console.log(`[DRY-RUN] Resting SELL_NO @ ${Number(quotes.noAsk) / 1e4}% (id=${simulatedId})`);
      } else {
        const res = await ex.trader.placeOrder({
          pool,
          side: "SELL_NO",
          price: quotes.noAsk,
          quantity,
          orderType: 3, // PostOnly (maker)
        });
        if (res?.orderId) {
          noOrder = { orderId: BigInt(res.orderId), side: "SELL_NO", price: quotes.noAsk, quantity, timestamp: Date.now() };
          this.activeOrders.set("SELL_NO", noOrder);
          console.log(`[MarketMaker] Posted maker SELL_NO @ ${Number(quotes.noAsk) / 1e4}% (orderId=${res.orderId})`);
        }
      }
    } catch (e: any) {
      const msg = e.shortMessage || e.message || "";
      if (msg.includes("PostOnlyWouldCross") || msg.includes("0xb99933ee")) {
        console.warn(`[MarketMaker] SELL_NO skipped: PostOnlyWouldCross (spread too tight).`);
      } else {
        console.error(`[MarketMaker] Failed placing SELL_NO: ${msg}`);
      }
    }

    return {
      pricing,
      quotes,
      yesOrder,
      noOrder,
    };
  }
}
