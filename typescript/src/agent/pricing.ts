/**
 * HedgePulse AI - Module 1: Quantitative Pricing Engine
 * 
 * Implements the Black-Scholes Cash-or-Nothing Digital Option model for
 * DreamDEX binary event contracts on Somnia Shannon Testnet.
 *
 * Payoff Structure:
 *   YES (Up) pays 1 collateral if S_T >= K, 0 otherwise.
 *   NO (Down) pays 1 collateral if S_T < K, 0 otherwise.
 *
 * Under Black-Scholes risk-neutral dynamics:
 *   dS_t = r S_t dt + \sigma S_t dW_t
 *   ln(S_T / S_0) ~ N((r - 0.5 * \sigma^2) * T, \sigma^2 * T)
 *
 * Fair YES probability (undiscounted):
 *   P(S_T >= K) = \Phi(d_2)
 * where:
 *   d_1 = [ln(S_0 / K) + (r + 0.5 * \sigma^2) * T] / (\sigma * \sqrt{T})
 *   d_2 = d_1 - \sigma * \sqrt{T} = [ln(S_0 / K) + (r - 0.5 * \sigma^2) * T] / (\sigma * \sqrt{T})
 *   \Phi(x) = 0.5 * [1 + erf(x / \sqrt{2})]
 */

export const SECONDS_PER_YEAR = 365.25 * 86400; // 31,557,600 seconds
export const PRICE_SCALE = 1_000_000n; // 1e6 units (probability 1.0 = 1_000_000n)
export const MIN_TICK_PRICE = 10_000n; // 0.01 (1% probability floor to prevent book lock)
export const MAX_TICK_PRICE = 990_000n; // 0.99 (99% probability cap to prevent cross-revert)

export interface PricingInputs {
  /** Current underlying spot price (e.g., BTC/USD or SOMI/USD) */
  spot: number;
  /** Strike price of the binary contract window */
  strike: number;
  /** Time remaining until market expiration in seconds */
  timeToExpirySec: number;
  /** Annualized asset volatility sigma (e.g., 0.55 = 55% annualized vol) */
  volatility: number;
  /** Annualized risk-free interest rate r (defaults to 0.0 on short horizons) */
  riskFreeRate?: number;
}

export interface Greeks {
  /** Delta: d(Price) / d(Spot) */
  delta: number;
  /** Gamma: d^2(Price) / d(Spot)^2 */
  gamma: number;
  /** Vega: d(Price) / d(Volatility) */
  vega: number;
  /** Theta: d(Price) / d(Time in seconds) */
  theta: number;
}

export interface PricingOutputs {
  /** Risk-neutral YES probability \Phi(d_2) in [0.0, 1.0] */
  fairProbabilityYes: number;
  /** Risk-neutral NO probability 1 - \Phi(d_2) in [0.0, 1.0] */
  fairProbabilityNo: number;
  /** Fair YES price in DreamDEX 1e6 probability base units */
  priceYes: bigint;
  /** Fair NO price in DreamDEX 1e6 probability base units */
  priceNo: bigint;
  /** Black-Scholes d1 parameter */
  d1: number;
  /** Black-Scholes d2 parameter */
  d2: number;
  /** Standard Greeks for risk management and delta-hedging */
  greeks: Greeks;
}

export interface TwoSidedQuotes {
  /** Bid price for YES contract (1e6 units) */
  yesBid: bigint;
  /** Ask price for YES contract (1e6 units) */
  yesAsk: bigint;
  /** Bid price for NO contract (1e6 units) */
  noBid: bigint;
  /** Ask price for NO contract (1e6 units) */
  noAsk: bigint;
  /** Applied half-spread in basis points */
  halfSpreadBps: number;
}

/**
 * High-accuracy error function approximation (Abramowitz & Stegun 7.1.26)
 * Maximum absolute error: < 1.5e-7 across all inputs.
 */
export function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * absX);
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const y = 1.0 - poly * Math.exp(-absX * absX);

  return sign * y;
}

/**
 * Standard Normal Cumulative Distribution Function \Phi(x)
 */
export function normalCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.SQRT2));
}

/**
 * Standard Normal Probability Density Function \phi(x)
 */
