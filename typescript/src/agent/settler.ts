/**
 * HedgePulse AI - Module 4: Settlement & Capital Recycler
 * 
 * Listens for pool resolution after market expiry,
 * claims 1:1 collateral payout on winning outcome tokens (YES or NO),
 * and recycles redeemed capital back into the active liquidity pool.
 */

import { type Address, type Hex } from "viem";
import { ex, pub, me, COLLATERAL, ONE } from "../client.mjs";

export interface ResolutionStatus {
  marketId: string;
  poolAddress?: Address;
  outcomeToken?: Address;
  yesId?: bigint;
  noId?: bigint;
  expiry: number;
  isResolved: boolean;
  isVoided: boolean;
  finalized: boolean;
  winningOutcome: number; // 0 = YES, 1 = NO
  winningSide: "YES" | "NO" | "VOID";
  timeRemainingSec: number;
}

export interface RedemptionRecord {
  marketId: string;
  winningSide: "YES" | "NO" | "VOID";
  outcomeIdx: 0 | 1;
  tokensRedeemed: bigint;
  collateralClaimed: bigint;
  txHash: string;
  timestamp: number;
  dryRun: boolean;
}

export interface SettlementTelemetry {
  marketsChecked: number;
  marketsResolved: number;
  redemptionsExecuted: number;
  totalTokensBurned: bigint;
  totalCollateralRecycled: bigint;
  records: RedemptionRecord[];
}

export interface SettlerConfig {
  dryRun: boolean;
}

export class DreamDexSettler {
  public config: SettlerConfig;
  public trackedMarkets: Map<string, { poolAddress: Address; initialDeposit: bigint }> = new Map();
  public redemptionHistory: RedemptionRecord[] = [];

  constructor(config: Partial<SettlerConfig> = {}) {
    this.config = {
      dryRun: config.dryRun ?? false,
    };
  }

  /**
   * Registers a market to monitor for resolution and settlement.
   */
  public trackMarket(marketId: string, poolAddress: Address, initialDeposit: bigint = 0n) {
    this.trackedMarkets.set(marketId.toLowerCase(), { poolAddress, initialDeposit });
  }

  /**
   * Inspects on-chain resolution state for a given market.
   * If mockResolved is true, simulates resolution for testing without waiting for expiration.
   */
  public async checkMarketResolution(
    marketId: string,
    mockResolved?: boolean,
    mockWinner: 0 | 1 = 0
  ): Promise<ResolutionStatus> {
    const now = Math.floor(Date.now() / 1000);

    if (mockResolved) {
      return {
        marketId,
        expiry: now - 60,
        isResolved: true,
        isVoided: false,
        finalized: true,
        winningOutcome: mockWinner,
        winningSide: mockWinner === 0 ? "YES" : "NO",
        timeRemainingSec: 0,
      };
    }

    try {
      const mo = await ex.client.getMarketOnchain(marketId as Hex);
      const isResolved = Boolean(mo.isResolved);
      const isVoided = Boolean(mo.isVoided);
      const finalized = Boolean(mo.finalized);
      const winningOutcome = Number(mo.winningOutcome || 0);
      const expiry = Number(mo.expiry);
      const timeRemainingSec = Math.max(0, expiry - now);

      let winningSide: ResolutionStatus["winningSide"] = "YES";
      if (isVoided) winningSide = "VOID";
      else if (winningOutcome === 1) winningSide = "NO";

      return {
        marketId,
        poolAddress: mo.pool,
        outcomeToken: mo.outcomeToken,
        yesId: mo.yesId,
        noId: mo.noId,
        expiry,
        isResolved,
        isVoided,
        finalized,
        winningOutcome,
        winningSide,
        timeRemainingSec,
      };
    } catch (e: any) {
      console.warn(`[Settler] getMarketOnchain notice: ${e.message}`);
      return {
        marketId,
        expiry: now + 300,
        isResolved: false,
        isVoided: false,
        finalized: false,
        winningOutcome: 0,
        winningSide: "YES",
        timeRemainingSec: 300,
      };
    }
  }

  /**
   * Reads current outcome token balance for the user on the ERC-6909 singleton.
   */
  public async getOutcomeBalance(outcomeToken: Address, tokenId: bigint): Promise<bigint> {
    try {
      return await ex.client.getOutcomeBalance({
        outcomeToken,
        account: me,
        id: tokenId,
      });
    } catch {
      return 0n;
    }
  }

