import {
  evaluateGraph,
  type BacktestRequest,
  type BacktestSummary,
  type BacktestTrade,
  type BacktestExecutionMode,
  type PnlCurvePoint,
  type TradeReason,
} from "@noctas/shared";
import { config } from "../config";
import { getCandlesForTimeframe, type CandleBucket } from "./botEngine";
import { executionPrice, feeOf } from "../trading/paperTradingEngine";
import { resolveExitReason } from "../trading/riskManager";

/**
 * Bot Blueprintのグラフを、サーバーが既に保持している過去ローソク足履歴に対して
 * ウォークフォワードで再生する読み取り専用のバックテストエンジン。
 * 実際のポジション管理(trading/paperTradingEngine.ts)・AI判断ループには一切書き込みも呼び出しも行わない。
 *
 * 既知の簡略化(いずれもUI/Docsに明記する):
 * - ai_judgmentノードは過去の判断ログを再現できないため、常に不成立(false)として評価する
 * - サーキットブレーカー(trading/circuitBreaker.ts)はシミュレートしない
 * - 出口条件(SL/TP/トレーリング)はローソク足の高値/低値を使うが、同一足内で両方の条件を
 *   満たす場合は「安値側(ストップロス/トレーリング)が先に発生した」と保守的に仮定する
 * - JPY残高・同時保有できる資産量などの資金制約はシミュレートしない(maxOpenPositionsのみ適用)
 */

/**
 * runBacktest()はローソク足1本ごとにevaluateGraph()をゼロから再計算する(インクリメンタル評価ではない)
 * ため、実質O(n²)の計算量特性を持つ。実測では90日分(1分足で129,600本)を評価すると約32.9秒かかり、
 * その間await/yieldが一切無い単一の同期呼び出しになるためNode.jsのイベントループを丸ごと専有し、
 * 他のHTTPリクエスト・WebSocket tick処理も含めてサーバー全体が応答不能になる(単なる「遅い」では済まない)。
 *
 * この定数は「3ヶ月シミュレーション(period: "three_months")」のリクエストを、この危険域に入る前に
 * 400で拒否するための閾値。5分足=90日で25,920本は通し、1分足=90日で129,600本は拒否する境界として
 * 35,000を選んでいる。根本解決(インクリメンタル評価への書き換え)は別issueのスコープとし、ここでは
 * 危険な本数のリクエストを事前に弾く応急処置のみを行う(routes.tsの/api/strategies/backtestハンドラ側で
 * この定数を使ってrunBacktest呼び出し自体をスキップする)。
 */
export const THREE_MONTH_BACKTEST_MAX_CANDLES = 35_000;

interface OpenSimPosition {
  entryPrice: number;
  amount: number;
  entryFee: number;
  openedAt: number;
  highestPrice: number;
}

function emptySummary(
  candleCount: number,
  warnings: string[],
  period: BacktestSummary["period"],
  candles: CandleBucket[],
  initialBalanceJpy = 1_000_000
): BacktestSummary {
  return {
    candleCount,
    warnings,
    realizedPnl: 0,
    winCount: 0,
    lossCount: 0,
    winRate: null,
    avgWin: null,
    avgLoss: null,
    profitFactor: null,
    maxDrawdown: 0,
    liquidationMaxDrawdown: 0,
    liquidationMaxDrawdownPct: null,
    unrealizedPnl: 0,
    endingEquityJpy: Math.max(0, initialBalanceJpy),
    totalFeesJpy: 0,
    grossPnlJpy: 0,
    feeLossCount: 0,
    equityCurve: [],
    liquidationEquityCurve: [],
    trades: [],
    period,
    dataStartAt: candles[0]?.time,
    dataEndAt: candles[candles.length - 1]?.time,
  };
}

/**
 * 1本の足について、保有中のポジションが出口条件(SL/TP/トレーリング)に達したかを判定する。
 * 安値(low)でストップロス/トレーリングストップを、高値(high)でテイクプロフィットを判定し、
 * 両方が同一足内で成立する場合は安値側(ストップロス/トレーリング優先)が先に発生したとみなす。
 */
