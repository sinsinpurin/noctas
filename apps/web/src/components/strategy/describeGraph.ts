import type { StrategyGraph, StrategyNode } from "@noctas/shared";

/**
 * 戦略グラフを人間が読める日本語の説明文へ変換する。
 * エディタの「Strategy Preview」とテンプレート一覧の説明に使う。
 */

export interface GraphDescription {
  /** 買い条件の説明(Buyノードごとに1行) */
  buy: string[];
  /** 売り条件の説明(Sellノードごとに1行) */
  sell: string[];
  /** 未接続などの警告 */
  issues: string[];
}

function formatValue(value: number | string | undefined): string {
  if (typeof value === "number") return value.toLocaleString("ja-JP");
  if (value === undefined) return "0";
  return String(value);
}

export function describeGraph(graph: StrategyGraph): GraphDescription {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // target -> targetHandle -> sourceNodeId
  const sourceByTarget = new Map<string, Map<string, string>>();
  for (const edge of graph.edges) {
    if (!sourceByTarget.has(edge.target)) sourceByTarget.set(edge.target, new Map());
    sourceByTarget.get(edge.target)!.set(edge.targetHandle ?? "in", edge.source);
  }

  const issues: string[] = [];

  function sourceNode(nodeId: string, handle: string): StrategyNode | null {
    const sourceId = sourceByTarget.get(nodeId)?.get(handle);
    if (!sourceId) return null;
    return nodeById.get(sourceId) ?? null;
  }

  function describe(node: StrategyNode | null, visited: Set<string>, nested = false): string {
    if (!node) return "(未接続)";
    if (visited.has(node.id)) return "(循環参照)";
    visited.add(node.id);

    try {
      switch (node.type) {
        case "price":
          return "終値";
        case "volume":
          return "出来高";
        case "time_filter": {
          const excludeStartHour = formatValue(node.params.excludeStartHour ?? 2);
          const excludeEndHour = formatValue(node.params.excludeEndHour ?? 6);
          return `${excludeStartHour}時〜${excludeEndHour}時(JST)を除く時間帯`;
        }
        case "constant":
          return formatValue(node.params.value);
        case "position":
          return String(node.params.state ?? "none") === "holding"
            ? "建玉を保有している"
            : "建玉を保有していない";
        case "sma":
        case "ema":
        case "rsi": {
          const period = formatValue(
            node.params.period ?? (node.type === "rsi" ? 14 : 20)
          );
          const label = `${node.type.toUpperCase()}(${period})`;
          const src = sourceNode(node.id, "in");
          // 入力未接続時は終値が使われる仕様なので、終値以外が繋がれた場合のみ明示する
          if (src && src.type !== "price") {
            return `${describe(src, visited, true)}の${label}`;
          }
          return label;
        }
        case "compare": {
          const a = describe(sourceNode(node.id, "a"), visited, true);
          const b = describe(sourceNode(node.id, "b"), visited, true);
          const op = String(node.params.op ?? "gt");
          const word =
            op === "gt" ? "を上回る" : op === "lt" ? "を下回る" : op === "gte" ? "以上になる" : "以下になる";
          return `${a} が ${b} ${word}`;
        }
        case "cross": {
          const a = describe(sourceNode(node.id, "a"), visited, true);
          const b = describe(sourceNode(node.id, "b"), visited, true);
          const word = String(node.params.op ?? "cross_above") === "cross_above" ? "上抜け" : "下抜け";
          return `${a} が ${b} を${word}する`;
        }
        case "logic": {
          const op = String(node.params.op ?? "and");
          if (op === "not") {
            const input = sourceNode(node.id, "in") ?? sourceNode(node.id, "a");
            return `「${describe(input, visited, true)}」が不成立`;
          }
          const a = describe(sourceNode(node.id, "a"), visited, true);
          const b = describe(sourceNode(node.id, "b"), visited, true);
          const joined = `${a}、${op === "and" ? "かつ" : "または"} ${b}`;
          return nested ? `(${joined})` : joined;
        }
        case "ai_judgment": {
          const expect = String(node.params.expect ?? "buy") === "buy" ? "買い" : "売り";
          const minConfidence = node.params.minConfidence;
          const confText =
            minConfidence !== undefined
              ? `(確信度${Math.round(Number(minConfidence) * 100)}%以上)`
              : "";
          return `AIが${expect}と判断する${confText}`;
        }
        case "buy":
        case "sell":
          return describe(sourceNode(node.id, "condition"), visited, nested);
        default:
          return "(不明なノード)";
      }
    } finally {
      visited.delete(node.id);
    }
  }

  const buy: string[] = [];
  const sell: string[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "buy" && node.type !== "sell") continue;
    const label = node.type === "buy" ? "Buy" : "Sell";
    const condition = sourceNode(node.id, "condition");
    if (!condition) {
      issues.push(`${label}ノードに条件が接続されていません`);
      continue;
    }
    const text = describe(node, new Set());
    if (text.includes("(未接続)")) {
      issues.push(`${label}条件の途中に未接続の入力があります`);
    }
    (node.type === "buy" ? buy : sell).push(text);
  }

  return { buy, sell, issues };
}
