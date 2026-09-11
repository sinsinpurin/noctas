import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalkForwardSummary } from "@noctas/shared";
import { config } from "../config";
import type { CandleBucket } from "./botEngine";

// routes.ts (and everything it transitively imports - botEngine.ts, historicalCandleStore.ts,
// ai/*.ts) reaches "../db/prisma" at module scope; mock it here purely to avoid constructing a
// real PrismaClient during the test run (matches the pattern in historicalCandleStore.test.ts).
const strategyFindMany = vi.fn();
const strategyFindUnique = vi.fn();
const strategyUpdate = vi.fn();
vi.mock("../db/prisma", () => ({
  prisma: {
    strategy: {
      findMany: (...args: unknown[]) => strategyFindMany(...args),
      findUnique: (...args: unknown[]) => strategyFindUnique(...args),
      update: (...args: unknown[]) => strategyUpdate(...args),
    },
  },
}));
const broadcast = vi.fn();
vi.mock("../ws/relay", () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));
vi.mock("../ai/strategyGenerator", () => ({ generateStrategyFromPrompt: vi.fn() }));
vi.mock("../ai/anthropicClient", () => ({ getAnthropicApiKey: vi.fn(() => "test-key") }));

const getHistoricalCandles = vi.fn<(pair: string) => Promise<CandleBucket[]>>();
vi.mock("./historicalCandleStore", () => ({
  getHistoricalCandles: (...args: [string]) => getHistoricalCandles(...args),
}));

// aggregateCandlesの集計の正しさそのものはbotEngine側でカバーされている。ここでの関心は
// ルートがpair+timeframeの組み合わせごとに1回だけ呼び出す(キャッシュされる)ことなので、
// 時間足(minutes)に応じて単純に件数を間引くだけの軽量なスタブに差し替える。
const aggregateCandles = vi.fn((raw: CandleBucket[], minutes: number) =>
  raw.slice(0, Math.floor(raw.length / minutes))
);
const reloadActiveStrategies = vi.fn();
vi.mock("./botEngine", () => ({
  aggregateCandles: (...args: [CandleBucket[], number]) => aggregateCandles(...args),
  reloadActiveStrategies: (...args: unknown[]) => reloadActiveStrategies(...args),
}));

// runBacktest itself is stubbed out (its own O(n²) behavior/correctness is covered by
// backtestEngine.test.ts); THREE_MONTH_BACKTEST_MAX_CANDLES is imported for real from the actual
// module so the test asserts against the same threshold routes.ts enforces, not a duplicated copy.
const runBacktest = vi.fn();
vi.mock("./backtestEngine", async () => {
  const actual = await vi.importActual<typeof import("./backtestEngine")>("./backtestEngine");
  return {
    ...actual,
    runBacktest: (...args: unknown[]) => runBacktest(...args),
  };
});

// runWalkForwardForStrategy自体の正しさ(ウィンドウ分割・グリッドサーチ・集計)は
// walkForwardEngine.test.tsでカバーする。ここではルート側の責務(戦略の取得・検証・
// スキップ判定・キャッシュ・警告集約)だけを見る
const runWalkForwardForStrategy = vi.fn();
const maxWindowsForBatch = vi.fn().mockReturnValue(3);
vi.mock("./walkForwardEngine", () => ({
  runWalkForwardForStrategy: (...args: unknown[]) => runWalkForwardForStrategy(...args),
  maxWindowsForBatch: (...args: unknown[]) => maxWindowsForBatch(...args),
}));

const { validateRiskSettings, strategyRoutes } = await import("./routes");
const { THREE_MONTH_BACKTEST_MAX_CANDLES } = await import("./backtestEngine");

