import { getAiDecision, type MarketSnapshot } from "./claudeService";
import { getAnthropicApiKey } from "./anthropicClient";
import { prisma } from "../db/prisma";
import { broadcast } from "../ws/relay";
import { config } from "../config";
import { estimateCostJpy } from "./pricing";
import { getCircuitBreakerStatus, isBuyHalted } from "../trading/circuitBreaker";
import { latestValue, rsi, sma, stddev, type AiJudgment, type AiUsageStats } from "@noctas/shared";
// botEngine.tsは既に "./ai/aiJudgment" から getJudgment/setWatchedPairs をトップレベルでimportしており、
// ここでの逆方向importは循環参照になる。関数内(refreshPair)でのみ使うのでバインディングの解決自体は
// 問題ないが(pnl/summary.ts・trading/routes.tsも同じgetCandleHistoryに依存する既存パターン)、
// 変更時は必ず npm run dev:server で起動確認すること(循環import由来の問題は黙ってundefinedになりうる)。
import { getCandleHistory } from "../strategy/botEngine";

/**
 * Bot Blueprintの「AI Judgment」ノードへ供給する、ペアごとの最新AI判断キャッシュ。
 * 旧「AI判断ループ」(自律的に直接売買していた仕組み)を置き換えるもので、ここでは
 * 判断をキャッシュするだけで発注は一切行わない。発注はBot戦略のbuy/sellノード経由でのみ行われる。
 *
 * ノードを使う戦略が実際にアクティブなペアのみを対象にすることで、無関係なペアの分まで
 * Claude呼び出しコストが膨らまないようにする(botEngine.reloadActiveStrategiesがsetWatchedPairsを呼ぶ)。
 */

const HISTORY_LIMIT = 20;
const priceHistory = new Map<string, number[]>();
// tickerの24時間出来高(bitbankのticker.volをそのまま保持。取得前はundefined)
const latestVol = new Map<string, number>();
const judgmentCache = new Map<string, AiJudgment>();
const lastCallAt = new Map<string, number>();
const lastCallPrice = new Map<string, number>();

let watchedPairs = new Set<string>();

// AI判断の有効/無効。永続化された設定はsettings/routesが起動時に反映する
let enabled = true;

export function isAiJudgmentEnabled(): boolean {
  return enabled;
}

export function setAiJudgmentEnabled(next: boolean) {
  enabled = next;
  console.info(`[aiJudgment] AI判断を${next ? "有効" : "無効"}にしました`);
}

/** ai_judgmentノードを使うアクティブ戦略のペア集合を更新する(戦略の作成/更新/有効化のたびに呼ぶ) */
export function setWatchedPairs(pairs: Set<string>) {
  watchedPairs = pairs;
}

export function recordPrice(pair: string, price: number, vol24h?: number) {
  if (!watchedPairs.has(pair)) return;
  const hist = priceHistory.get(pair) ?? [];
  hist.push(price);
  if (hist.length > HISTORY_LIMIT) hist.shift();
  priceHistory.set(pair, hist);
  if (vol24h !== undefined) latestVol.set(pair, vol24h);
}

/** 指定ペアの最新AI判断キャッシュ(未取得ならnull) */
export function getJudgment(pair: string): AiJudgment | null {
  return judgmentCache.get(pair) ?? null;
}

/** 直近のJST日境界(00:00)に対応するUTC時刻を返す */
function jstDayBoundary(): { utcBoundary: Date; dateLabel: string } {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jstNow.getUTCFullYear();
  const m = jstNow.getUTCMonth();
  const d = jstNow.getUTCDate();
  const jstMidnight = Date.UTC(y, m, d, 0, 0, 0);
  const utcBoundary = new Date(jstMidnight - 9 * 60 * 60 * 1000);
  const dateLabel = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { utcBoundary, dateLabel };
}

async function getUsageStats(): Promise<AiUsageStats> {
  const { utcBoundary, dateLabel } = jstDayBoundary();

  const agg = await prisma.aiDecisionLog.aggregate({
    where: { createdAt: { gte: utcBoundary } },
    _sum: { inputTokens: true, outputTokens: true },
    _count: { id: true },
  });

  const inputTokens = agg._sum.inputTokens ?? 0;
  const outputTokens = agg._sum.outputTokens ?? 0;
  const callCount = agg._count.id;
  const estimatedCostJpy = estimateCostJpy(inputTokens, outputTokens, config.ai.model);

  return {
    date: dateLabel,
    model: config.ai.model,
    callCount,
    inputTokens,
    outputTokens,
    estimatedCostJpy,
    dailyBudgetJpy: config.ai.dailyBudgetJpy,
    budgetExceeded: estimatedCostJpy >= config.ai.dailyBudgetJpy,
  };
}

function shouldCallNow(pair: string, currentPrice: number, now: number): boolean {
  const lastAt = lastCallAt.get(pair) ?? 0;
  if (now - lastAt < config.ai.minCallIntervalMs) {
    return false;
  }
  if (now - lastAt >= config.ai.maxCallIntervalMs) {
    return true;
  }
  const lastPrice = lastCallPrice.get(pair);
  if (lastPrice === undefined) {
    return true;
  }
  const changePct = (Math.abs(currentPrice - lastPrice) / lastPrice) * 100;
  return changePct >= config.ai.priceChangeThresholdPct;
}

