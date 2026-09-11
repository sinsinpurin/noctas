import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BacktestRequest, StrategyGraph } from "@noctas/shared";
import { config } from "../config";
import type { CandleBucket } from "./botEngine";

// backtestEngine.ts pulls in strategy/botEngine.ts only for getCandlesForTimeframe(); replace it
// with a controllable stub so tests don't depend on the live candle buffer / bitbank REST seeding.
const getCandlesForTimeframe = vi.fn<(pair: string, timeframe: string) => CandleBucket[]>();
vi.mock("./botEngine", () => ({
  getCandlesForTimeframe: (...args: [string, string]) => getCandlesForTimeframe(...args),
}));

// resolveExitReason (trading/riskManager.ts) and executionPrice/feeOf (trading/paperTradingEngine.ts)
// are imported for real (they're pure, config-only functions) so this test doubles as verification
// that the backtest reuses - rather than reimplements - the live fee/slippage/exit-priority logic.
// Their modules still import ../db/prisma at the top level, so it's mocked here purely to avoid
// constructing a real PrismaClient during the test run (matches the pattern in riskManager.test.ts).
vi.mock("../db/prisma", () => ({ prisma: {} }));

const { runBacktest } = await import("./backtestEngine");

function candle(time: number, close: number, overrides: Partial<CandleBucket> = {}): CandleBucket {
  return {
    time,
    open: overrides.open ?? close,
    high: overrides.high ?? close,
    low: overrides.low ?? close,
    close,
    volume: overrides.volume ?? 0,
  };
}

