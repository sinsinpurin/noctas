import type {
  AiAction,
  CompareOp,
  CrossOp,
  LogicOp,
  StrategyEdge,
  StrategyGraph,
  StrategyNode,
} from "./index";
import { ema, rsi, sma } from "./indicators";

/**
 * 戦略グラフの評価器。サーバーのBotエンジンとWebエディタのライブプレビューで共用する。
 * 各ノードを終値シリーズ全体に対して評価し(数値シリーズ or 真偽シリーズ)、
 * buy/sellアクションノードに入力された条件の「最新値」と「1つ前の値」を返す。
 * 発火判定(立ち上がりエッジ検出)は呼び出し側が行う。
 */

type Series = number[] | boolean[];

/** 各ノードの最新値。数値ノードはnumber、条件ノードはboolean、未計算(ウォームアップ中など)はnull */
export type NodeLiveValue = number | boolean | null;

export interface ActionConditionState {
  /** 最新時点で条件が成立しているか */
  current: boolean;
  /** 1つ前の時点で条件が成立していたか(立ち上がり検出用) */
  previous: boolean;
}

export interface EvaluationResult {
  buy: ActionConditionState;
  sell: ActionConditionState;
  errors: string[];
  /** ノードIDごとの最新値(collectValues=trueのとき全ノード分を含む) */
  nodeValues: Record<string, NodeLiveValue>;
}

const FALSE_STATE: ActionConditionState = { current: false, previous: false };