function candle(time: number): CandleBucket {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

function candles(count: number): CandleBucket[] {
  return Array.from({ length: count }, (_, i) => candle(i * 60));
}

function basicGraph() {
  return {
    nodes: [{ id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
}

const sufficientSummary: WalkForwardSummary = {
  warnings: [],
  windowCount: 1,
  windows: [],
  aggregate: {
    outOfSampleRealizedPnl: 1000,
    outOfSampleWinRate: 1,
    outOfSampleProfitFactor: null,
    outOfSampleMaxDrawdown: 0,
    outOfSampleTrades: 1,
    consistencyRatio: 1,
  },
  recommendedParams: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: null },
};

const insufficientSummary: WalkForwardSummary = {
  warnings: ["dummy"],
  windowCount: 0,
  windows: [],
  aggregate: {
    outOfSampleRealizedPnl: 0,
    outOfSampleWinRate: null,
    outOfSampleProfitFactor: null,
    outOfSampleMaxDrawdown: 0,
    outOfSampleTrades: 0,
    consistencyRatio: null,
  },
  recommendedParams: null,
};

async function buildApp() {
  const app = Fastify();
  await app.register(strategyRoutes);
  await app.ready();
  return app;
}

function strategyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "Strategy",
    pair: "btc_jpy",
    timeframe: "1min",
    graph: JSON.stringify({ nodes: [], edges: [] }),
    positionSizeJpy: null,
    maxOpenPositions: null,
    stopLossPct: null,
    takeProfitPct: null,
    trailingStopPct: null,
    ...overrides,
  };
}

describe("validateRiskSettings / positionSizeJpy cap", () => {
  it("accepts a positionSizeJpy at or below the AI_MAX_POSITION_JPY cap", () => {
    expect(validateRiskSettings({ positionSizeJpy: config.risk.maxPositionJpy })).toBeNull();
    expect(validateRiskSettings({ positionSizeJpy: 1 })).toBeNull();
  });

  it("rejects a positionSizeJpy above the AI_MAX_POSITION_JPY cap", () => {
    const error = validateRiskSettings({ positionSizeJpy: config.risk.maxPositionJpy + 1 });
    expect(error).not.toBeNull();
    expect(error).toContain("positionSizeJpy");
  });

  it("does not enforce the cap when positionSizeJpy is unset (falls back to global default)", () => {
    expect(validateRiskSettings({})).toBeNull();
    expect(validateRiskSettings({ positionSizeJpy: null })).toBeNull();
  });

  it("still rejects a non-positive positionSizeJpy regardless of the cap", () => {
    expect(validateRiskSettings({ positionSizeJpy: 0 })).not.toBeNull();
    expect(validateRiskSettings({ positionSizeJpy: -100 })).not.toBeNull();
  });
});

describe("validateRiskSettings / takeProfitPct round-trip cost floor", () => {
  it("accepts a takeProfitPct at or above the round-trip cost", () => {
    expect(validateRiskSettings({ takeProfitPct: config.fees.roundTripCostPct })).toBeNull();
    expect(validateRiskSettings({ takeProfitPct: config.fees.roundTripCostPct + 1 })).toBeNull();
  });

  it("rejects a takeProfitPct below the round-trip cost", () => {
    const error = validateRiskSettings({ takeProfitPct: config.fees.roundTripCostPct / 2 });
    expect(error).not.toBeNull();
    expect(error).toContain("利確%");
  });

  it("does not enforce the floor when takeProfitPct is unset (falls back to global default)", () => {
    expect(validateRiskSettings({ takeProfitPct: null })).toBeNull();
  });

  it("accepts 0 as an explicit 'no take profit' setting, but still rejects negatives", () => {
    expect(validateRiskSettings({ takeProfitPct: 0 })).toBeNull();
    expect(validateRiskSettings({ takeProfitPct: -1 })).not.toBeNull();
  });
});

describe("validateRiskSettings / stop-loss:take-profit ratio (issue #1b)", () => {
  it("rejects when both fields are present and takeProfitPct is below stopLossPct", () => {
    const error = validateRiskSettings({ stopLossPct: 5, takeProfitPct: 2 });
    expect(error).not.toBeNull();
    expect(error).toContain("利確%");
  });

  it("accepts when both fields are present and takeProfitPct is at or above stopLossPct", () => {
    expect(validateRiskSettings({ stopLossPct: 2, takeProfitPct: 2 })).toBeNull();
    expect(validateRiskSettings({ stopLossPct: 2, takeProfitPct: 5 })).toBeNull();
  });

  it("accepts takeProfitPct: 0 (explicit 'no take profit') alongside stopLossPct without triggering the ratio check", () => {
    expect(validateRiskSettings({ stopLossPct: 5, takeProfitPct: 0 })).toBeNull();
  });

  it("does not enforce the ratio when only one of the two fields is present (partial update)", () => {
    // stopLossPct(5)より低いtakeProfitPctでも、リクエストにtakeProfitPctが含まれていなければ
    // このチェックは発動しない(既存値との比較は対象外 — 意図的にスコープ外)
    expect(validateRiskSettings({ stopLossPct: 5 })).toBeNull();
    expect(validateRiskSettings({ takeProfitPct: 2 })).toBeNull();
  });

  it("skips the ratio check entirely when enforceRatio: false is passed (walk-forward apply path)", () => {
    // ウォークフォワードのグリッドサーチはリスクリワード比の制約なしに最良のPnLを選ぶため、
    // stopLossPct: 3 / takeProfitPct: 2 のような組み合わせが正当な推奨結果になり得る
    expect(
      validateRiskSettings({ stopLossPct: 3, takeProfitPct: 2 }, { enforceRatio: false })
    ).toBeNull();
  });

  it("still enforces the ratio by default (enforceRatio omitted) for manual create/update requests", () => {
    const error = validateRiskSettings({ stopLossPct: 3, takeProfitPct: 2 });
    expect(error).not.toBeNull();
    expect(error).toContain("利確%");
  });
});

describe("validateRiskSettings / other fields unaffected", () => {
  it("still validates maxOpenPositions independently of the positionSizeJpy cap", () => {
    expect(validateRiskSettings({ maxOpenPositions: 0 })).not.toBeNull();
    expect(validateRiskSettings({ maxOpenPositions: 1.5 })).not.toBeNull();
    expect(validateRiskSettings({ maxOpenPositions: 3 })).toBeNull();
  });
});

describe("POST /api/strategies/backtest (period: three_months) / candle count guard", () => {
  beforeEach(() => {
    aggregateCandles.mockClear();
    reloadActiveStrategies.mockReset();
    getHistoricalCandles.mockReset();
    runBacktest.mockReset();
    getHistoricalCandles.mockResolvedValue([]);
  });

  it("rejects with 400 and never calls runBacktest when the aggregated candle count exceeds the threshold (e.g. 1min)", async () => {
    aggregateCandles.mockReturnValue(candles(THREE_MONTH_BACKTEST_MAX_CANDLES + 1));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/backtest",
        payload: { graph: basicGraph(), pair: config.targetPair, timeframe: "1min", period: "three_months" },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("時間足");
      expect(runBacktest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("runs the backtest and returns 200 when the aggregated candle count is at or below the threshold (e.g. 5min)", async () => {
    aggregateCandles.mockReturnValue(candles(100));
    runBacktest.mockReturnValue({
      candleCount: 100,
      warnings: [],
      realizedPnl: 0,
      winCount: 0,
      lossCount: 0,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      profitFactor: null,
      maxDrawdown: 0,
      totalFeesJpy: 0,
      grossPnlJpy: 0,
      feeLossCount: 0,
      equityCurve: [],
      trades: [],
      period: "three_months",
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/backtest",
        payload: { graph: basicGraph(), pair: config.targetPair, timeframe: "5min", period: "three_months" },
      });

      expect(res.statusCode).toBe(200);
      expect(runBacktest).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns 503 (snapshot not ready) when there are fewer than 2 aggregated candles, without calling runBacktest", async () => {
    aggregateCandles.mockReturnValue(candles(1));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/backtest",
        payload: { graph: basicGraph(), pair: config.targetPair, timeframe: "5min", period: "three_months" },
      });

      expect(res.statusCode).toBe(503);
      expect(runBacktest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/strategies/walk-forward", () => {
  beforeEach(() => {
    strategyFindMany.mockReset();
    getHistoricalCandles.mockReset();
    // The three_months backtest tests above override aggregateCandles with a fixed
    // mockReturnValue(); mockClear() alone doesn't undo that, so restore the real
    // slicing implementation here to avoid leaking state across describe blocks.
    aggregateCandles.mockReset().mockImplementation((raw: CandleBucket[], minutes: number) =>
      raw.slice(0, Math.floor(raw.length / minutes))
    );
    reloadActiveStrategies.mockReset();
    runWalkForwardForStrategy.mockReset();
    maxWindowsForBatch.mockReset().mockReturnValue(3);
  });

  it("returns 200 with an empty result and a warning when there are no active strategies (not an error state)", async () => {
    strategyFindMany.mockResolvedValue([]);
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/strategies/walk-forward" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.activeStrategyCount).toBe(0);
      expect(body.results).toEqual([]);
      expect(body.warnings.some((w: string) => w.includes("アクティブな戦略がありません"))).toBe(true);
      expect(getHistoricalCandles).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("skips a strategy with an unparseable graph and one with an unsupported pair, but still evaluates the rest", async () => {
    strategyFindMany.mockResolvedValue([
      strategyRow({ id: "s1", name: "Broken Graph", graph: "{not valid json" }),
      strategyRow({ id: "s2", name: "Unsupported Pair", pair: "eth_jpy" }),
      strategyRow({ id: "s3", name: "OK" }),
    ]);
    getHistoricalCandles.mockResolvedValue(candles(300));
    runWalkForwardForStrategy.mockReturnValue(sufficientSummary);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/strategies/walk-forward" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.activeStrategyCount).toBe(3);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].strategyId).toBe("s3");
      expect(body.warnings.some((w: string) => w.includes("パースできない"))).toBe(true);
      expect(body.warnings.some((w: string) => w.includes("対象外"))).toBe(true);
      // eth_jpy is rejected before any candle fetch is attempted for it
      expect(getHistoricalCandles).toHaveBeenCalledTimes(1);
      expect(getHistoricalCandles).toHaveBeenCalledWith("btc_jpy");
    } finally {
      await app.close();
    }
  });

  it("excludes a strategy whose snapshot has too few candles for a single window, while others still succeed", async () => {
    strategyFindMany.mockResolvedValue([
      strategyRow({ id: "s1", name: "Sparse", timeframe: "5min" }),
      strategyRow({ id: "s2", name: "Dense", timeframe: "1min" }),
    ]);
    getHistoricalCandles.mockResolvedValue(candles(300));
    runWalkForwardForStrategy.mockImplementation((..._args: unknown[]) => {
      const usedCandles = _args[5] as CandleBucket[];
      return usedCandles.length >= 100 ? sufficientSummary : insufficientSummary;
    });

    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/strategies/walk-forward" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].strategyId).toBe("s2");
      expect(body.warnings.some((w: string) => w.includes("スナップショットが不足"))).toBe(true);
      // same pair (btc_jpy) shared by both strategies -> the raw snapshot is fetched only once
      expect(getHistoricalCandles).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("passes maxWindowsForBatch(activeStrategyCount) through to each strategy's window cap", async () => {
    strategyFindMany.mockResolvedValue([
      strategyRow({ id: "s1", positionSizeJpy: 5000, maxOpenPositions: 2, stopLossPct: 3, takeProfitPct: 5 }),
    ]);
    getHistoricalCandles.mockResolvedValue(candles(300));
    maxWindowsForBatch.mockReturnValue(6);
    runWalkForwardForStrategy.mockReturnValue(sufficientSummary);

    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/strategies/walk-forward" });
      expect(maxWindowsForBatch).toHaveBeenCalledWith(1);
      expect(runWalkForwardForStrategy).toHaveBeenCalledWith(
        { nodes: [], edges: [] },
        "btc_jpy",
        "1min",
        5000,
        2,
        expect.any(Array),
        6
      );
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/strategies/:id/apply-walk-forward-params", () => {
  beforeEach(() => {
    strategyFindUnique.mockReset();
    strategyUpdate.mockReset();
    reloadActiveStrategies.mockReset();
    broadcast.mockReset();
  });

  const validBody = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: null };

  it("re-validates with validateRiskSettings, updates the strategy, reloads active strategies, and broadcasts", async () => {
    strategyFindUnique.mockResolvedValue(
      strategyRow({ id: "s1", createdAt: new Date(), updatedAt: new Date() })
    );
    strategyUpdate.mockResolvedValue(
      strategyRow({
        id: "s1",
        stopLossPct: 2,
        takeProfitPct: 4,
        trailingStopPct: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/s1/apply-walk-forward-params",
        payload: validBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stopLossPct).toBe(2);
      expect(body.takeProfitPct).toBe(4);
      expect(body.trailingStopPct).toBeNull();
      expect(strategyUpdate).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: null },
      });
      expect(reloadActiveStrategies).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith({
        type: "strategy_update",
        payload: expect.objectContaining({ id: "s1" }),
      });
    } finally {
      await app.close();
    }
  });

  it("returns 404 and never updates when the strategy does not exist", async () => {
    strategyFindUnique.mockResolvedValue(null);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/missing/apply-walk-forward-params",
        payload: validBody,
      });

      expect(res.statusCode).toBe(404);
      expect(strategyUpdate).not.toHaveBeenCalled();
      expect(reloadActiveStrategies).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 400 via validateRiskSettings for an invalid stopLossPct, without touching the DB", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/s1/apply-walk-forward-params",
        payload: { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: null },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("stopLossPct");
      expect(strategyFindUnique).not.toHaveBeenCalled();
      expect(strategyUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("succeeds even when takeProfitPct < stopLossPct (walk-forward recommendedParams bypass the ratio guard)", async () => {
    // Regression test: validateRiskSettings's stop-loss:take-profit ratio guard must not apply
    // here, since walkForwardEngine's DEFAULT_GRID search can legitimately recommend a wide
    // stop + modest target combo (e.g. stopLossPct: 3, takeProfitPct: 2) based on backtested PnL.
    strategyFindUnique.mockResolvedValue(
      strategyRow({ id: "s1", createdAt: new Date(), updatedAt: new Date() })
    );
    strategyUpdate.mockResolvedValue(
      strategyRow({
        id: "s1",
        stopLossPct: 3,
        takeProfitPct: 2,
        trailingStopPct: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/s1/apply-walk-forward-params",
        payload: { stopLossPct: 3, takeProfitPct: 2, trailingStopPct: null },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stopLossPct).toBe(3);
      expect(body.takeProfitPct).toBe(2);
      expect(strategyUpdate).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { stopLossPct: 3, takeProfitPct: 2, trailingStopPct: null },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 400 when a required field is missing or the wrong type", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategies/s1/apply-walk-forward-params",
        payload: { stopLossPct: 2, takeProfitPct: 4 },
      });

      expect(res.statusCode).toBe(400);
      expect(strategyUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
