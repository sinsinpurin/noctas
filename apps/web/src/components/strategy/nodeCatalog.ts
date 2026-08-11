import type { StrategyNodeParams, StrategyNodeType } from "@noctas/shared";

/** ハンドルを流れる値の種類。number=数値シリーズ、bool=真偽シリーズ */
export type PortKind = "number" | "bool";

export interface PortDef {
  id: string;
  label: string;
  kind: PortKind;
}

export type NodeCategory = "source" | "indicator" | "condition" | "logic" | "ai" | "action";

export interface NodeDef {
  type: StrategyNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  defaultParams: StrategyNodeParams;
  /** paramsの編集UI定義 */
  paramFields: ParamField[];
}

export type ParamField =
  | { key: string; label: string; kind: "number"; min?: number; max?: number; step?: number }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] };

/** カテゴリごとのシグナルカラー(デザインシステムのネオン運用に準拠) */
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  source: "#00E5FF",
  indicator: "#00E5FF",
  condition: "#FF8A1E",
  logic: "#FCEE0A",
  ai: "#FF003C", // Claude APIを呼び出す=コストが発生することを示す
  action: "#39FF88", // buy。sellは個別に赤へ上書き
};

export const PORT_COLOR: Record<PortKind, string> = {
  number: "#00E5FF",
  bool: "#FF8A1E",
};