async function refreshPair(pair: string, now: number) {
  const hist = priceHistory.get(pair);
  if (!hist || hist.length === 0) return;

  const last = hist[hist.length - 1];
  if (!shouldCallNow(pair, last, now)) return;

  // 指標は1分足の確定クローズ系列(botEngine.tsのgetCandleHistory。config.candles.seedDays分で
  // シード済み・onTickで同期される)から計算する。recentPrices/high24h等のtickベースのpriceHistoryとは
  // 別系列だが、どちらも直近の相場を表す点は同じなのでスナップショットとしては両方渡す。
  const closes = getCandleHistory(pair).map((c) => c.close);
  const rsi14 = latestValue(rsi(closes, 14));
  const sma20 = latestValue(sma(closes, 20));
  const stddev20 = latestValue(stddev(closes, 20));
  const smaDeviationPct =
    sma20 === null ? null : ((closes[closes.length - 1] - sma20) / sma20) * 100;
  // ボラティリティはstddev20をsma20(同一ウィンドウの平均)で正規化した変動係数(%)。
  // 分母にlastではなくsma20を使うのは、直近1本の外れ値にボラティリティ表示自体が
  // 引きずられるのを避けるため。
  const volatilityPct =
    sma20 === null || stddev20 === null ? null : (stddev20 / sma20) * 100;

  const indicators = { rsi14, smaDeviationPct, volatilityPct };

  // 対象ペアで現在保有中のbuyポジション(pnl/summary.tsのopenRowsクエリと同じ形)
  const openPositions = await prisma.position.findMany({
    where: { pair, side: "buy", closedAt: null },
  });
  const openCount = openPositions.length;
  const hasOpenPosition = openCount > 0;
  let unrealizedPnlJpy: number | null = null;
  let unrealizedPnlPct: number | null = null;
  if (hasOpenPosition) {
    // pnl/summary.tsと同じ (現在値 - entryPrice) * amount 方式で建玉ごとの含み損益を合算する
    // (ただし現在値はpnl/summary.tsのローソク足終値ではなく、ここではtickerの直近値lastを使う。
    // プロンプトへの参考情報であり、ダッシュボードのPnLと1円単位で一致させる必要はないため)。
    // %損益は複数ポジションがある場合、投下元本(entryPrice*amount)で加重平均する
    // (単純平均だと小さいポジションの極端な%変動に引っ張られてしまうため)。
    let totalPnlJpy = 0;
    let totalCostJpy = 0;
    for (const pos of openPositions) {
      totalPnlJpy += (last - pos.entryPrice) * pos.amount;
      totalCostJpy += pos.entryPrice * pos.amount;
    }
    unrealizedPnlJpy = totalPnlJpy;
    unrealizedPnlPct = totalCostJpy > 0 ? (totalPnlJpy / totalCostJpy) * 100 : null;
  }

  const cbStatus = getCircuitBreakerStatus();

  const snapshot: MarketSnapshot = {
    pair,
    last,
    high24h: Math.max(...hist),
    low24h: Math.min(...hist),
    vol24h: latestVol.get(pair) ?? 0,
    recentPrices: [...hist],
    indicators,
    position: {
      hasOpenPosition,
      openCount,
      unrealizedPnlJpy,
      unrealizedPnlPct,
    },
    circuitBreaker: {
      buyHalted: isBuyHalted(),
      reason: cbStatus.reason,
    },
  };

  const decision = await getAiDecision(snapshot);

  const log = await prisma.aiDecisionLog.create({
    data: {
      pair,
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      model: decision.usage.model,
      inputTokens: decision.usage.inputTokens,
      outputTokens: decision.usage.outputTokens,
      rsi14: indicators.rsi14,
      smaDeviationPct: indicators.smaDeviationPct,
      volatilityPct: indicators.volatilityPct,
    },
  });

  lastCallAt.set(pair, now);
  lastCallPrice.set(pair, last);
  judgmentCache.set(pair, {
    pair,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    updatedAt: log.createdAt.getTime(),
  });

  console.info(
    `[aiJudgment] ${pair}: ${decision.action} (確信度${Math.round(decision.confidence * 100)}%) ${decision.reasoning}`
  );
}

export function startAiJudgmentLoop() {
  const interval = setInterval(async () => {
    try {
      const usage = await getUsageStats();
      broadcast({ type: "usage_stats", payload: usage });

      if (!enabled) return;
      if (usage.budgetExceeded) return;
      // キー未設定のまま呼び出すと毎tick例外になるだけなので、静かに待つ。
      // Settings画面から保存されれば次のtickでそのまま再開する(再起動不要)
      if (!getAnthropicApiKey()) return;

      const now = Date.now();
      for (const pair of watchedPairs) {
        await refreshPair(pair, now).catch((err) =>
          console.error(`[aiJudgment] ${pair} の判断取得に失敗しました`, err)
        );
      }
    } catch (err) {
      console.error("[aiJudgment] ループでエラーが発生しました", err);
    }
  }, config.ai.pollIntervalMs);

  return () => clearInterval(interval);
}
