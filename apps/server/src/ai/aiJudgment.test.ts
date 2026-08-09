import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rsi, sma, stddev } from "@noctas/shared";
import type { MarketSnapshot } from "./claudeService";

// This is a regression test for a real bug: refreshPair used to hardcode
// vol24h: 0 in the MarketSnapshot handed to Claude, regardless of the
// actual ticker volume tracked via recordPrice(). getAiDecision is mocked
// purely to capture the snapshot it's called with - no real API call.
const getAiDecision = vi.fn();
vi.mock("./claudeService", () => ({
  getAiDecision: (...args: [MarketSnapshot]) => getAiDecision(...args),
}));

const positionFindMany = vi.fn();
const aiDecisionLogCreate = vi.fn();
vi.mock("../db/prisma", () => ({
  prisma: {
    aiDecisionLog: {
      create: (...args: unknown[]) => aiDecisionLogCreate(...args),
      aggregate: vi.fn().mockResolvedValue({ _sum: { inputTokens: 0, outputTokens: 0 }, _count: { id: 0 } }),
    },
    position: {
      findMany: (...args: unknown[]) => positionFindMany(...args),
    },
  },
}));

vi.mock("../ws/relay", () => ({ broadcast: vi.fn() }));

// aiJudgment.ts imports getCandleHistory from ../strategy/botEngine (which itself imports
// getJudgment/setWatchedPairs from aiJudgment.ts - a deliberate circular import, see the
// comment above that import in aiJudgment.ts). Mock the whole module so this test doesn't
// need botEngine's candle-seeding/prisma dependencies.
const getCandleHistory = vi.fn();
vi.mock("../strategy/botEngine", () => ({
  getCandleHistory: (...args: [string]) => getCandleHistory(...args),
}));

const isBuyHalted = vi.fn();
const getCircuitBreakerStatus = vi.fn();
vi.mock("../trading/circuitBreaker", () => ({
  isBuyHalted: (...args: unknown[]) => isBuyHalted(...args),
  getCircuitBreakerStatus: (...args: unknown[]) => getCircuitBreakerStatus(...args),
}));

const { recordPrice, setWatchedPairs, startAiJudgmentLoop } = await import("./aiJudgment");
const { config } = await import("../config");

/** getCandleHistory()が返すCandleBucket[]のうち、指標計算が使うcloseだけを持つ最小限のスタブ */
function candlesFromCloses(closes: number[]): { close: number }[] {
  return closes.map((close) => ({ close }));
}

beforeEach(() => {
  getAiDecision.mockReset().mockResolvedValue({
    action: "hold",
    confidence: 0.5,
    reasoning: "test",
    usage: { inputTokens: 0, outputTokens: 0, model: config.ai.model },
  });
  positionFindMany.mockReset().mockResolvedValue([]);
  aiDecisionLogCreate.mockReset().mockResolvedValue({ createdAt: new Date() });
  getCandleHistory.mockReset().mockReturnValue([]);
  isBuyHalted.mockReset().mockReturnValue(false);
  getCircuitBreakerStatus.mockReset().mockReturnValue({ halted: false, reason: null, haltedAt: null });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// aiJudgment.ts keeps its per-pair call-cooldown (lastCallAt/lastCallPrice) in module scope,
// so it persists across tests in this file - each test uses its own pair to stay isolated
// rather than sharing state through a reset that the module doesn't expose.

describe("aiJudgment / vol24h in the Claude snapshot", () => {
  it("uses the real ticker volume recorded via recordPrice, not a hardcoded 0", async () => {
    setWatchedPairs(new Set(["btc_jpy"]));
    recordPrice("btc_jpy", 10_000_000, 12_345);

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    expect(getAiDecision).toHaveBeenCalledTimes(1);
    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.vol24h).toBe(12_345);
  });

  it("uses the most recently recorded volume, not a stale earlier one", async () => {
    setWatchedPairs(new Set(["eth_jpy"]));
    recordPrice("eth_jpy", 500_000, 100);
    recordPrice("eth_jpy", 501_000, 999);

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.vol24h).toBe(999);
  });

  it("falls back to 0 only when no volume has ever been recorded for the pair", async () => {
    setWatchedPairs(new Set(["xrp_jpy"]));
    recordPrice("xrp_jpy", 100); // no vol24h argument at all

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.vol24h).toBe(0);
  });
});

