import {
  minutesOfTimeframe,
  type BacktestRequest,
  type CandleTimeframe,
  type Pair,
  type StrategyGraph,
  type WalkForwardParamGrid,
  type WalkForwardSummary,
  type WalkForwardWindowResult,
} from "@noctas/shared";
import { runBacktest } from "./backtestEngine";
import type { CandleBucket } from "./botEngine";

/**
 * アクティブ戦略のSL/TP/トレーリングストップを、ローリング3ヶ月スナップショット
 * (historicalCandleStore.ts)に対してウォークフォワード検証する読み取り専用エンジン。
 * backtestEngine.ts(単一パラメータ/単一系列のシミュレータ)はそのまま再利用し、
 * ここでは「ウィンドウ分割 → in-sampleでのグリッドサーチ → out-of-sampleでの再生」だけを担う。
 * 戦略の保存済み設定(Strategy.stopLossPct等)への書き込みは一切行わない。
 *
 * backtestEngine.runBacktest はグラフをキャンドルごとに再評価するためO(n²)であるとベンチマーク済み
 * (43,200本=30日@1分足で約3.9秒、129,600本=90日@1分足で約32.9秒)。そのためウィンドウは
 * 「カレンダー日数」ではなく「足数」で上限をクランプし、既定の時間足(1min)ではウィンドウが
 * 意図した日数より短くなる。その場合はwarningsに明記する(下記のisCandlesFor/oosCandlesForを参照)。
 */

export const DEFAULT_GRID: WalkForwardParamGrid = {
  stopLossPct: [1, 1.5, 2, 3],
  takeProfitPct: [0, 2, 4, 6],
  trailingStopPct: [null, 1.5, 3],
};

// in-sampleウィンドウが確保しようとする日数(足数の上限でクランプされる)
const IS_DAYS = 25;
// out-of-sampleウィンドウが確保しようとする日数(足数の上限でクランプされる)
const OOS_DAYS = 8;
const IS_CANDLES_MIN = 300;
const IS_CANDLES_MAX = 1500;
const OOS_CANDLES_MIN = 100;
const OOS_CANDLES_MAX = 500;

// in-sampleの最良パラメータ選定でトレード数がこれ未満の候補は「低信頼度」として扱う
const MIN_TRADES_IS = 3;
// 意味のある集計(consistencyRatio等)を出すための最低ウィンドウ数
export const MIN_WINDOWS = 3;
// 1戦略あたりの上限ウィンドウ数(合計のrunBacktest呼び出し回数を抑えるため)
export const MAX_WINDOWS = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function daysToCandles(days: number, timeframe: CandleTimeframe): number {
  return Math.round((days * 24 * 60) / minutesOfTimeframe(timeframe));
}

function candlesToDays(candleCount: number, timeframe: CandleTimeframe): number {
  return (candleCount * minutesOfTimeframe(timeframe)) / (24 * 60);
}

/** 時間足に応じたin-sampleウィンドウの足数(足数上限でクランプ済み) */
export function isCandlesFor(timeframe: CandleTimeframe): number {
  return clamp(daysToCandles(IS_DAYS, timeframe), IS_CANDLES_MIN, IS_CANDLES_MAX);
}

/** 時間足に応じたout-of-sampleウィンドウの足数(足数上限でクランプ済み) */
export function oosCandlesFor(timeframe: CandleTimeframe): number {
  return clamp(daysToCandles(OOS_DAYS, timeframe), OOS_CANDLES_MIN, OOS_CANDLES_MAX);
}

/**
 * 複数戦略を1リクエストでまとめて検証する際、合計のrunBacktest呼び出し回数が膨らみすぎないよう、
 * MAX_WINDOWSをアクティブ戦略数で割って1戦略あたりのウィンドウ上限を縮小するヘルパー。
 * MIN_WINDOWS未満には縮めない(縮めても意味のある検証にならないため、その場合は各戦略の所要時間で
 * 全体のレスポンス時間が伸びることを許容する)。
 */
export function maxWindowsForBatch(activeStrategyCount: number): number {
  const count = Math.max(1, activeStrategyCount);
  return clamp(Math.floor(MAX_WINDOWS / count), MIN_WINDOWS, MAX_WINDOWS);
}

export interface CandleWindow {
  is: CandleBucket[];
  oos: CandleBucket[];
}

/**
 * ローソク足の系列を、非重複のout-of-sampleウィンドウで時系列前方へタイル状に敷き詰めた
 * (in-sample, out-of-sample)の組へ分割する純粋関数。
 * 作成できるウィンドウ数がMIN_WINDOWS未満の場合は空配列を返す(呼び出し元が警告を出す)。
 * データが要求より多い場合は、より市況が新しい直近側のウィンドウを優先して残す。
 */
