# Somnia × DreamDEX Developer Feedback Report
### SDK, Binary Pool ABIs, and Testnet Ergonomics Evaluation
**Author:** Lead Web3 & Algorithmic Trading Engineer, *HedgePulse AI*  
**Scope:** `@somnia-chain/markets-sdk` (v0.28.1), DreamDEX Binary Pools (`IBinaryPool`, `IBinaryMarket`), Somnia Shannon Testnet (Chain ID `50312`).

---

## Executive Summary

Building **HedgePulse AI**—an autonomous algorithmic market-making and DeFi liquidation defense bot—demonstrated the power and speed of the Somnia Shannon testnet and DreamDEX event contract primitives. The sub-second finality and deterministic Cancun EVM execution on Shannon make high-frequency prediction market liquidity provision uniquely viable compared to high-fee Layer 1s.

Below is a structured evaluation highlighting 3 standout strengths, 3 critical developer friction points, and concrete code proposals for future SDK releases.

---

## 1. Top 3 Strengths

### 1. High-Speed Inclusion & Flat Gas Architecture
- **Impact:** Somnia's 60 gwei fee ceiling and sub-second block times eliminate the priority fee auctions typical of Ethereum and Arbitrum.
- **Why It Matters for Algorithmic Bots:** HedgePulse AI was able to continuously quote tight 180 bps two-sided spreads and execute instant `IOC` taker hedges without getting front-run or stuck in mempool congestion.

### 2. Clean Complete-Set Minting & Parity Mechanics
- **Impact:** The `ex.trader.mintSet({ pool, amount })` abstraction atomically handles ERC-20 collateral approvals, pulls collateral, and mints 1:1 YES (Up) and NO (Down) outcome tokens in a single transaction.
- **Why It Matters for Algorithmic Bots:** Market makers never have naked directional exposure. Inventory is minted in equal pairs and quoted symmetrically on both sides of the CLOB with mathematical parity ($P(\text{YES}) + P(\text{NO}) = 1.0$).

### 3. Decoupled On-Chain Reads from Indexer Dependency
- **Impact:** Functions such as `ex.client.getMarketOnchain`, `ex.client.getBinaryBookParams`, and `pub.getLogs({ event: MarketCreated })` read directly from the Cancun EVM.
- **Why It Matters for Algorithmic Bots:** In testnet environments where GraphQL indexers occasionally experience reorg lags or maintenance windows, the bot's core quoting loop and liquidation shield continued operating purely on-chain.

---

## 2. Top 3 Developer Friction Points & Concrete Suggestions

### Friction Point 1: Ambiguous Side Typing in Order Lifecycle Events
**Problem:**  
In the raw CLOB `orderBookEventsAbi`, the `OrderPlaced` event emits a generic `placedOrder` struct containing `isBid: bool` and `userData: uint64`. However, in a binary market, an order is actually one of four kinds (`BUY_YES`, `SELL_YES`, `BUY_NO`, `SELL_NO`). The SDK emits `BinaryOrderPlaced(orderId, kind)` separately, forcing bots to perform an asynchronous two-log join to reconstruct side attribution.

**Recommendation:**  
Introduce a unified SDK-level event stream or strongly typed helper `decodeBinaryOrderPlaced(log)`.

```typescript
// BEFORE: Manual two-step event reconstruction
const orderLog = logs.find(l => l.eventName === "OrderPlaced");
const binaryLog = logs.find(l => l.eventName === "BinaryOrderPlaced");
const side = binaryLog?.args.kind === 0 ? "BUY_YES" : "SELL_YES";

// AFTER (Proposed SDK Enhancement):
const binaryOrder = ex.client.parseBinaryOrderEvent(receipt);
// Returns: { orderId: 104n, side: "BUY_YES", price: 490000n, quantity: 2000000n }
```

---

### Friction Point 2: Unchecked `PostOnlyWouldCross()` Reverts
**Problem:**  
When an algorithmic market maker submits a `PostOnly` maker order (OrderType 3), if the market spread tightens such that the order would cross the top of book, the contract **reverts on-chain** (`PostOnlyWouldCross()`, selector `0xb99933ee`), rather than resting at the boundary or returning an execution status. This burns gas and throws an unhandled exception in standard trading loops.

**Recommendation:**  
Add a pre-flight method to the SDK: `ex.trader.quotePostOnlySafe({ pool, side, price, quantity })` that automatically adjusts the limit price by 1 tick outside the best crossing level.

```typescript
// BEFORE: Manual error-trapping boilerplate in user code
try {
  await ex.trader.placeOrder({ pool, side: "SELL_YES", price, quantity, orderType: 3 });
} catch (e: any) {
  if (e.message.includes("PostOnlyWouldCross") || e.message.includes("0xb99933ee")) {
    console.warn("Spread too tight; swallowed PostOnlyWouldCross revert.");
  } else {
    throw e;
  }
}

// AFTER (Proposed SDK Enhancement):
// SDK provides auto-clamping or a pre-checked safe placement
await ex.trader.placeOrderSafe({
  pool,
  side: "SELL_YES",
  price,
  quantity,
  orderType: ORDER_TYPE.POST_ONLY,
  clampToBook: true // Auto-clamps to bestBid + tickSize if crossing
});
```

---

### Friction Point 3: Lack of First-Class `amendOrder` in `SomniaMarkets`
**Problem:**  
`IBinaryPool` supports `amendOrder(oldOrderId, newOrder)` which atomically cancels a resting order and places its replacement in a single transaction. However, the high-level `ex.trader` namespace only surfaces separate `cancelOrder()` and `placeOrder()` calls. When price drifts by multiple ticks, an agent must send two round-trip transactions, introducing nonce contention and risking partial fills in between.

**Recommendation:**  
Expose `ex.trader.amendOrder({ pool, oldOrderId, side, newPrice, newQuantity })` directly in the high-level exchange interface.

```typescript
// BEFORE: Two separate network round-trips
await ex.trader.cancelOrder({ pool, orderId: oldOrderId });
const newOrder = await ex.trader.placeOrder({ pool, side, price: newPrice, quantity, orderType: 3 });

// AFTER (Proposed SDK Enhancement):
// Single atomic transaction utilizing IBinaryPool.amendOrder
const amended = await ex.trader.amendOrder({
  pool,
  oldOrderId,
  newPrice,
  newQuantity,
  orderType: ORDER_TYPE.POST_ONLY
});
```

---

## 3. Summary Scorecard

| Dimension | Rating (1-5★) | Commentary |
| :--- | :---: | :--- |
| **Execution Speed & Finality** | ★★★★★ | Somnia Shannon testnet provides near-instant finality with zero mempool congestion. |
| **Prediction Market Primitives** | ★★★★★ | Complete set minting (`mintSet`) and 1:1 parity resolution are mathematically elegant. |
| **SDK Read Ergonomics** | ★★★★☆ | Rich querying API (`getMarketOnchain`, `getOutcomeBalance`), with indexer fallback resilience. |
| **SDK Order Management** | ★★★☆☆ | Needs native `amendOrder` exposure and crossing pre-flight guards to prevent `PostOnlyWouldCross`. |
| **Documentation & Typings** | ★★★★☆ | Excellent TypeScript types in `@somnia-chain/markets-sdk`; could benefit from expanded lending integration examples. |

---

*HedgePulse AI demonstrates that Somnia's high throughput combined with DreamDEX binary event contracts creates a premier foundation for institutional-grade autonomous DeFi market making and cross-protocol hedging.*