describe("aiJudgment / indicators in the Claude snapshot", () => {
  it("reports null for every indicator until there's enough candle history", async () => {
    setWatchedPairs(new Set(["ltc_jpy"]));
    recordPrice("ltc_jpy", 100);
    // Fewer than 20 candles: rsi14/smaDeviationPct/volatilityPct all need more history than this.
    getCandleHistory.mockReturnValue(candlesFromCloses([100, 101, 102]));

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.indicators).toEqual({ rsi14: null, smaDeviationPct: null, volatilityPct: null });
  });

  it("computes rsi14/smaDeviationPct/volatilityPct matching the shared indicator functions once fully warmed up", async () => {
    setWatchedPairs(new Set(["mona_jpy"]));
    recordPrice("mona_jpy", 122); // tick price only gates the cooldown check; indicators come from candles
    // 25 closes: enough for rsi14 (needs >14) and sma20/stddev20 (need >=20).
    const closes = [
      100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 110, 108, 111, 113, 112, 114, 115, 113,
      116, 118, 120, 119, 121, 123, 122,
    ];
    getCandleHistory.mockReturnValue(candlesFromCloses(closes));

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    const expectedRsi14 = rsi(closes, 14).at(-1)!;
    const expectedSma20 = sma(closes, 20).at(-1)!;
    const expectedStddev20 = stddev(closes, 20).at(-1)!;
    const expectedDeviationPct = ((closes.at(-1)! - expectedSma20) / expectedSma20) * 100;
    const expectedVolatilityPct = (expectedStddev20 / expectedSma20) * 100;

    expect(snapshot.indicators.rsi14).toBeCloseTo(expectedRsi14);
    expect(snapshot.indicators.smaDeviationPct).toBeCloseTo(expectedDeviationPct);
    expect(snapshot.indicators.volatilityPct).toBeCloseTo(expectedVolatilityPct);
  });

  it("persists the same rsi14/smaDeviationPct/volatilityPct values into AiDecisionLog.create", async () => {
    setWatchedPairs(new Set(["etc_jpy"]));
    recordPrice("etc_jpy", 122);
    const closes = [
      100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 110, 108, 111, 113, 112, 114, 115, 113,
      116, 118, 120, 119, 121, 123, 122,
    ];
    getCandleHistory.mockReturnValue(candlesFromCloses(closes));

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    expect(aiDecisionLogCreate).toHaveBeenCalledTimes(1);
    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    const createArgs = aiDecisionLogCreate.mock.calls[0][0] as {
      data: { rsi14: number | null; smaDeviationPct: number | null; volatilityPct: number | null };
    };
    expect(createArgs.data.rsi14).toBe(snapshot.indicators.rsi14);
    expect(createArgs.data.smaDeviationPct).toBe(snapshot.indicators.smaDeviationPct);
    expect(createArgs.data.volatilityPct).toBe(snapshot.indicators.volatilityPct);
  });

  it("persists null indicators into AiDecisionLog.create when there isn't enough candle history", async () => {
    setWatchedPairs(new Set(["neo_jpy"]));
    recordPrice("neo_jpy", 100);
    getCandleHistory.mockReturnValue(candlesFromCloses([100, 101, 102]));

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    expect(aiDecisionLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rsi14: null,
        smaDeviationPct: null,
        volatilityPct: null,
      }),
    });
  });
});

describe("aiJudgment / position context in the Claude snapshot", () => {
  it("reports no position when there are no open buy positions for the pair", async () => {
    setWatchedPairs(new Set(["doge_jpy"]));
    recordPrice("doge_jpy", 30);
    positionFindMany.mockResolvedValue([]);

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.position).toEqual({
      hasOpenPosition: false,
      openCount: 0,
      unrealizedPnlJpy: null,
      unrealizedPnlPct: null,
    });
  });

  it("computes unrealized pnl (weighted by cost) from open positions using the current tick price", async () => {
    setWatchedPairs(new Set(["sol_jpy"]));
    recordPrice("sol_jpy", 500_000);
    positionFindMany.mockResolvedValue([
      { entryPrice: 480_000, amount: 0.1 },
      { entryPrice: 490_000, amount: 0.2 },
    ]);

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.position.hasOpenPosition).toBe(true);
    expect(snapshot.position.openCount).toBe(2);
    // (500000-480000)*0.1 + (500000-490000)*0.2 = 2000 + 2000 = 4000
    expect(snapshot.position.unrealizedPnlJpy).toBeCloseTo(4000);
    // cost-weighted: (480000*0.1 + 490000*0.2) = 146000; pct = 4000 / 146000 * 100
    expect(snapshot.position.unrealizedPnlPct).toBeCloseTo((4000 / 146_000) * 100);
  });

  it("queries prisma.position.findMany with the same {pair, side: buy, closedAt: null} shape as pnl/summary.ts", async () => {
    setWatchedPairs(new Set(["bch_jpy"]));
    recordPrice("bch_jpy", 100);

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    expect(positionFindMany).toHaveBeenCalledWith({
      where: { pair: "bch_jpy", side: "buy", closedAt: null },
    });
  });
});

describe("aiJudgment / circuit breaker context in the Claude snapshot", () => {
  it("reflects an active halt", async () => {
    setWatchedPairs(new Set(["ada_jpy"]));
    recordPrice("ada_jpy", 100);
    isBuyHalted.mockReturnValue(true);
    getCircuitBreakerStatus.mockReturnValue({
      halted: true,
      reason: "本日の実現損失が上限に達しました",
      haltedAt: Date.now(),
    });

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.circuitBreaker).toEqual({
      buyHalted: true,
      reason: "本日の実現損失が上限に達しました",
    });
  });

  it("reflects a normal (not halted) state", async () => {
    setWatchedPairs(new Set(["trx_jpy"]));
    recordPrice("trx_jpy", 20);
    isBuyHalted.mockReturnValue(false);
    getCircuitBreakerStatus.mockReturnValue({ halted: false, reason: null, haltedAt: null });

    const stop = startAiJudgmentLoop();
    await vi.advanceTimersByTimeAsync(config.ai.pollIntervalMs);
    stop();

    const snapshot = getAiDecision.mock.calls[0][0] as MarketSnapshot;
    expect(snapshot.circuitBreaker).toEqual({ buyHalted: false, reason: null });
  });
});