function checkPositionExit(
  pos: OpenSimPosition,
  candle: CandleBucket,
  stopLossPct: number | null,
  takeProfitPct: number | null,
  trailingStopPct: number | null
): { reason: TradeReason; price: number } | null {
  if (candle.high > pos.highestPrice) pos.highestPrice = candle.high;

  // 安値側: take_profitは無効化(0=利確なし指定)してstop_loss/trailing_stopだけ判定する
  const worstCase = resolveExitReason({
    entryPrice: pos.entryPrice,
    currentPrice: candle.low,
    highestPrice: pos.highestPrice,
    stopLossPct,
    takeProfitPct: 0,
    trailingStopPct,
  });
  if (worstCase.reason && worstCase.triggerPrice !== null) {
    // 始値でストップ価格を飛び越えた場合は、トリガー価格ではなく
    // 実際に利用できる始値で約定させる(ギャップダウンを楽観視しない)。
    const gapPrice = candle.open <= worstCase.triggerPrice ? candle.open : worstCase.triggerPrice;
    return { reason: worstCase.reason, price: gapPrice };
  }

  // 高値側: stop_loss/trailing_stopは既に安値側で判定済みなので無効化し、take_profitだけ判定する
  const bestCase = resolveExitReason({
    entryPrice: pos.entryPrice,
    currentPrice: candle.high,
    highestPrice: pos.highestPrice,
    stopLossPct: Number.POSITIVE_INFINITY,
    takeProfitPct,
    trailingStopPct: null,
  });
  if (bestCase.reason && bestCase.triggerPrice !== null) {
    // 利確側も始値で利確ラインを飛び越えた場合は始値で約定する。
    const gapPrice = candle.open >= bestCase.triggerPrice ? candle.open : bestCase.triggerPrice;
    return { reason: bestCase.reason, price: gapPrice };
  }
  return null;
}

/** paperTradingEngine.closePosition()と同じ計算式でポジションを仮想決済する */
function closeSimPosition(
  pos: OpenSimPosition,
  triggerPrice: number,
  reason: TradeReason,
  closedAtMs: number
): BacktestTrade {
  const execPrice = executionPrice(triggerPrice, "sell");
  const proceeds = execPrice * pos.amount;
  const exitFee = feeOf(proceeds);
  const pnl = (execPrice - pos.entryPrice) * pos.amount - pos.entryFee - exitFee;

  return {
    side: "buy",
    entryPrice: pos.entryPrice,
    amount: pos.amount,
    openedAt: pos.openedAt,
    closedAt: closedAtMs,
    closePrice: execPrice,
    pnl,
    closeReason: reason,
    totalFeeJpy: pos.entryFee + exitFee,
  };
}

/** paperTradingEngine.openBuyPosition()と同じ計算式で仮想ポジションを建てる */
function openSimPosition(marketPrice: number, sizeJpy: number, openedAtMs: number): OpenSimPosition {
  const execPrice = executionPrice(marketPrice, "buy");
  const amount = sizeJpy / execPrice;
  const cost = execPrice * amount;
  const entryFee = feeOf(cost);
  return { entryPrice: execPrice, amount, entryFee, openedAt: openedAtMs, highestPrice: execPrice };
}