/** price > 100 で買い、price < 100 で売る単純な比較ノード戦略(SMAクロスの代わりに決定的な数値で検証する) */
function compareThresholdGraph(): StrategyGraph {
  return {
    nodes: [
      { id: "price", type: "price", params: {}, position: { x: 0, y: 0 } },
      { id: "const100", type: "constant", params: { value: 100 }, position: { x: 0, y: 0 } },
      { id: "gt100", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "lt100", type: "compare", params: { op: "lt" }, position: { x: 0, y: 0 } },
      { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
      { id: "sell1", type: "sell", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "price", target: "gt100", targetHandle: "a" },
      { id: "e2", source: "const100", target: "gt100", targetHandle: "b" },
      { id: "e3", source: "price", target: "lt100", targetHandle: "a" },
      { id: "e4", source: "const100", target: "lt100", targetHandle: "b" },
      { id: "e5", source: "gt100", target: "buy1", targetHandle: "condition" },
      { id: "e6", source: "lt100", target: "sell1", targetHandle: "condition" },
    ],
  };
}

/**
 * price > 50 で一度だけ買う(buyのみ、sellノード無し)グラフ。SL/TP/トレーリングの単体検証用。
 * 最初の足だけ条件を偽にしておくことで、2本目で確実に立ち上がりエッジ(買い)が発生する。
 */
function buyOnceGraph(): StrategyGraph {
  return {
    nodes: [
      { id: "price", type: "price", params: {}, position: { x: 0, y: 0 } },
      { id: "const50", type: "constant", params: { value: 50 }, position: { x: 0, y: 0 } },
      { id: "gt50", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "price", target: "gt50", targetHandle: "a" },
      { id: "e2", source: "const50", target: "gt50", targetHandle: "b" },
      { id: "e3", source: "gt50", target: "buy1", targetHandle: "condition" },
    ],
  };
}

/** price > 100 で買う(sellノード無し)、価格が上下に振動するとその都度立ち上がりエッジで買おうとするグラフ */
function buyOnlyOscillatingGraph(): StrategyGraph {
  return {
    nodes: [
      { id: "price", type: "price", params: {}, position: { x: 0, y: 0 } },
      { id: "const100", type: "constant", params: { value: 100 }, position: { x: 0, y: 0 } },
      { id: "gt100", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "price", target: "gt100", targetHandle: "a" },
      { id: "e2", source: "const100", target: "gt100", targetHandle: "b" },
      { id: "e3", source: "gt100", target: "buy1", targetHandle: "condition" },
    ],
  };
}

/**
 * price > 100 で買い、price > 100.1 で売る(sellノードの閾値がbuyより少しだけ高い)グラフ。
 * 買い→売りの間の値動きが小さいシナリオ(方向は合っているが往復手数料を下回る値幅)を作るための専用グラフ。
 */
function buyThenSmallFavorableExitGraph(): StrategyGraph {
  return {
    nodes: [
      { id: "price", type: "price", params: {}, position: { x: 0, y: 0 } },
      { id: "constBuy", type: "constant", params: { value: 100 }, position: { x: 0, y: 0 } },
      { id: "gtBuy", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
      { id: "constSell", type: "constant", params: { value: 100.1 }, position: { x: 0, y: 0 } },
      { id: "gtSell", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "sell1", type: "sell", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "price", target: "gtBuy", targetHandle: "a" },
      { id: "e2", source: "constBuy", target: "gtBuy", targetHandle: "b" },
      { id: "e3", source: "gtBuy", target: "buy1", targetHandle: "condition" },
      { id: "e4", source: "price", target: "gtSell", targetHandle: "a" },
      { id: "e5", source: "constSell", target: "gtSell", targetHandle: "b" },
      { id: "e6", source: "gtSell", target: "sell1", targetHandle: "condition" },
    ],
  };
}

function baseRequest(overrides: Partial<BacktestRequest> = {}): BacktestRequest {
  return {
    graph: compareThresholdGraph(),
    pair: "btc_jpy",
    timeframe: "1min",
    ...overrides,
  };
}

beforeEach(() => {
  getCandlesForTimeframe.mockReset();
});

describe("runBacktest / insufficient data", () => {
  it("returns an empty summary with a warning when there are fewer than 2 candles", () => {
    getCandlesForTimeframe.mockReturnValue([candle(0, 100)]);
    const result = runBacktest(baseRequest());
    expect(result.candleCount).toBe(1);
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
    expect(result.warnings.some((w) => w.includes("最低2本"))).toBe(true);
  });

  it("returns an empty summary for zero candles", () => {
    getCandlesForTimeframe.mockReturnValue([]);
    const result = runBacktest(baseRequest());
    expect(result.candleCount).toBe(0);
    expect(result.trades).toEqual([]);
  });
});

describe("runBacktest / buy-sell round trip matches paperTradingEngine's fee & slippage formulas", () => {
  it("opens on the rising edge of the buy condition and closes on the falling edge of the sell condition", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 100),
      candle(60, 100),
      candle(120, 105), // buy edge fires here (100 -> 105, crosses above the compare threshold)
      candle(180, 105), // no new edge
      candle(240, 95), // sell edge fires here (105 -> 95, crosses below)
      candle(300, 95),
    ]);

    const result = runBacktest(
      baseRequest({
        positionSizeJpy: 10_000,
        // disable SL/TP/trailing so only the strategy's own sell condition closes the position
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.closeReason).toBe("bot_strategy");
    expect(trade.openedAt).toBe(120_000);
    expect(trade.closedAt).toBe(240_000);

    const slip = config.fees.slippagePct / 100;
    const feePct = config.fees.takerFeePct / 100;
    const buyExecPrice = 105 * (1 + slip);
    const amount = 10_000 / buyExecPrice;
    const entryFee = 10_000 * feePct;
    const sellExecPrice = 95 * (1 - slip);
    const proceeds = sellExecPrice * amount;
    const exitFee = proceeds * feePct;
    const expectedPnl = (sellExecPrice - buyExecPrice) * amount - entryFee - exitFee;

    expect(trade.entryPrice).toBeCloseTo(buyExecPrice, 8);
    expect(trade.amount).toBeCloseTo(amount, 8);
    expect(trade.closePrice).toBeCloseTo(sellExecPrice, 8);
    expect(trade.pnl).toBeCloseTo(expectedPnl, 6);
    expect(trade.totalFeeJpy).toBeCloseTo(entryFee + exitFee, 8);
    expect(result.realizedPnl).toBeCloseTo(expectedPnl, 6);
    expect(result.totalFeesJpy).toBeCloseTo(entryFee + exitFee, 8);
    expect(result.equityCurve).toEqual([{ time: 240, value: result.realizedPnl }]);
    // this scenario is a losing trade (100 -> 105 -> 95), so it should show up as a loss, not a win
    expect(result.lossCount).toBe(1);
    expect(result.winCount).toBe(0);
  });

  it("does not fire again on the same still-true condition (edge-triggered, not level-triggered)", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 100),
      candle(60, 105),
      candle(120, 106),
      candle(180, 107), // still > 100 the whole time; only one buy should ever fire
    ]);
    const result = runBacktest(
      baseRequest({ positionSizeJpy: 10_000, stopLossPct: 100, takeProfitPct: 0, trailingStopPct: null })
    );
    // no sell edge occurs, so the position stays open and produces no closed trade
    expect(result.trades).toHaveLength(0);
  });
});