export function normalPdf(x: number): number {
  return (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

/**
 * Calculates fair binary option probabilities and Greeks using Black-Scholes.
 */
export function calculateBinaryPricing(inputs: PricingInputs): PricingOutputs {
  const { spot, strike, timeToExpirySec, volatility, riskFreeRate = 0.0 } = inputs;

  if (spot <= 0 || strike <= 0) {
    throw new Error(`Invalid price parameters: spot=${spot}, strike=${strike} must be > 0`);
  }

  // Handle immediate expiration or zero/negative time
  if (timeToExpirySec <= 0) {
    const expiredYes = spot >= strike ? 1.0 : 0.0;
    const expiredNo = 1.0 - expiredYes;
    return {
      fairProbabilityYes: expiredYes,
      fairProbabilityNo: expiredNo,
      priceYes: BigInt(Math.round(expiredYes * 1_000_000)),
      priceNo: BigInt(Math.round(expiredNo * 1_000_000)),
      d1: spot >= strike ? Infinity : -Infinity,
      d2: spot >= strike ? Infinity : -Infinity,
      greeks: { delta: 0, gamma: 0, vega: 0, theta: 0 },
    };
  }

  const T = Math.max(timeToExpirySec / SECONDS_PER_YEAR, 1e-7);
  const sigma = Math.max(volatility, 1e-4);
  const sqrtT = Math.sqrt(T);

  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  // Fair binary YES probability is \Phi(d_2)
  const fairProbabilityYes = Math.max(0.0001, Math.min(0.9999, normalCdf(d2)));
  const fairProbabilityNo = 1.0 - fairProbabilityYes;

  // Calculate Greeks for digital cash-or-nothing call
  const discountFactor = Math.exp(-riskFreeRate * T);
  const pdfD2 = normalPdf(d2);

  // Digital Call Delta: e^(-rT) * \phi(d_2) / (S * \sigma * \sqrt{T})
  const delta = (discountFactor * pdfD2) / (spot * sigma * sqrtT);

  // Digital Call Gamma: -e^(-rT) * \phi(d_2) / (S^2 * \sigma * \sqrt{T}) * (1 + d_1 / (\sigma * \sqrt{T}))
  const gamma = -(discountFactor * pdfD2) / (spot * spot * sigma * sqrtT) * (1.0 + d1 / (sigma * sqrtT));

  // Digital Call Vega: -e^(-rT) * \phi(d_2) * (d_1 / \sigma)
  const vega = -discountFactor * pdfD2 * (d1 / sigma);

  // Digital Call Theta (per second decay)
  const thetaPerYear = (discountFactor * pdfD2 * d1) / (2 * T);
  const theta = thetaPerYear / SECONDS_PER_YEAR;

  // Convert to DreamDEX 1e6 fixed point representation
  const priceYes = BigInt(Math.round(fairProbabilityYes * 1_000_000));
  const priceNo = BigInt(Math.round(fairProbabilityNo * 1_000_000));

  return {
    fairProbabilityYes,
    fairProbabilityNo,
    priceYes,
    priceNo,
    d1,
    d2,
    greeks: {
      delta,
      gamma,
      vega,
      theta,
    },
  };
}

/**
 * Discretizes a raw price to the order book's tick grid.
 * @param price Raw 1e6 price
 * @param tickSize Order book tick size (e.g. 10_000n = 0.01)
 * @param roundUp If true, round to ceiling; otherwise round to floor
 */
export function discretizeToTick(price: bigint, tickSize: bigint = 10_000n, roundUp: boolean = false): bigint {
  if (tickSize <= 1n) return price;
  if (roundUp) {
    return ((price + tickSize - 1n) / tickSize) * tickSize;
  }
  return (price / tickSize) * tickSize;
}

/**
 * Computes two-sided quotes (Bid/Ask) centered around fair value with a configurable spread.
 * Spread is expressed in basis points (e.g., 150 to 200 bps = 1.5% to 2.0%).
 * 
 * Safety features:
 * - Bounded by MIN_TICK_PRICE (0.01) and MAX_TICK_PRICE (0.99) to avoid crossing/reverting
 * - Automatically snaps to the specified tick grid
 * - Bid is strictly less than Ask
 */
export function generateTwoSidedQuotes(
  fairPriceYes: bigint,
  spreadBps: number = 180, // Default 180 bps (1.8% full spread => +/- 90 bps)
  tickSize: bigint = 10_000n
): TwoSidedQuotes {
  const halfSpreadBps = spreadBps / 2;
  const spreadFactor = BigInt(Math.round(halfSpreadBps * 100)); // in 1e6 basis: 90 bps = 9_000

  // Calculate YES quotes
  let yesBid = fairPriceYes - spreadFactor;
  let yesAsk = fairPriceYes + spreadFactor;

  // Align to tick grid: bid floors, ask ceils
  yesBid = discretizeToTick(yesBid, tickSize, false);
  yesAsk = discretizeToTick(yesAsk, tickSize, true);

  // Clamp within safe rest boundaries
  if (yesBid < MIN_TICK_PRICE) yesBid = MIN_TICK_PRICE;
  if (yesAsk > MAX_TICK_PRICE) yesAsk = MAX_TICK_PRICE;
  if (yesBid >= yesAsk) {
    yesBid = yesAsk - tickSize;
    if (yesBid < MIN_TICK_PRICE) yesBid = MIN_TICK_PRICE;
  }

  // Calculate NO quotes by complete-set parity (NO = 1 - YES)
  const fairPriceNo = PRICE_SCALE - fairPriceYes;
  let noBid = fairPriceNo - spreadFactor;
  let noAsk = fairPriceNo + spreadFactor;

  noBid = discretizeToTick(noBid, tickSize, false);
  noAsk = discretizeToTick(noAsk, tickSize, true);

  if (noBid < MIN_TICK_PRICE) noBid = MIN_TICK_PRICE;
  if (noAsk > MAX_TICK_PRICE) noAsk = MAX_TICK_PRICE;
  if (noBid >= noAsk) {
    noBid = noAsk - tickSize;
    if (noBid < MIN_TICK_PRICE) noBid = MIN_TICK_PRICE;
  }

  return {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    halfSpreadBps,
  };
}