export function runBacktest(request: BacktestRequest, candlesOverride?: CandleBucket[]): BacktestSummary {
  const warnings: string[] = [];
  const period = request.period ?? "loaded";
  if (request.graph.nodes.some((n) => n.type === "ai_judgment")) {
    warnings.push(
      "このグラフには AI Judgment ノードが含まれています。過去のAI判断ログは保存されていないため再現できず、" +
        "バックテストでは常に不成立(発火しない)として扱われます。実際にDeployした場合の結果とは異なります。"
    );
  }

  const candles = candlesOverride ?? getCandlesForTimeframe(request.pair, request.timeframe);
  const candleCount = candles.length;
  if (candleCount < 2) {
    warnings.push("ローソク足データが不足しているため、バックテストを実行できませんでした(最低2本必要)。");
    return emptySummary(candleCount, warnings, period, candles, request.initialBalanceJpy);
  }

  const positionSizeJpy = Math.min(
    request.positionSizeJpy ?? config.risk.maxPositionJpy,
    config.risk.maxPositionJpy
  );
  const maxOpenPositions = request.maxOpenPositions ?? config.risk.maxOpenPositions;
  const stopLossPct = request.stopLossPct ?? null;
  const takeProfitPct = request.takeProfitPct ?? null;
  const trailingStopPct = request.trailingStopPct ?? null;
  const executionMode: BacktestExecutionMode = request.executionMode ?? "legacy_intrabar";

  const openPositions: OpenSimPosition[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: PnlCurvePoint[] = [];
  const liquidationEquityCurve: PnlCurvePoint[] = [];
  const initialBalanceJpy = Math.max(0, request.initialBalanceJpy ?? 1_000_000);
  let cashJpy = initialBalanceJpy;
  let realizedPnl = 0;
  let winCount = 0;
  let lossCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalFeesJpy = 0;
  let grossPnlJpy = 0;
  let feeLossCount = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let liquidationPeak = initialBalanceJpy;
  let liquidationMaxDrawdown = 0;
  let liquidationPeakForPct = initialBalanceJpy;
  const seenErrors = new Set<string>();
  let pendingBuy = false;
  let pendingSell = false;

  function recordClose(trade: BacktestTrade) {
    trades.push(trade);
    realizedPnl += trade.pnl;
    totalFeesJpy += trade.totalFeeJpy;
    const grossPnl = trade.pnl + trade.totalFeeJpy;
    grossPnlJpy += grossPnl;
    if (grossPnl > 0 && trade.pnl <= 0) {
      feeLossCount += 1;
    }
    if (trade.pnl >= 0) {
      winCount += 1;
      grossProfit += trade.pnl;
    } else {
      lossCount += 1;
      grossLoss += -trade.pnl;
    }
    const time = Math.floor(trade.closedAt / 1000);
    const last = equityCurve[equityCurve.length - 1];
    if (last && last.time === time) {
      last.value = realizedPnl;
    } else {
      equityCurve.push({ time, value: realizedPnl });
    }
    peak = Math.max(peak, realizedPnl);
    maxDrawdown = Math.max(maxDrawdown, peak - realizedPnl);
  }

  function markLiquidationEquity(candle: CandleBucket) {
    let equity = cashJpy;
    for (const pos of openPositions) {
      const sellPrice = executionPrice(candle.close, "sell");
      equity += sellPrice * pos.amount - feeOf(sellPrice * pos.amount);
    }
    const time = Math.floor(candle.time);
    liquidationEquityCurve.push({ time, value: equity });
    liquidationPeak = Math.max(liquidationPeak, equity);
    liquidationMaxDrawdown = Math.max(liquidationMaxDrawdown, liquidationPeak - equity);
    liquidationPeakForPct = Math.max(liquidationPeakForPct, equity);
  }

  const closes: number[] = [];
  const volumes: number[] = [];
  const timestamps: number[] = [];
  for (const candle of candles) {
    closes.push(candle.close);
    volumes.push(candle.volume);
    timestamps.push(candle.time);

    // 1) 出口条件(SL/TP/トレーリング)の判定を先に行う(botEngine.onTickと同様、checkExits相当を先に評価する)
    for (let i = openPositions.length - 1; i >= 0; i -= 1) {
      const pos = openPositions[i];
      const exit = checkPositionExit(pos, candle, stopLossPct, takeProfitPct, trailingStopPct);
      if (!exit) continue;
      openPositions.splice(i, 1);
      const trade = closeSimPosition(pos, exit.price, exit.reason, candle.time * 1000);
      cashJpy += trade.closePrice * trade.amount - feeOf(trade.closePrice * trade.amount);
      recordClose(trade);
    }

    if (closes.length < 2) {
      markLiquidationEquity(candle);
      continue;
    }

    // 確定足シグナルを次足始値で執行するモード。保護決済はこの待ち行列より先に処理する。
    if (executionMode === "closed_bar_next_tick") {
      if (pendingSell) {
        const pos = openPositions.shift();
        if (pos) {
          const trade = closeSimPosition(pos, candle.open, "bot_strategy", candle.time * 1000);
          cashJpy += trade.closePrice * trade.amount - feeOf(trade.closePrice * trade.amount);
          recordClose(trade);
        }
      } else if (pendingBuy && openPositions.length < maxOpenPositions) {
        const pos = openSimPosition(candle.open, positionSizeJpy, candle.time * 1000);
        const totalEntryCost = pos.entryPrice * pos.amount + pos.entryFee;
        if (cashJpy >= totalEntryCost) {
          cashJpy -= totalEntryCost;
          openPositions.push(pos);
        }
      }
      pendingBuy = false;
      pendingSell = false;
    }

    const evaluation = evaluateGraph(request.graph, closes, {
      hasOpenPosition: openPositions.length > 0,
      aiJudgment: null,
      volumes,
      timestamps,
    });

    if (evaluation.errors.length > 0) {
      for (const err of evaluation.errors) seenErrors.add(err);
      markLiquidationEquity(candle);
      continue;
    }

    const shouldSell = evaluation.sell.current && !evaluation.sell.previous;
    const shouldBuy = evaluation.buy.current && !evaluation.buy.previous;

    // buy/sellが同時成立した場合はbotEngineと同様、安全側に倒して売りのみ実行する
    if (executionMode === "closed_bar_next_tick") {
      pendingSell = shouldSell;
      pendingBuy = !shouldSell && shouldBuy;
    } else if (shouldSell) {
      const pos = openPositions.shift();
      if (pos) {
        const trade = closeSimPosition(pos, candle.close, "bot_strategy", candle.time * 1000);
        cashJpy += trade.closePrice * trade.amount - feeOf(trade.closePrice * trade.amount);
        recordClose(trade);
      }
    } else if (shouldBuy && openPositions.length < maxOpenPositions) {
      const pos = openSimPosition(candle.close, positionSizeJpy, candle.time * 1000);
      const entryNotional = pos.entryPrice * pos.amount;
      const totalEntryCost = entryNotional + pos.entryFee;
      if (cashJpy >= totalEntryCost) {
        cashJpy -= totalEntryCost;
        openPositions.push(pos);
      }
    }

    markLiquidationEquity(candle);
  }

  if (seenErrors.size > 0) {
    warnings.push(`グラフの評価中にエラーが発生した区間があります: ${[...seenErrors].join(" / ")}`);
  }

  const lastCandle = candles[candles.length - 1];
  let unrealizedPnl = 0;
  if (lastCandle) {
    const exitPrice = executionPrice(lastCandle.close, "sell");
    for (const pos of openPositions) {
      const exitFee = feeOf(exitPrice * pos.amount);
      unrealizedPnl += (exitPrice - pos.entryPrice) * pos.amount - pos.entryFee - exitFee;
    }
  }
  const endingEquityJpy = initialBalanceJpy + realizedPnl + unrealizedPnl;

  return {
    candleCount,
    warnings,
    realizedPnl,
    winCount,
    lossCount,
    winRate: winCount + lossCount > 0 ? winCount / (winCount + lossCount) : null,
    avgWin: winCount > 0 ? grossProfit / winCount : null,
    avgLoss: lossCount > 0 ? -(grossLoss / lossCount) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    // 既存のmaxDrawdownは、UI/ウォークフォワードが参照する主要指標として
    // 含み損益込みの清算価値ベースに更新する。実現損益だけの値は内部集計に残す。
    maxDrawdown: liquidationMaxDrawdown,
    liquidationMaxDrawdown,
    liquidationMaxDrawdownPct:
      liquidationPeakForPct > 0 ? liquidationMaxDrawdown / liquidationPeakForPct : null,
    unrealizedPnl,
    endingEquityJpy,
    totalFeesJpy,
    grossPnlJpy,
    feeLossCount,
    equityCurve,
    liquidationEquityCurve,
    trades,
    period,
    dataStartAt: candles[0]?.time,
    dataEndAt: candles[candles.length - 1]?.time,
  };
}