describe("runBacktest / exit priority and the conservative same-candle approximation", () => {
  it("prioritizes trailing_stop over stop_loss when both trigger on the candle's low (matches live priority)", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0), // condition false (0 <= 50)
      candle(60, 100), // buy edge fires (0 -> 100 crosses above 50); entry price basis ~100
      // this candle both raises the peak to 130 (high) and, on the low, breaches a 1% trailing
      // stop from that new peak; a 50% stop-loss would never trip here regardless
      candle(120, 100, { high: 130, low: 130 * (1 - 0.01) - 1 }),
    ]);
    const result = runBacktest(
      baseRequest({
        graph: buyOnceGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 50,
        takeProfitPct: 0,
        trailingStopPct: 1,
      })
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].closeReason).toBe("trailing_stop");
  });

  it("treats a same-candle stop-loss (low) as happening before a take-profit (high) - conservative approximation", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0),
      candle(60, 100), // buy edge fires, entry price basis ~100
      // this candle's high clears +5% take-profit AND its low clears -5% stop-loss at once;
      // the backtest must assume the worst case (stop_loss) rather than take_profit
      candle(120, 100, { high: 110, low: 90 }),
    ]);
    const result = runBacktest(
      baseRequest({
        graph: buyOnceGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 5,
        takeProfitPct: 5,
        trailingStopPct: null,
      })
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].closeReason).toBe("stop_loss");
  });

  it("still resolves take_profit when only the high clears it and the low never threatens stop_loss/trailing", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0),
      candle(60, 100), // buy edge fires, entry price basis ~100
      candle(120, 100, { high: 110, low: 99 }), // +10% high clears +5% take-profit; low stays well inside
    ]);
    const result = runBacktest(
      baseRequest({
        graph: buyOnceGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 50,
        takeProfitPct: 5,
        trailingStopPct: null,
      })
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].closeReason).toBe("take_profit");
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });
});

describe("runBacktest / ai_judgment nodes never fire and surface a warning", () => {
  it("treats an ai_judgment-gated buy condition as always-false and warns that it can't be replayed", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "judge", type: "ai_judgment", params: { expect: "buy", minConfidence: 0 }, position: { x: 0, y: 0 } },
        { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", source: "judge", target: "buy1", targetHandle: "condition" }],
    };
    getCandlesForTimeframe.mockReturnValue([candle(0, 100), candle(60, 100), candle(120, 100)]);
    const result = runBacktest(baseRequest({ graph }));
    expect(result.trades).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("AI Judgment"))).toBe(true);
  });
});

describe("runBacktest / fee-loss detection (direction correct, fees erase the profit)", () => {
  it("counts a trade where price moved in the trade's favor but net pnl is <= 0 due to fees as a feeLossCount", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 90), // buy/sell conditions both false
      candle(60, 100.01), // buy edge fires (90 -> 100.01 crosses above 100)
      candle(120, 100.16), // sell edge fires (100.01 -> 100.16 crosses above 100.1); price kept moving in the buy's favor
    ]);

    const result = runBacktest(
      baseRequest({
        graph: buyThenSmallFavorableExitGraph(),
        positionSizeJpy: 10_000,
        // disable SL/TP/trailing so only the strategy's own sell condition closes the position
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.closeReason).toBe("bot_strategy");

    const slip = config.fees.slippagePct / 100;
    const feePct = config.fees.takerFeePct / 100;
    const buyExecPrice = 100.01 * (1 + slip);
    const amount = 10_000 / buyExecPrice;
    const entryFee = 10_000 * feePct;
    const sellExecPrice = 100.16 * (1 - slip);
    const proceeds = sellExecPrice * amount;
    const exitFee = proceeds * feePct;
    const grossPnl = (sellExecPrice - buyExecPrice) * amount;
    const netPnl = grossPnl - entryFee - exitFee;

    // このシナリオ自体の前提を確認する: 値動きの方向は建玉に有利(gross > 0)だが、
    // 往復手数料(~0.28%)が値幅(~0.15%)を上回るため、手数料込みの純損益は0以下になる
    expect(grossPnl).toBeGreaterThan(0);
    expect(netPnl).toBeLessThanOrEqual(0);

    expect(trade.pnl).toBeCloseTo(netPnl, 6);
    expect(result.grossPnlJpy).toBeCloseTo(grossPnl, 6);
    expect(result.feeLossCount).toBe(1);
  });

  it("does not count a trade as a fee-loss when the direction itself was wrong", () => {
    // 既存の「素直に逆方向に負けた」ラウンドトリップ(100 -> 105 -> 95)を再利用する。
    // 値動きの方向自体が建玉と逆なので、lossCountには入るがfeeLossCountには入らないはず
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 100),
      candle(60, 100),
      candle(120, 105),
      candle(180, 105),
      candle(240, 95),
      candle(300, 95),
    ]);
    const result = runBacktest(
      baseRequest({
        positionSizeJpy: 10_000,
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );
    expect(result.trades).toHaveLength(1);
    expect(result.lossCount).toBe(1);
    expect(result.feeLossCount).toBe(0);
    expect(result.grossPnlJpy).toBeLessThan(0);
  });
});

