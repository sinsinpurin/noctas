import { describe, expect, it } from "vitest";
import { evaluateGraph, parseGraph } from "./evaluator";
import type { StrategyEdge, StrategyGraph, StrategyNode } from "./index";

const pos = { x: 0, y: 0 };

function node(id: string, type: StrategyNode["type"], params: StrategyNode["params"] = {}): StrategyNode {
  return { id, type, params, position: pos };
}

function edge(
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle = "out"
): StrategyEdge {
  return { id: `${source}->${target}:${targetHandle}`, source, sourceHandle, target, targetHandle };
}

describe("evaluateGraph / price node", () => {
  it("passes the close series through unchanged", () => {
    const graph: StrategyGraph = { nodes: [node("p", "price")], edges: [] };
    const result = evaluateGraph(graph, [1, 2, 3], { collectValues: true });
    expect(result.nodeValues.p).toBe(3);
    expect(result.errors).toEqual([]);
  });
});

describe("evaluateGraph / volume node", () => {
  it("passes options.volumes through unchanged when its length matches closes", () => {
    const graph: StrategyGraph = { nodes: [node("v", "volume")], edges: [] };
    const result = evaluateGraph(graph, [1, 2, 3], { collectValues: true, volumes: [10, 20, 30] });
    expect(result.nodeValues.v).toBe(30);
    expect(result.errors).toEqual([]);
  });

  it("falls back to NaN (unset) when volumes is not supplied", () => {
    const graph: StrategyGraph = { nodes: [node("v", "volume")], edges: [] };
    const result = evaluateGraph(graph, [1, 2, 3], { collectValues: true });
    expect(result.nodeValues.v).toBeNull();
  });

  it("falls back to NaN (unset) when volumes length does not match closes", () => {
    const graph: StrategyGraph = { nodes: [node("v", "volume")], edges: [] };
    const result = evaluateGraph(graph, [1, 2, 3], { collectValues: true, volumes: [10, 20] });
    expect(result.nodeValues.v).toBeNull();
  });

  it("integration: buys only at the exact tick volume spikes above its own moving average", () => {
    // volume stays flat around 100, then spikes to 500 on the last tick
    const closes = [10, 10, 10, 10, 10, 10];
    const volumes = [100, 100, 100, 100, 100, 500];
    const graph: StrategyGraph = {
      nodes: [
        node("vol", "volume"),
        node("volSma", "sma", { period: 3 }),
        node("volSpike", "cross", { op: "cross_above" }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("vol", "volSpike", "a"),
        edge("vol", "volSma", "in"),
        edge("volSma", "volSpike", "b"),
        edge("volSpike", "buy1", "condition"),
      ],
    };

    // no spike yet -> never crosses above its own SMA
    const flatResult = evaluateGraph(graph, closes.slice(0, 5), { volumes: volumes.slice(0, 5) });
    expect(flatResult.buy.current).toBe(false);

    // spike tick -> volume crosses above its trailing SMA exactly now
    const spikeResult = evaluateGraph(graph, closes, { volumes });
    expect(spikeResult.buy).toEqual({ current: true, previous: false });
  });
});

describe("evaluateGraph / time_filter node", () => {
  function buildGraph(excludeStartHour: number, excludeEndHour: number): StrategyGraph {
    return {
      nodes: [
        node("tf", "time_filter", { excludeStartHour, excludeEndHour }),
        node("buy1", "buy"),
      ],
      edges: [edge("tf", "buy1", "condition")],
    };
  }

  // JST hour H corresponds to UTC epoch seconds (H - 9) * 3600, mod 86400 (using day 1 to stay positive)
  function tsForJstHour(hour: number): number {
    return 86400 + ((hour - 9 + 24) % 24) * 3600;
  }

  it("falls back to true (permissive) when timestamps is not supplied", () => {
    const result = evaluateGraph(buildGraph(2, 6), [1, 2], { collectValues: true });
    expect(result.nodeValues.tf).toBe(true);
  });

  it("falls back to true (permissive) when timestamps length does not match closes", () => {
    const result = evaluateGraph(buildGraph(2, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(3)],
    });
    expect(result.nodeValues.tf).toBe(true);
  });

  it("plain (non-wrapping) window: excludes hours in [start, end) and allows the rest", () => {
    const inside = evaluateGraph(buildGraph(2, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(3)],
    });
    expect(inside.nodeValues.tf).toBe(false);

    const outside = evaluateGraph(buildGraph(2, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(10)],
    });
    expect(outside.nodeValues.tf).toBe(true);
  });

  it("wraparound window (start > end): excludes hours >= start OR < end", () => {
    const insideLate = evaluateGraph(buildGraph(22, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(23)],
    });
    expect(insideLate.nodeValues.tf).toBe(false);

    const insideEarly = evaluateGraph(buildGraph(22, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(2)],
    });
    expect(insideEarly.nodeValues.tf).toBe(false);

    const outside = evaluateGraph(buildGraph(22, 6), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(12)],
    });
    expect(outside.nodeValues.tf).toBe(true);
  });

  it("start === end: empty window, never excludes", () => {
    const result = evaluateGraph(buildGraph(5, 5), [1, 2], {
      collectValues: true,
      timestamps: [tsForJstHour(1), tsForJstHour(5)],
    });
    expect(result.nodeValues.tf).toBe(true);
  });

  it("integration: buy only fires outside the excluded hours when AND'ed with a price condition", () => {
    const graph: StrategyGraph = {
      nodes: [
        node("price1", "price"),
        node("c", "constant", { value: 3 }),
        node("cmp", "compare", { op: "gt" }),
        node("tf", "time_filter", { excludeStartHour: 2, excludeEndHour: 6 }),
        node("logic1", "logic", { op: "and" }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("price1", "cmp", "a"),
        edge("c", "cmp", "b"),
        edge("cmp", "logic1", "a"),
        edge("tf", "logic1", "b"),
        edge("logic1", "buy1", "condition"),
      ],
    };

    // price rises above the threshold only on the last tick, but that tick falls inside the
    // excluded hour range (03:00 JST) -> buy must not fire
    const blocked = evaluateGraph(graph, [1, 1, 5], {
      timestamps: [tsForJstHour(1), tsForJstHour(1), tsForJstHour(3)],
    });
    expect(blocked.buy.current).toBe(false);

    // same price pattern, but the rising-edge tick falls outside the excluded hours -> buy fires
    const allowed = evaluateGraph(graph, [1, 1, 5], {
      timestamps: [tsForJstHour(1), tsForJstHour(1), tsForJstHour(10)],
    });
    expect(allowed.buy).toEqual({ current: true, previous: false });
  });
});