export const NODE_CATALOG: NodeDef[] = [
  {
    type: "price",
    label: "Price",
    category: "source",
    description: "BTC/JPYの終値シリーズ(1分足)",
    inputs: [],
    outputs: [{ id: "out", label: "close", kind: "number" }],
    defaultParams: {},
    paramFields: [],
  },
  {
    type: "volume",
    label: "Volume",
    category: "source",
    description: "その足の出来高シリーズ。SMA/EMAと組み合わせて出来高移動平均、Cross/Compareと組み合わせて出来高スパイク検知に使う",
    inputs: [],
    outputs: [{ id: "out", label: "volume", kind: "number" }],
    defaultParams: {},
    paramFields: [],
  },
  {
    type: "constant",
    label: "Constant",
    category: "source",
    description: "固定値。しきい値との比較に使う",
    inputs: [],
    outputs: [{ id: "out", label: "value", kind: "number" }],
    defaultParams: { value: 100 },
    paramFields: [{ key: "value", label: "値", kind: "number", step: 1 }],
  },
  {
    type: "position",
    label: "Position",
    category: "source",
    description:
      "この戦略が未決済の建玉を持っているか。エントリー条件のゲートに使う。クロス系の条件と組み合わせるのが最も安全",
    inputs: [],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { state: "none" },
    paramFields: [
      {
        key: "state",
        label: "状態",
        kind: "select",
        options: [
          { value: "none", label: "建玉なし" },
          { value: "holding", label: "建玉あり" },
        ],
      },
    ],
  },
  {
    type: "time_filter",
    label: "Time Filter",
    category: "source",
    description:
      "現在の足の時刻(JST)が指定した時間帯の外にあるとき真を返す。深夜・薄商いの時間帯を避けたいときに、logic(and)でエントリー条件と直接組み合わせる(NOT不要)",
    inputs: [],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { excludeStartHour: 2, excludeEndHour: 6 },
    paramFields: [
      { key: "excludeStartHour", label: "除外開始時(JST)", kind: "number", min: 0, max: 23, step: 1 },
      { key: "excludeEndHour", label: "除外終了時(JST)", kind: "number", min: 0, max: 23, step: 1 },
    ],
  },
  {
    type: "sma",
    label: "SMA",
    category: "indicator",
    description: "単純移動平均。入力未接続時は終値を使う",
    inputs: [{ id: "in", label: "src", kind: "number" }],
    outputs: [{ id: "out", label: "sma", kind: "number" }],
    defaultParams: { period: 20 },
    paramFields: [{ key: "period", label: "期間", kind: "number", min: 1, step: 1 }],
  },
  {
    type: "ema",
    label: "EMA",
    category: "indicator",
    description: "指数移動平均。入力未接続時は終値を使う",
    inputs: [{ id: "in", label: "src", kind: "number" }],
    outputs: [{ id: "out", label: "ema", kind: "number" }],
    defaultParams: { period: 20 },
    paramFields: [{ key: "period", label: "期間", kind: "number", min: 1, step: 1 }],
  },
  {
    type: "rsi",
    label: "RSI",
    category: "indicator",
    description: "相対力指数(0-100)。入力未接続時は終値を使う",
    inputs: [{ id: "in", label: "src", kind: "number" }],
    outputs: [{ id: "out", label: "rsi", kind: "number" }],
    defaultParams: { period: 14 },
    paramFields: [{ key: "period", label: "期間", kind: "number", min: 2, step: 1 }],
  },
  {
    type: "compare",
    label: "Compare",
    category: "condition",
    description: "AとBの大小を比較して真偽を返す",
    inputs: [
      { id: "a", label: "A", kind: "number" },
      { id: "b", label: "B", kind: "number" },
    ],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { op: "gt" },
    paramFields: [
      {
        key: "op",
        label: "条件",
        kind: "select",
        options: [
          { value: "gt", label: "A > B" },
          { value: "lt", label: "A < B" },
          { value: "gte", label: "A ≥ B" },
          { value: "lte", label: "A ≤ B" },
        ],
      },
    ],
  },
  {
    type: "cross",
    label: "Cross",
    category: "condition",
    description: "AがBを上抜け/下抜けした瞬間に真を返す",
    inputs: [
      { id: "a", label: "A", kind: "number" },
      { id: "b", label: "B", kind: "number" },
    ],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { op: "cross_above" },
    paramFields: [
      {
        key: "op",
        label: "方向",
        kind: "select",
        options: [
          { value: "cross_above", label: "A が B を上抜け" },
          { value: "cross_below", label: "A が B を下抜け" },
        ],
      },
    ],
  },
  {
    type: "logic",
    label: "Logic",
    category: "logic",
    description: "条件同士をAND/OR/NOTで合成する",
    inputs: [
      { id: "a", label: "A", kind: "bool" },
      { id: "b", label: "B", kind: "bool" },
    ],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { op: "and" },
    paramFields: [
      {
        key: "op",
        label: "演算",
        kind: "select",
        options: [
          { value: "and", label: "AND" },
          { value: "or", label: "OR" },
          { value: "not", label: "NOT (Aのみ)" },
        ],
      },
    ],
  },
  {
    type: "ai_judgment",
    label: "AI Judgment",
    category: "ai",
    description:
      "Claudeによる売買判断が一致した瞬間に真を返す。数分間隔でAPIを呼び出すためコストが発生する",
    inputs: [],
    outputs: [{ id: "out", label: "cond", kind: "bool" }],
    defaultParams: { expect: "buy", minConfidence: 0.6 },
    paramFields: [
      {
        key: "expect",
        label: "判断",
        kind: "select",
        options: [
          { value: "buy", label: "BUYと判断" },
          { value: "sell", label: "SELLと判断" },
        ],
      },
      { key: "minConfidence", label: "最小確信度", kind: "number", min: 0, step: 0.05 },
    ],
  },
  {
    type: "buy",
    label: "Buy",
    category: "action",
    description: "条件が成立した瞬間に買い注文(ペーパー)",
    inputs: [{ id: "condition", label: "cond", kind: "bool" }],
    outputs: [],
    defaultParams: {},
    paramFields: [],
  },
  {
    type: "sell",
    label: "Sell",
    category: "action",
    description: "条件が成立した瞬間に保有ポジションを決済",
    inputs: [{ id: "condition", label: "cond", kind: "bool" }],
    outputs: [],
    defaultParams: {},
    paramFields: [],
  },
];

export const NODE_DEF_BY_TYPE = new Map(NODE_CATALOG.map((def) => [def.type, def]));

export function nodeAccentColor(type: StrategyNodeType): string {
  if (type === "sell") return "#FF003C";
  const def = NODE_DEF_BY_TYPE.get(type);
  return def ? CATEGORY_COLOR[def.category] : "#00E5FF";
}