describe("runBacktest / volume node", () => {
  /**
   * volume -> sma(period 3, fed by volume) -> cross(a=volume, b=volSma) -> buy/sell.
   * Price stays flat at 100 the whole time so any trade timing is driven purely by the
   * volume spike, not by price crossing anything.
   */
  function volumeSpikeGraph(): StrategyGraph {
    return {
      nodes: [
        { id: "vol", type: "volume", params: {}, position: { x: 0, y: 0 } },
        { id: "volSma", type: "sma", params: { period: 3 }, position: { x: 0, y: 0 } },
        { id: "spikeUp", type: "cross", params: { op: "cross_above" }, position: { x: 0, y: 0 } },
        { id: "spikeDown", type: "cross", params: { op: "cross_below" }, position: { x: 0, y: 0 } },
        { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
        { id: "sell1", type: "sell", params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "vol", target: "volSma", targetHandle: "in" },
        { id: "e2", source: "vol", target: "spikeUp", targetHandle: "a" },
        { id: "e3", source: "volSma", target: "spikeUp", targetHandle: "b" },
        { id: "e4", source: "vol", target: "spikeDown", targetHandle: "a" },
        { id: "e5", source: "volSma", target: "spikeDown", targetHandle: "b" },
        { id: "e6", source: "spikeUp", target: "buy1", targetHandle: "condition" },
        { id: "e7", source: "spikeDown", target: "sell1", targetHandle: "condition" },
      ],
    };
  }

  it("only trades at the exact tick volume spikes above (buy) and then reverts below (sell) its own moving average", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 100, { volume: 10 }),
      candle(60, 100, { volume: 10 }),
      candle(120, 100, { volume: 10 }),
      candle(180, 100, { volume: 50 }), // spike: volume crosses above sma(3)=10 -> buy edge
      candle(240, 100, { volume: 10 }), // reverts: volume crosses below sma(3)=23.33 -> sell edge
    ]);

    const result = runBacktest(
      baseRequest({
        graph: volumeSpikeGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].openedAt).toBe(180_000);
    expect(result.trades[0].closedAt).toBe(240_000);
    expect(result.trades[0].closeReason).toBe("bot_strategy");
  });

  it("never trades when volume stays flat (no spike to cross the moving average)", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 100, { volume: 10 }),
      candle(60, 100, { volume: 10 }),
      candle(120, 100, { volume: 10 }),
      candle(180, 100, { volume: 10 }),
      candle(240, 100, { volume: 10 }),
    ]);

    const result = runBacktest(
      baseRequest({
        graph: volumeSpikeGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(0);
  });
});

describe("runBacktest / time_filter node", () => {
  // Maps a JST clock hour to a UNIX epoch second (UTC) whose JST hour equals it, mirroring
  // the (hourUTC + 9) % 24 conversion done inside evaluateGraph's time_filter case.
  function tsForJstHour(hour: number): number {
    return 86_400 + (((hour - 9 + 24) % 24) * 3600);
  }

  /** price > 50 AND time_filter(2-6時 除外) -> buy. No sell node; SL/TP disabled in the request. */
  function timeFilteredBuyGraph(): StrategyGraph {
    return {
      nodes: [
        { id: "price", type: "price", params: {}, position: { x: 0, y: 0 } },
        { id: "const50", type: "constant", params: { value: 50 }, position: { x: 0, y: 0 } },
        { id: "gt50", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
        {
          id: "tf",
          type: "time_filter",
          params: { excludeStartHour: 2, excludeEndHour: 6 },
          position: { x: 0, y: 0 },
        },
        { id: "and1", type: "logic", params: { op: "and" }, position: { x: 0, y: 0 } },
        { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "price", target: "gt50", targetHandle: "a" },
        { id: "e2", source: "const50", target: "gt50", targetHandle: "b" },
        { id: "e3", source: "gt50", target: "and1", targetHandle: "a" },
        { id: "e4", source: "tf", target: "and1", targetHandle: "b" },
        { id: "e5", source: "and1", target: "buy1", targetHandle: "condition" },
      ],
    };
  }

  it("only opens on the tick the excluded window ends, not on the earlier tick inside it (AND rises even though price alone had already crossed)", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0),
      candle(tsForJstHour(3), 100), // inside excluded window -> no buy despite price > 50
      candle(tsForJstHour(10), 100), // outside excluded window -> buy fires here (edge on the AND output)
      // +5% take-profit clears via this candle's high, closing the position so we can inspect openedAt
      candle(tsForJstHour(11), 100, { high: 110, low: 99 }),
    ]);

    const result = runBacktest(
      baseRequest({
        graph: timeFilteredBuyGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 50,
        takeProfitPct: 5,
        trailingStopPct: null,
      })
    );

    // if the buy had fired on the earlier (excluded-hour) tick instead, openedAt would be
    // tsForJstHour(3) * 1000 - asserting the outside-hour tick proves the excluded-hour tick was blocked
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].openedAt).toBe(tsForJstHour(10) * 1000);
    expect(result.trades[0].closeReason).toBe("take_profit");
  });
});

