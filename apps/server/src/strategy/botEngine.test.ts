import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StrategyGraph } from "@noctas/shared";

// botEngine.ts reaches several live-service modules at import time (db/prisma, ws/relay,
// trading/paperTradingEngine, trading/circuitBreaker, ai/aiJudgment). Mock them the same way
// circuitBreaker.test.ts / routes.test.ts do, so onTick()/reloadActiveStrategies() can be driven
// purely in-memory without touching a real DB or Claude.
const strategyFindMany = vi.fn();
const botSignalLogFindFirst = vi.fn();
const botSignalLogCreate = vi.fn();
const positionGroupBy = vi.fn();
vi.mock("../db/prisma", () => ({
  prisma: {
    strategy: { findMany: (...args: unknown[]) => strategyFindMany(...args) },
    botSignalLog: {
      findFirst: (...args: unknown[]) => botSignalLogFindFirst(...args),
      create: (...args: unknown[]) => botSignalLogCreate(...args),
    },
    position: { groupBy: (...args: unknown[]) => positionGroupBy(...args) },
  },
}));

const broadcast = vi.fn();
vi.mock("../ws/relay", () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));

const openBuyPosition = vi.fn();
const closeOldestPosition = vi.fn();
vi.mock("../trading/paperTradingEngine", () => ({
  openBuyPosition: (...args: unknown[]) => openBuyPosition(...args),
  closeOldestPosition: (...args: unknown[]) => closeOldestPosition(...args),
}));

vi.mock("../trading/circuitBreaker", () => ({ isBuyHalted: () => false }));
vi.mock("../ai/aiJudgment", () => ({
  getJudgment: () => null,
  setWatchedPairs: () => {},
}));

const { onTick, reloadActiveStrategies, tickVolumeDelta } = await import("./botEngine");

// tickVolumeDelta keeps its "last seen vol24h per pair" baseline in module scope, so each test
// here uses its own pair key to stay isolated from the others (matches the pattern used for
// riskManager.ts's module-scoped closingInFlight guard tests).

describe("tickVolumeDelta", () => {
  it("returns 0 for the very first tick observed for a pair (no baseline yet)", () => {
    expect(tickVolumeDelta("delta-test-first-tick", 12_345)).toBe(0);
  });

  it("returns the positive difference between consecutive ticks", () => {
    const pair = "delta-test-increasing";
    tickVolumeDelta(pair, 100);
    expect(tickVolumeDelta(pair, 130)).toBe(30);
    expect(tickVolumeDelta(pair, 130.5)).toBeCloseTo(0.5);
  });

  it("clamps a decreasing vol24h (24h rolling-window boundary) to 0 instead of going negative", () => {
    const pair = "delta-test-rollover";
    tickVolumeDelta(pair, 500);
    // the 24h cumulative counter can drop when old volume rolls out of the window;
    // that must never be reported as negative volume for the candle
    expect(tickVolumeDelta(pair, 10)).toBe(0);
  });

  it("tracks each pair's baseline independently", () => {
    tickVolumeDelta("delta-test-pair-a", 1000);
    tickVolumeDelta("delta-test-pair-b", 5000);
    expect(tickVolumeDelta("delta-test-pair-a", 1010)).toBe(10);
    expect(tickVolumeDelta("delta-test-pair-b", 5100)).toBe(100);
  });
});

// 「price > 100」という単純な買い条件のグラフ。closesの末尾2要素が
// [閾値以下, 閾値超]になるよう仕込むと、立ち上がりエッジ(false→true)で確実にBUYが発火する
function buyOnPriceAboveGraph(threshold: number): StrategyGraph {
  return {
    nodes: [
      { id: "price1", type: "price", params: {}, position: { x: 0, y: 0 } },
      { id: "thresh1", type: "constant", params: { value: threshold }, position: { x: 0, y: 0 } },
      { id: "cmp1", type: "compare", params: { op: "gt" }, position: { x: 0, y: 0 } },
      { id: "buy1", type: "buy", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "price1", target: "cmp1", targetHandle: "a" },
      { id: "e2", source: "thresh1", target: "cmp1", targetHandle: "b" },
      { id: "e3", source: "cmp1", target: "buy1", targetHandle: "condition" },
    ],
  };
}

function strategyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "strategy-cooldown-test",
    name: "Cooldown Test Strategy",
    pair: "btc_jpy",
    timeframe: "1min",
    graph: JSON.stringify(buyOnPriceAboveGraph(100)),
    positionSizeJpy: null,
    maxOpenPositions: null,
    stopLossPct: null,
    takeProfitPct: null,
    trailingStopPct: null,
    ...overrides,
  };
}

// candleStore(botEngine.tsのモジュールスコープ状態)はペア単位で永続するため、テスト間で
// タイムスタンプが逆行しないよう単調増加のクロックを共有する(唯一の対象ペアはbtc_jpyのみ)
let clock = Date.parse("2026-01-01T00:00:00Z");
function nextClockBase(): number {
  const base = clock;
  clock += 10 * 60_000; // 次のテストの2tickと重ならないよう十分離す
  return base;
}

describe("onTick / durable cooldown (DB-backed final guard, issue #2)", () => {
  const pair = "btc_jpy";

  beforeEach(() => {
    strategyFindMany.mockReset();
    botSignalLogFindFirst.mockReset().mockResolvedValue(null);
    botSignalLogCreate.mockReset().mockResolvedValue(undefined);
    positionGroupBy.mockReset().mockResolvedValue([]);
    broadcast.mockReset();
    openBuyPosition.mockReset().mockResolvedValue({ trade: null, position: null });
    closeOldestPosition.mockReset().mockResolvedValue({ trade: null, position: null });
  });

  // 戦略を読み込んだ上で、BUY条件が立ち上がりエッジになる2tickを送る
  // (lastFiredAtは空のまま=プロセス再起動直後を模している)
  async function primeRisingEdge(strategyId: string) {
    strategyFindMany.mockResolvedValue([strategyRow({ id: strategyId, pair })]);
    await reloadActiveStrategies();
    const t0 = nextClockBase();
    await onTick(pair, 50, t0, 0); // 閾値以下の価格でforming candleを作るだけ(closes長1で評価はスキップ)
    await onTick(pair, 200, t0 + 60_000, 0); // 前の足(50)を確定し、閾値超の新しいforming candle(200)を作る
  }

  it("suppresses the signal when in-memory lastFiredAt is empty but a recent BotSignalLog row exists within cooldown", async () => {
    const strategyId = "cooldown-suppress";
    botSignalLogFindFirst.mockResolvedValue({ triggeredAt: new Date(Date.now() - 1_000) });

    await primeRisingEdge(strategyId);

    expect(botSignalLogFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { strategyId } })
    );
    expect(openBuyPosition).not.toHaveBeenCalled();
    expect(botSignalLogCreate).not.toHaveBeenCalled();
  });

  it("fires normally when there is no recent BotSignalLog row for the strategy", async () => {
    const strategyId = "cooldown-fire";
    botSignalLogFindFirst.mockResolvedValue(null);

    await primeRisingEdge(strategyId);

    expect(openBuyPosition).toHaveBeenCalledTimes(1);
    expect(botSignalLogCreate).toHaveBeenCalledTimes(1);
  });
});