export function buildWindows(
  candles: CandleBucket[],
  isCandles: number,
  oosCandles: number,
  maxWindows: number = MAX_WINDOWS
): CandleWindow[] {
  if (isCandles <= 0 || oosCandles <= 0) return [];

  const maxPossible = Math.floor((candles.length - isCandles) / oosCandles);
  if (maxPossible < MIN_WINDOWS) return [];

  const windowCount = Math.min(maxPossible, Math.max(1, maxWindows));
  const skip = maxPossible - windowCount; // 直近側のウィンドウを優先して残す

  const windows: CandleWindow[] = [];
  for (let i = 0; i < windowCount; i += 1) {
    const idx = skip + i;
    const oosStart = isCandles + idx * oosCandles;
    const oosEnd = oosStart + oosCandles;
    const isStart = oosStart - isCandles;
    windows.push({
      is: candles.slice(isStart, oosStart),
      oos: candles.slice(oosStart, oosEnd),
    });
  }
  return windows;
}

interface GridCandidate {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
}

function gridCombinations(grid: WalkForwardParamGrid): GridCandidate[] {
  const combos: GridCandidate[] = [];
  for (const stopLossPct of grid.stopLossPct) {
    for (const takeProfitPct of grid.takeProfitPct) {
      for (const trailingStopPct of grid.trailingStopPct) {
        combos.push({ stopLossPct, takeProfitPct, trailingStopPct });
      }
    }
  }
  return combos;
}

function emptyAggregate(): WalkForwardSummary["aggregate"] {
  return {
    outOfSampleRealizedPnl: 0,
    outOfSampleWinRate: null,
    outOfSampleProfitFactor: null,
    outOfSampleMaxDrawdown: 0,
    outOfSampleTrades: 0,
    consistencyRatio: null,
  };
}

/**
 * 各ウィンドウのout-of-sample結果を時系列順に連結し、集計する。
 * profitFactor/winRateはウィンドウ単位の平均ではなく、全OOSトレードを合算して算出する
 * (トレード数が少ないウィンドウの影響が不当に大きくならないようにするため)。
 * maxDrawdownは各ウィンドウのOOS区間を連結した累積損益カーブに対するpeak-to-troughで算出する。
 */
function computeAggregate(windows: WalkForwardWindowResult[]): WalkForwardSummary["aggregate"] {
  if (windows.length === 0) return emptyAggregate();

  let realizedPnl = 0;
  let winCount = 0;
  let lossCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let nonNegativeWindows = 0;

  for (const w of windows) {
    if (w.outOfSample.realizedPnl >= 0) nonNegativeWindows += 1;
    for (const trade of w.outOfSample.trades) {
      realizedPnl += trade.pnl;
      if (trade.pnl >= 0) {
        winCount += 1;
        grossProfit += trade.pnl;
      } else {
        lossCount += 1;
        grossLoss += -trade.pnl;
      }
      peak = Math.max(peak, realizedPnl);
      maxDrawdown = Math.max(maxDrawdown, peak - realizedPnl);
    }
  }

  return {
    outOfSampleRealizedPnl: realizedPnl,
    outOfSampleWinRate: winCount + lossCount > 0 ? winCount / (winCount + lossCount) : null,
    outOfSampleProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    outOfSampleMaxDrawdown: maxDrawdown,
    outOfSampleTrades: winCount + lossCount,
    consistencyRatio: nonNegativeWindows / windows.length,
  };
}

/** グリッド候補を安定なキー文字列に変換する(trailingStopPct=nullは"null"として区別する) */
function paramKey(params: GridCandidate): string {
  return `${params.stopLossPct}|${params.takeProfitPct}|${params.trailingStopPct ?? "null"}`;
}

/**
 * 各ウィンドウのbestParamsから、戦略に適用する推奨パラメータを1つ選ぶ純粋関数。
 * 最も多くのウィンドウで選ばれた組み合わせ(mode)を採用し、複数の組み合わせが同数タイの場合は
 * out-of-sample realizedPnl合計が最大のものを採用する。ウィンドウが1つも無ければnullを返す。
 */
export function pickRecommendedParams(
  windows: WalkForwardWindowResult[]
): { stopLossPct: number; takeProfitPct: number; trailingStopPct: number | null } | null {
  if (windows.length === 0) return null;

  const groups = new Map<
    string,
    { params: WalkForwardWindowResult["bestParams"]; count: number; oosRealizedPnl: number }
  >();
  for (const w of windows) {
    const key = paramKey(w.bestParams);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.oosRealizedPnl += w.outOfSample.realizedPnl;
    } else {
      groups.set(key, { params: w.bestParams, count: 1, oosRealizedPnl: w.outOfSample.realizedPnl });
    }
  }

  let best: { params: WalkForwardWindowResult["bestParams"]; count: number; oosRealizedPnl: number } | null =
    null;
  for (const candidate of groups.values()) {
    if (
      best === null ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.oosRealizedPnl > best.oosRealizedPnl)
    ) {
      best = candidate;
    }
  }

  return best ? best.params : null;
}