describe("runBacktest / maxOpenPositions caps concurrent simulated positions", () => {
  it("blocks a second buy edge while at the cap, so a later take-profit only closes the one allowed position", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 90), // condition false
      candle(60, 110), // buy edge #1 -> opens position A (~110)
      candle(120, 90), // condition false again (falling edge, no action)
      candle(180, 110), // buy edge #2 -> would open position B, but the cap (1) should block it
      candle(240, 130), // clears +5% take-profit for position A (and would for B too, if it existed)
    ]);
    const result = runBacktest(
      baseRequest({
        graph: buyOnlyOscillatingGraph(),
        maxOpenPositions: 1,
        positionSizeJpy: 10_000,
        stopLossPct: 100,
        takeProfitPct: 5,
        trailingStopPct: null,
      })
    );
    // if the cap didn't hold, both position A and the blocked position B would have cleared
    // take-profit on the final candle, producing 2 trades instead of 1
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].closeReason).toBe("take_profit");
  });
});

describe("runBacktest / liquidation equity includes open positions", () => {
  it("reports end-of-period unrealized loss and drawdown even when no trade was closed", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0),
      candle(60, 100), // buy edge
      candle(120, 90), // remains open; no sell edge and SL is disabled
    ]);

    const result = runBacktest(
      baseRequest({
        graph: buyOnceGraph(),
        positionSizeJpy: 10_000,
        initialBalanceJpy: 100_000,
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(0);
    expect(result.realizedPnl).toBe(0);
    expect(result.unrealizedPnl).toBeLessThan(0);
    expect(result.endingEquityJpy).toBeLessThan(100_000);
    expect(result.liquidationMaxDrawdown).toBeGreaterThan(0);
    expect(result.liquidationEquityCurve.at(-1)?.value).toBe(result.endingEquityJpy);
  });
});

describe("runBacktest / execution timing and price gaps", () => {
  it("executes strategy signals at the next candle open in closed-bar mode", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 90),
      candle(60, 110), // buy signal is observed at this close
      candle(120, 120, { open: 120 }), // pending buy executes here
      candle(180, 90, { open: 100 }), // sell signal is observed at this close
      candle(240, 80, { open: 80 }), // pending sell executes here
    ]);

    const result = runBacktest(
      baseRequest({
        executionMode: "closed_bar_next_tick",
        positionSizeJpy: 10_000,
        stopLossPct: 100,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].openedAt).toBe(120_000);
    expect(result.trades[0].closedAt).toBe(240_000);
    expect(result.trades[0].entryPrice).toBeCloseTo(120 * (1 + config.fees.slippagePct / 100), 8);
    expect(result.trades[0].closePrice).toBeCloseTo(80 * (1 - config.fees.slippagePct / 100), 8);
  });

  it("uses the candle open when a stop is crossed by a downward price gap", () => {
    getCandlesForTimeframe.mockReturnValue([
      candle(0, 0),
      candle(60, 100),
      candle(120, 80, { open: 80, high: 100, low: 80 }),
    ]);

    const result = runBacktest(
      baseRequest({
        graph: buyOnceGraph(),
        positionSizeJpy: 10_000,
        stopLossPct: 5,
        takeProfitPct: 0,
        trailingStopPct: null,
      })
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].closeReason).toBe("stop_loss");
    expect(result.trades[0].closePrice).toBeCloseTo(80 * (1 - config.fees.slippagePct / 100), 8);
  });
});