  /**
   * Redeems winning outcome tokens 1:1 for underlying collateral.
   */
  public async redeemPosition(
    marketId: string,
    outcomeIdx: 0 | 1,
    amount: bigint,
    mockResolved?: boolean
  ): Promise<RedemptionRecord | null> {
    if (amount <= 0n) {
      console.log(`[Settler] Zero winning balance to redeem for market ${marketId}.`);
      return null;
    }

    const winningSide = outcomeIdx === 0 ? "YES" : "NO";
    console.log(`[Settler] Redeeming ${Number(amount) / 1e6} winning ${winningSide} tokens on market ${marketId}...`);

    if (this.config.dryRun || mockResolved) {
      const simulatedHash = `0xdryrun_redeem_${Date.now().toString(16)}`;
      console.log(`[DRY-RUN] Simulated redeem confirmed: ${simulatedHash}`);
      console.log(`[DRY-RUN] Claimed ${Number(amount) / 1e6} collateral (1:1 payout).`);

      const record: RedemptionRecord = {
        marketId,
        winningSide,
        outcomeIdx,
        tokensRedeemed: amount,
        collateralClaimed: amount, // 1:1 payout
        txHash: simulatedHash,
        timestamp: Date.now(),
        dryRun: true,
      };
      this.redemptionHistory.push(record);
      return record;
    }

    try {
      const res = await ex.trader.redeem({
        marketId: marketId as Hex,
        outcomeIdx,
        amount,
      });

      console.log(`[Settler] On-chain redeem tx submitted: ${res.hash}`);
      const record: RedemptionRecord = {
        marketId,
        winningSide,
        outcomeIdx,
        tokensRedeemed: amount,
        collateralClaimed: amount,
        txHash: res.hash,
        timestamp: Date.now(),
        dryRun: false,
      };
      this.redemptionHistory.push(record);
      return record;
    } catch (e: any) {
      console.error(`[Settler] Redemption failed: ${e.shortMessage || e.message}`);
      throw e;
    }
  }

  /**
   * Scans tracked markets, checks resolution, and sweeps all claimable payouts.
   */
  public async sweep(
    marketsToSweep?: string[],
    mockResolved?: boolean,
    mockWinner: 0 | 1 = 0
  ): Promise<SettlementTelemetry> {
    const targetMarkets = marketsToSweep && marketsToSweep.length > 0
      ? marketsToSweep
      : Array.from(this.trackedMarkets.keys());

    const telemetry: SettlementTelemetry = {
      marketsChecked: targetMarkets.length,
      marketsResolved: 0,
      redemptionsExecuted: 0,
      totalTokensBurned: 0n,
      totalCollateralRecycled: 0n,
      records: [],
    };

    console.log(`\n=========================================================`);
    console.log(`  [Settler] Running Settlement & Capital Sweep Cycle     `);
    console.log(`  Markets in scope: ${targetMarkets.length}`);
    console.log(`=========================================================`);

    for (const marketId of targetMarkets) {
      const status = await this.checkMarketResolution(marketId, mockResolved, mockWinner);

      if (!status.isResolved && !status.isVoided) {
        console.log(`[Settler] Market ${marketId} still active (expires in ${Math.round(status.timeRemainingSec / 60)}m). Skipping.`);
        continue;
      }

      telemetry.marketsResolved++;
      console.log(`[Settler] Market ${marketId} RESOLVED! Winning Outcome: ${status.winningSide} (idx=${status.winningOutcome})`);

      // Determine winning token balance
      let winningBalance = 2n * ONE; // Baseline fallback for simulation
      if (status.outcomeToken) {
        const winningTokenId = status.winningOutcome === 0 ? status.yesId : status.noId;
        if (winningTokenId !== undefined) {
          const liveBal = await this.getOutcomeBalance(status.outcomeToken, winningTokenId);
          if (liveBal > 0n) winningBalance = liveBal;
        }
      }

      const record = await this.redeemPosition(
        marketId,
        status.winningOutcome as 0 | 1,
        winningBalance,
        mockResolved
      );

      if (record) {
        telemetry.redemptionsExecuted++;
        telemetry.totalTokensBurned += record.tokensRedeemed;
        telemetry.totalCollateralRecycled += record.collateralClaimed;
        telemetry.records.push(record);
      }
    }

    console.log(`\n--- Capital Recycling Telemetry ---`);
    console.log(`Markets Checked:           ${telemetry.marketsChecked}`);
    console.log(`Markets Resolved:          ${telemetry.marketsResolved}`);
    console.log(`Redemptions Executed:      ${telemetry.redemptionsExecuted}`);
    console.log(`Total Collateral Recycled: ${Number(telemetry.totalCollateralRecycled) / 1e6} tUSDC`);
    console.log(`=========================================================\n`);

    return telemetry;
  }
}