/**
 * 1戦略についてウォークフォワード検証を実行する。
 * 各ウィンドウのin-sampleに対しグリッド全通り(既定48通り)をbacktestEngine.runBacktestで試し、
 * winCount+lossCount >= MIN_TRADES_IS を満たす候補の中からrealizedPnl最大のものを最良パラメータに
 * 選ぶ。該当候補が無ければトレード数条件を無視してrealizedPnl最大のものを選び、warningsに
 * 「低信頼度」の注記を加える。選んだパラメータでout-of-sampleを実行し、両方のサマリを記録する。
 */
export function runWalkForwardForStrategy(
  graph: StrategyGraph,
  pair: Pair,
  timeframe: CandleTimeframe,
  positionSizeJpy: number,
  maxOpenPositions: number,
  candles: CandleBucket[],
  maxWindowsOverride?: number,
  grid: WalkForwardParamGrid = DEFAULT_GRID
): WalkForwardSummary {
  const warnings: string[] = [];
  const maxWindows = clamp(maxWindowsOverride ?? MAX_WINDOWS, 1, MAX_WINDOWS);
  const isCandles = isCandlesFor(timeframe);
  const oosCandles = oosCandlesFor(timeframe);

  const actualIsDays = candlesToDays(isCandles, timeframe);
  const actualOosDays = candlesToDays(oosCandles, timeframe);
  if (actualIsDays < IS_DAYS - 0.01 || actualOosDays < OOS_DAYS - 0.01) {
    warnings.push(
      `計算量(runBacktestはO(n²))を抑えるため、1ウィンドウあたりの足数に上限があります。` +
        `この時間足(${timeframe})では in-sample が意図した${IS_DAYS}日分ではなく約${actualIsDays.toFixed(1)}日分(${isCandles}本)、` +
        `out-of-sample が意図した${OOS_DAYS}日分ではなく約${actualOosDays.toFixed(1)}日分(${oosCandles}本)しかカバーしていません。` +
        `時間足が細かいほどこの傾向が強くなります。`
    );
  }

  const rawWindows = buildWindows(candles, isCandles, oosCandles, maxWindows);
  if (rawWindows.length === 0) {
    warnings.push(
      `ウィンドウを${MIN_WINDOWS}個以上作成するにはローソク足が不足しています` +
        `(必要本数の目安: 約${isCandles + oosCandles * MIN_WINDOWS}本、実際に利用可能な本数: ${candles.length}本)。`
    );
    return {
      warnings,
      windowCount: 0,
      windows: [],
      aggregate: emptyAggregate(),
      recommendedParams: null,
      dataStartAt: candles[0]?.time,
      dataEndAt: candles[candles.length - 1]?.time,
    };
  }

  const combos = gridCombinations(grid);
  const baseRequest = (params: GridCandidate): BacktestRequest => ({
    graph,
    pair,
    timeframe,
    positionSizeJpy,
    maxOpenPositions,
    ...params,
  });

  const windows: WalkForwardWindowResult[] = rawWindows.map((window, index) => {
    const isResults = combos.map((params) => ({
      params,
      summary: runBacktest(baseRequest(params), window.is),
    }));
    const qualifying = isResults.filter((r) => r.summary.winCount + r.summary.lossCount >= MIN_TRADES_IS);
    const pool = qualifying.length > 0 ? qualifying : isResults;
    if (qualifying.length === 0) {
      warnings.push(
        `ウィンドウ${index}: in-sampleでトレード数が${MIN_TRADES_IS}件以上の候補が無かったため、` +
          `トレード数条件を無視して選んだ最良パラメータです(低信頼度)。`
      );
    }
    const best = pool.reduce((a, b) => (b.summary.realizedPnl > a.summary.realizedPnl ? b : a));
    const outOfSample = runBacktest(baseRequest(best.params), window.oos);

    return {
      windowIndex: index,
      inSampleStart: window.is[0].time * 1000,
      inSampleEnd: window.is[window.is.length - 1].time * 1000,
      outOfSampleStart: window.oos[0].time * 1000,
      outOfSampleEnd: window.oos[window.oos.length - 1].time * 1000,
      bestParams: best.params,
      inSample: best.summary,
      outOfSample,
    };
  });

  return {
    warnings,
    windowCount: windows.length,
    windows,
    aggregate: computeAggregate(windows),
    recommendedParams: pickRecommendedParams(windows),
    dataStartAt: candles[0]?.time,
    dataEndAt: candles[candles.length - 1]?.time,
  };
}