function numberParam(node: StrategyNode, key: string, fallback: number): number {
  const raw = node.params[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringParam(node: StrategyNode, key: string, fallback: string): string {
  const raw = node.params[key];
  return typeof raw === "string" && raw !== "" ? raw : fallback;
}

function asNumberSeries(series: Series | null, length: number): number[] {
  if (!series) return new Array<number>(length).fill(NaN);
  if (series.length > 0 && typeof series[0] === "boolean") {
    return (series as boolean[]).map((v) => (v ? 1 : 0));
  }
  return series as number[];
}

function asBoolSeries(series: Series | null, length: number): boolean[] {
  if (!series) return new Array<boolean>(length).fill(false);
  if (series.length === 0 || typeof series[0] === "boolean") {
    return series as boolean[];
  }
  return (series as number[]).map((v) => Number.isFinite(v) && v > 0);
}

export interface EvaluateOptions {
  /** trueにするとアクションノードから辿れないノードも含め、全ノードの最新値をnodeValuesへ格納する */
  collectValues?: boolean;
  /**
   * ai_judgmentノード用。呼び出し側がペアごとに解決した現在のAI判断キャッシュを渡す。
   * isFreshは「このtickで初めて観測した新しい判断か」を示し、trueの間だけ条件の立ち上がり
   * (false→true)を許可する(同じ判断で連続発火しないようにするため)。
   * 未指定(undefined/null)の場合、ai_judgmentノードは常にfalseを返す。
   */
  aiJudgment?: { action: AiAction; confidence: number; isFresh: boolean } | null;
  /**
   * positionノード用。この戦略がこのペアで未決済の建玉を持っているか。
   * 未指定の場合はfalse(建玉なし)として扱う。
   */
  hasOpenPosition?: boolean;
  /**
   * volumeノード用。closesと同じ長さの出来高シリーズ。未指定または長さ不一致の場合、
   * volumeノードは常にNaN(未計算)を返す。
   */
  volumes?: number[];
  /**
   * time_filterノード用。closesと同じ長さのUNIXエポック秒配列(UTC)。未指定または長さ不一致の場合、
   * time_filterノードは常にtrue(制限なし)を返す。volumeノードのNaNフォールバックと異なり、
   * このノードの出力はエントリー条件へ直結されるゲートなので、データが無いことを理由に
   * 取引を止めてしまわないよう「許可」側へフォールバックする。
   */
  timestamps?: number[];
}

export function evaluateGraph(
  graph: StrategyGraph,
  closes: number[],
  options: EvaluateOptions = {}
): EvaluationResult {
  const length = closes.length;
  const errors: string[] = [];
  const nodeById = new Map<string, StrategyNode>(graph.nodes.map((n) => [n.id, n]));

  // target側から見た入力エッジ: nodeId -> handle -> edge
  const inputEdges = new Map<string, Map<string, StrategyEdge>>();
  for (const edge of graph.edges) {
    if (!inputEdges.has(edge.target)) inputEdges.set(edge.target, new Map());
    inputEdges.get(edge.target)!.set(edge.targetHandle ?? "in", edge);
  }

  const cache = new Map<string, Series | null>();
  const visiting = new Set<string>();

  function inputSeries(nodeId: string, handle: string): Series | null {
    const edge = inputEdges.get(nodeId)?.get(handle);
    if (!edge) return null;
    return evalNode(edge.source);
  }

  function evalNode(nodeId: string): Series | null {
    if (cache.has(nodeId)) return cache.get(nodeId)!;
    if (visiting.has(nodeId)) {
      errors.push(`循環参照を検出しました (node: ${nodeId})`);
      return null;
    }
    const node = nodeById.get(nodeId);
    if (!node) {
      errors.push(`存在しないノードへの参照があります (node: ${nodeId})`);
      return null;
    }

    visiting.add(nodeId);
    let result: Series | null = null;

    switch (node.type) {
      case "price":
        result = closes;
        break;

      case "volume": {
        result =
          options.volumes && options.volumes.length === length
            ? options.volumes
            : new Array<number>(length).fill(NaN);
        break;
      }

      case "constant": {
        const value = numberParam(node, "value", 0);
        result = new Array<number>(length).fill(value);
        break;
      }

      case "sma":
      case "ema":
      case "rsi": {
        // 入力が未接続の場合は終値シリーズを使う
        const input = asNumberSeries(inputSeries(nodeId, "in") ?? closes, length);
        const period = numberParam(node, "period", node.type === "rsi" ? 14 : 20);
        if (node.type === "sma") result = sma(input, period);
        else if (node.type === "ema") result = ema(input, period);
        else result = rsi(input, period);
        break;
      }

      case "compare": {
        const op = stringParam(node, "op", "gt") as CompareOp;
        const a = asNumberSeries(inputSeries(nodeId, "a"), length);
        const b = asNumberSeries(inputSeries(nodeId, "b"), length);
        result = a.map((av, i) => {
          const bv = b[i];
          if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
          switch (op) {
            case "gt":
              return av > bv;
            case "lt":
              return av < bv;
            case "gte":
              return av >= bv;
            case "lte":
              return av <= bv;
            default:
              return false;
          }
        });
        break;
      }

      case "cross": {
        const op = stringParam(node, "op", "cross_above") as CrossOp;
        const a = asNumberSeries(inputSeries(nodeId, "a"), length);
        const b = asNumberSeries(inputSeries(nodeId, "b"), length);
        result = a.map((av, i) => {
          if (i === 0) return false;
          const bv = b[i];
          const prevA = a[i - 1];
          const prevB = b[i - 1];
          if (
            !Number.isFinite(av) ||
            !Number.isFinite(bv) ||
            !Number.isFinite(prevA) ||
            !Number.isFinite(prevB)
          ) {
            return false;
          }
          return op === "cross_above" ? av > bv && prevA <= prevB : av < bv && prevA >= prevB;
        });
        break;
      }

      case "logic": {
        const op = stringParam(node, "op", "and") as LogicOp;
        if (op === "not") {
          const input = asBoolSeries(inputSeries(nodeId, "in") ?? inputSeries(nodeId, "a"), length);
          result = input.map((v) => !v);
        } else {
          const a = asBoolSeries(inputSeries(nodeId, "a"), length);
          const b = asBoolSeries(inputSeries(nodeId, "b"), length);
          result = a.map((av, i) => (op === "and" ? av && b[i] : av || b[i]));
        }
        break;
      }

      case "position": {
        const expect = stringParam(node, "state", "none");
        const holding = options.hasOpenPosition ?? false;
        // ai_judgmentと違いシリーズ全体を現在の状態で埋める。これにより「建玉なし AND クロス」は
        // クロスの瞬間ちょうどに立ち上がり、建玉を持っている間は再発火しない。
        // 副作用として、RSIのようなレベル系条件と組み合わせた場合は、決済直後のtickで条件が
        // まだ真のままだと(このノードの出力が過去分も含めて真に変わるため)エッジが立たず
        // 再エントリーが1tick分だけ抑止される。クロス系条件と組み合わせるのが最も素直に働く
        result = new Array<boolean>(length).fill(expect === "holding" ? holding : !holding);
        break;
      }

      case "time_filter": {
        const timestamps =
          options.timestamps && options.timestamps.length === length ? options.timestamps : null;
        const excludeStartHour = numberParam(node, "excludeStartHour", 0);
        const excludeEndHour = numberParam(node, "excludeEndHour", 0);
        result = new Array<boolean>(length).fill(true).map((_, i) => {
          if (!timestamps) return true;
          const t = timestamps[i];
          // 負のtにも対応する安全な剰余(JSの%は被除数が負だと結果も負になるため)
          const secOfDay = ((t % 86400) + 86400) % 86400;
          const hourUTC = Math.floor(secOfDay / 3600);
          const jstHour = (hourUTC + 9) % 24;
          let insideExcludedWindow: boolean;
          if (excludeStartHour === excludeEndHour) {
            insideExcludedWindow = false;
          } else if (excludeStartHour < excludeEndHour) {
            insideExcludedWindow = jstHour >= excludeStartHour && jstHour < excludeEndHour;
          } else {
            insideExcludedWindow = jstHour >= excludeStartHour || jstHour < excludeEndHour;
          }
          return !insideExcludedWindow;
        });
        break;
      }

      case "ai_judgment": {
        const expect = stringParam(node, "expect", "buy");
        const minConfidence = numberParam(node, "minConfidence", 0);
        const judgment = options.aiJudgment ?? null;
        const matches =
          judgment !== null && judgment.action === expect && judgment.confidence >= minConfidence;
        const series = new Array<boolean>(length).fill(false);
        if (matches && length > 0) {
          series[length - 1] = true;
          // 新規判断でなければ(=前回のtickから既に成立していたなら)立ち上がりエッジにしない
          if (length > 1) series[length - 2] = !judgment!.isFresh;
        }
        result = series;
        break;
      }

      case "buy":
      case "sell": {
        result = asBoolSeries(inputSeries(nodeId, "condition"), length);
        break;
      }

      default:
        errors.push(`未知のノード種別です (type: ${node.type})`);
        result = null;
    }

    visiting.delete(nodeId);
    cache.set(nodeId, result);
    return result;
  }

  function actionState(type: "buy" | "sell"): ActionConditionState {
    const actionNodes = graph.nodes.filter((n) => n.type === type);
    if (actionNodes.length === 0 || length < 2) return FALSE_STATE;

    // 複数のアクションノードがある場合はいずれかが成立していれば発火
    let current = false;
    let previous = false;
    for (const node of actionNodes) {
      const series = asBoolSeries(evalNode(node.id), length);
      current = current || (series[length - 1] ?? false);
      previous = previous || (series[length - 2] ?? false);
    }
    return { current, previous };
  }

  const buy = actionState("buy");
  const sell = actionState("sell");

  const nodeValues: Record<string, NodeLiveValue> = {};
  if (options.collectValues) {
    for (const node of graph.nodes) {
      const series = evalNode(node.id);
      const last = series && length > 0 ? series[length - 1] : null;
      if (typeof last === "boolean" || (typeof last === "number" && Number.isFinite(last))) {
        nodeValues[node.id] = last;
      } else if (
        node.type === "compare" ||
        node.type === "cross" ||
        node.type === "logic" ||
        node.type === "position"
      ) {
        // 条件系は入力未接続・データ不足でも「不成立」として扱う
        nodeValues[node.id] = false;
      } else {
        nodeValues[node.id] = null;
      }
    }
  }

  return { buy, sell, errors, nodeValues };
}

/** 保存されたJSON文字列を安全にStrategyGraphへ変換する */
export function parseGraph(json: string): StrategyGraph | null {
  try {
    const parsed = JSON.parse(json) as StrategyGraph;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}