describe("evaluateGraph / compare node", () => {
  function buildGraph(op: "gt" | "lt" | "gte" | "lte", value: number): StrategyGraph {
    return {
      nodes: [
        node("price1", "price"),
        node("c", "constant", { value }),
        node("cmp", "compare", { op }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("price1", "cmp", "a"),
        edge("c", "cmp", "b"),
        edge("cmp", "buy1", "condition"),
      ],
    };
  }

  it("gt: fires only while price is above the threshold, and only on the rising edge", () => {
    // closes rises above 3 only at the last tick -> current=true, previous=false
    const result = evaluateGraph(buildGraph("gt", 3), [1, 5, 5]);
    // last two closes are both 5 (already > 3), so the condition was already true one tick ago
    expect(result.buy).toEqual({ current: true, previous: true });
  });

  it("gt: reports a genuine rising edge when the previous tick was false", () => {
    const result = evaluateGraph(buildGraph("gt", 3), [1, 1, 5]);
    expect(result.buy).toEqual({ current: true, previous: false });
  });

  it("lt: is the mirror of gt", () => {
    const result = evaluateGraph(buildGraph("lt", 3), [5, 5, 1]);
    expect(result.buy.current).toBe(true);
  });
});

describe("evaluateGraph / cross node", () => {
  function buildGraph(op: "cross_above" | "cross_below", threshold: number): StrategyGraph {
    return {
      nodes: [
        node("price1", "price"),
        node("c", "constant", { value: threshold }),
        node("cross1", "cross", { op }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("price1", "cross1", "a"),
        edge("c", "cross1", "b"),
        edge("cross1", "buy1", "condition"),
      ],
    };
  }

  it("cross_above fires only at the exact tick price crosses the threshold", () => {
    // price stays below 3 for a while, then jumps above it on the last tick
    const result = evaluateGraph(buildGraph("cross_above", 3), [1, 1, 1, 5]);
    expect(result.buy).toEqual({ current: true, previous: false });
  });

  it("cross_above is a one-tick pulse: it reverts to false right after crossing even while price stays above the threshold", () => {
    const result = evaluateGraph(buildGraph("cross_above", 3), [1, 1, 5, 6]);
    // crossed at index 2 (previous tick); by index 3 both price and the prior price
    // are already above the threshold, so it's no longer "crossing" - just sustained
    expect(result.buy).toEqual({ current: false, previous: true });
  });

  it("cross_below fires when price drops through the threshold", () => {
    const result = evaluateGraph(buildGraph("cross_below", 3), [5, 5, 5, 1]);
    expect(result.buy).toEqual({ current: true, previous: false });
  });

  it("never fires on the very first tick (no prior value to compare against)", () => {
    const result = evaluateGraph(buildGraph("cross_above", 3), [5]);
    expect(result.buy).toEqual({ current: false, previous: false });
  });
});

describe("evaluateGraph / logic node", () => {
  // Each boolean input is produced by comparing a constant against 0 with "gt":
  // value=1 -> true, value=-1 -> false. This avoids any indirection through price/series data.
  function boolNode(id: string, value: boolean): StrategyNode[] {
    return [node(`${id}Const`, "constant", { value: value ? 1 : -1 }), node(`${id}Zero`, "constant", { value: 0 })];
  }

  function buildGraph(op: "and" | "or" | "not", a: boolean, b?: boolean): StrategyGraph {
    const nodes: StrategyNode[] = [
      ...boolNode("a", a),
      node("aCmp", "compare", { op: "gt" }),
      node("logic1", "logic", { op }),
      node("buy1", "buy"),
    ];
    const edges: StrategyEdge[] = [
      edge("aConst", "aCmp", "a"),
      edge("aZero", "aCmp", "b"),
      edge("aCmp", "logic1", op === "not" ? "in" : "a"),
      edge("logic1", "buy1", "condition"),
    ];
    if (op !== "not") {
      nodes.push(...boolNode("b", b ?? false), node("bCmp", "compare", { op: "gt" }));
      edges.push(edge("bConst", "bCmp", "a"), edge("bZero", "bCmp", "b"), edge("bCmp", "logic1", "b"));
    }
    return { nodes, edges };
  }

  function evalLogic(op: "and" | "or" | "not", a: boolean, b?: boolean) {
    return evaluateGraph(buildGraph(op, a, b), [0, 0]).buy.current;
  }

  it("and: true only when both inputs are true", () => {
    expect(evalLogic("and", true, true)).toBe(true);
    expect(evalLogic("and", true, false)).toBe(false);
    expect(evalLogic("and", false, false)).toBe(false);
  });

  it("or: true when at least one input is true", () => {
    expect(evalLogic("or", true, false)).toBe(true);
    expect(evalLogic("or", false, false)).toBe(false);
  });

  it("not: negates the single input", () => {
    expect(evalLogic("not", true)).toBe(false);
    expect(evalLogic("not", false)).toBe(true);
  });
});

describe("evaluateGraph / ai_judgment node", () => {
  function buildGraph(expect_: "buy" | "sell", minConfidence: number): StrategyGraph {
    return {
      nodes: [node("ai", "ai_judgment", { expect: expect_, minConfidence }), node("buy1", "buy")],
      edges: [edge("ai", "buy1", "condition")],
    };
  }

  it("fires as a rising edge when a fresh matching judgment arrives", () => {
    const result = evaluateGraph(buildGraph("buy", 0.6), [1, 2], {
      aiJudgment: { action: "buy", confidence: 0.8, isFresh: true },
    });
    expect(result.buy).toEqual({ current: true, previous: false });
  });

  it("does not re-fire on a later tick for the same (stale) judgment", () => {
    const result = evaluateGraph(buildGraph("buy", 0.6), [1, 2], {
      aiJudgment: { action: "buy", confidence: 0.8, isFresh: false },
    });
    expect(result.buy).toEqual({ current: true, previous: true });
  });

  it("does not match when confidence is below the threshold", () => {
    const result = evaluateGraph(buildGraph("buy", 0.9), [1, 2], {
      aiJudgment: { action: "buy", confidence: 0.5, isFresh: true },
    });
    expect(result.buy.current).toBe(false);
  });

  it("does not match when the action differs from expect", () => {
    const result = evaluateGraph(buildGraph("buy", 0.6), [1, 2], {
      aiJudgment: { action: "sell", confidence: 0.9, isFresh: true },
    });
    expect(result.buy.current).toBe(false);
  });

  it("is always false when no judgment is supplied", () => {
    const result = evaluateGraph(buildGraph("buy", 0), [1, 2]);
    expect(result.buy.current).toBe(false);
  });
});

describe("evaluateGraph / position node", () => {
  function buildGraph(state: "none" | "holding"): StrategyGraph {
    return {
      nodes: [node("pos", "position", { state }), node("buy1", "buy")],
      edges: [edge("pos", "buy1", "condition")],
    };
  }

  it("state=none is true while flat", () => {
    const result = evaluateGraph(buildGraph("none"), [1, 2], { hasOpenPosition: false });
    expect(result.buy).toEqual({ current: true, previous: true });
  });

  it("state=holding is true only while a position is open", () => {
    expect(evaluateGraph(buildGraph("holding"), [1, 2], { hasOpenPosition: true }).buy.current).toBe(true);
    expect(evaluateGraph(buildGraph("holding"), [1, 2], { hasOpenPosition: false }).buy.current).toBe(false);
  });

  it("defaults to flat when the option is not supplied", () => {
    expect(evaluateGraph(buildGraph("none"), [1, 2]).buy.current).toBe(true);
    expect(evaluateGraph(buildGraph("holding"), [1, 2]).buy.current).toBe(false);
  });
});

describe("evaluateGraph / integration: EMA cross gated by open position", () => {
  // sma(1) crosses above sma(2) exactly at the last tick
  const crossingCloses = [10, 10, 10, 8, 12];
  // one tick later: still above, so the cross pulse has already passed
  const afterCrossCloses = [10, 10, 10, 8, 12, 13];

  function buildGraph(): StrategyGraph {
    return {
      nodes: [
        node("price1", "price"),
        node("fast", "sma", { period: 1 }),
        node("slow", "sma", { period: 2 }),
        node("crossUp", "cross", { op: "cross_above" }),
        node("flat", "position", { state: "none" }),
        node("buyLogic", "logic", { op: "and" }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("price1", "fast", "in"),
        edge("price1", "slow", "in"),
        edge("fast", "crossUp", "a"),
        edge("slow", "crossUp", "b"),
        edge("crossUp", "buyLogic", "a"),
        edge("flat", "buyLogic", "b"),
        edge("buyLogic", "buy1", "condition"),
      ],
    };
  }

  it("buys on the cross while flat", () => {
    const result = evaluateGraph(buildGraph(), crossingCloses, { hasOpenPosition: false });
    expect(result.buy).toEqual({ current: true, previous: false });
  });

  it("does not buy on the same cross while already holding a position", () => {
    const result = evaluateGraph(buildGraph(), crossingCloses, { hasOpenPosition: true });
    expect(result.buy.current).toBe(false);
  });

  it("does not re-fire on the tick after the position was opened", () => {
    const result = evaluateGraph(buildGraph(), afterCrossCloses, { hasOpenPosition: true });
    expect(result.buy).toEqual({ current: false, previous: false });
  });
});

describe("evaluateGraph / integration: EMA cross gated by AI judgment (mirrors the deployed strategy shape)", () => {
  // sma(period 1) as "fast" and sma(period 2) as "slow" cross above exactly at the last tick
  const closes = [10, 10, 10, 8, 12];

  function buildGraph(): StrategyGraph {
    return {
      nodes: [
        node("price1", "price"),
        node("fast", "sma", { period: 1 }),
        node("slow", "sma", { period: 2 }),
        node("crossUp", "cross", { op: "cross_above" }),
        node("ai", "ai_judgment", { expect: "buy", minConfidence: 0.6 }),
        node("buyLogic", "logic", { op: "and" }),
        node("buy1", "buy"),
      ],
      edges: [
        edge("price1", "fast", "in"),
        edge("price1", "slow", "in"),
        edge("fast", "crossUp", "a"),
        edge("slow", "crossUp", "b"),
        edge("crossUp", "buyLogic", "a"),
        edge("ai", "buyLogic", "b"),
        edge("buyLogic", "buy1", "condition"),
      ],
    };
  }

  it("does not buy on the cross alone, without AI confirmation", () => {
    const result = evaluateGraph(buildGraph(), closes);
    expect(result.buy.current).toBe(false);
  });

  it("buys when the cross and a fresh matching AI judgment coincide on the same tick", () => {
    const result = evaluateGraph(buildGraph(), closes, {
      aiJudgment: { action: "buy", confidence: 0.8, isFresh: true },
    });
    expect(result.buy).toEqual({ current: true, previous: false });
  });
});

describe("evaluateGraph / integration: RSI-overbought OR cross_down (mirrors the deployed strategy's sell side)", () => {
  it("sell fires when RSI alone crosses above the overbought threshold", () => {
    // closes rise monotonically -> avgLoss stays 0 -> rsi = 100
    const graph: StrategyGraph = {
      nodes: [
        node("price1", "price"),
        node("rsi1", "rsi", { period: 2 }),
        node("rsiHigh", "constant", { value: 75 }),
        node("rsiOver", "compare", { op: "gt" }),
        node("crossDown", "cross", { op: "cross_below" }), // no data feeding it -> always false
        node("sellLogic", "logic", { op: "or" }),
        node("sell1", "sell"),
      ],
      edges: [
        edge("price1", "rsi1", "in"),
        edge("rsi1", "rsiOver", "a"),
        edge("rsiHigh", "rsiOver", "b"),
        edge("rsiOver", "sellLogic", "a"),
        edge("crossDown", "sellLogic", "b"),
        edge("sellLogic", "sell1", "condition"),
      ],
    };
    const result = evaluateGraph(graph, [10, 11, 12]);
    expect(result.sell.current).toBe(true);
  });
});

describe("evaluateGraph / error handling", () => {
  it("reports an error for an edge referencing a non-existent node", () => {
    const graph: StrategyGraph = {
      nodes: [node("buy1", "buy")],
      edges: [{ id: "e1", source: "missing", sourceHandle: "out", target: "buy1", targetHandle: "condition" }],
    };
    const result = evaluateGraph(graph, [1, 2]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("detects a circular reference instead of looping forever", () => {
    // "a" and "b" depend on each other, and "buy1" is what actually triggers evaluation
    // of "a" (an orphaned cycle nobody depends on would never be evaluated at all)
    const graph: StrategyGraph = {
      nodes: [node("a", "compare", { op: "gt" }), node("b", "compare", { op: "gt" }), node("buy1", "buy")],
      edges: [edge("a", "b", "a"), edge("b", "a", "a"), edge("a", "buy1", "condition")],
    };
    const result = evaluateGraph(graph, [1, 2]);
    expect(result.errors.some((e) => e.includes("循環参照"))).toBe(true);
  });
});

describe("parseGraph", () => {
  it("parses a valid graph JSON string", () => {
    const graph: StrategyGraph = { nodes: [node("p", "price")], edges: [] };
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("returns null for invalid JSON", () => {
    expect(parseGraph("{not valid json")).toBeNull();
  });

  it("returns null when nodes/edges are not arrays", () => {
    expect(parseGraph(JSON.stringify({ nodes: "oops", edges: [] }))).toBeNull();
  });
});
