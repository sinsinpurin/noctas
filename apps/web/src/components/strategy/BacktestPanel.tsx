"use client";

import { useCallback, useState } from "react";
import { Box, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import type {
  BacktestPeriod,
  BacktestExecutionMode,
  BacktestRequest,
  BacktestSummary,
  CandleTimeframe,
  Pair,
  StrategyGraph,
  WalkForwardBatchResponse,
} from "@noctas/shared";
import { CyberButton } from "@/components/ui/CyberButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EquityCurveChart } from "@/components/pnl/EquityCurveChart";
import { formatDateTime, formatJpy, formatSignedJpy, pnlColor } from "@/components/pnl/format";
import {
  applyWalkForwardParams,
  runBacktest,
  runWalkForwardValidation,
  type WalkForwardRecommendedParams,
} from "@/lib/strategyApi";
import { riskFormToInput, type RiskFormValues } from "@/components/strategy/RiskSettingsPanel";

interface BacktestPanelProps {
  graph: StrategyGraph;
  pair: Pair;
  timeframe: CandleTimeframe;
  riskForm: RiskFormValues;
  maxPositionJpy: number;
  /** 推奨値の適用が成功した戦略ID(WalkForwardSection内)を通知する。呼び出し元はリスト再取得・riskForm再同期に使う */
  onStrategyRiskApplied?: (strategyId: string) => void;
}

interface TileProps {
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
}

function Tile({ label, value, valueColor = "#F2F2F5", sub }: TileProps) {
  return (
    <Box bg="bg.surfaceRaised" borderWidth="1px" borderColor="border.grid" px={4} py={3}>
      <Text
        fontFamily="heading"
        fontSize="10px"
        fontWeight="600"
        letterSpacing="0.16em"
        textTransform="uppercase"
        color="text.secondary"
      >
        {label}
      </Text>
      <Text fontFamily="mono" fontSize="xl" fontWeight="600" color={valueColor} mt={1} lineHeight="1.2">
        {value}
      </Text>
      {sub && (
        <Text fontFamily="mono" fontSize="11px" color="text.disabled" mt={1}>
          {sub}
        </Text>
      )}
    </Box>
  );
}

const REASON_LABEL: Record<string, string> = {
  stop_loss: "損切り",
  take_profit: "利確",
  trailing_stop: "トレーリング",
  bot_strategy: "BOT戦略",
};

/**
 * Bot Blueprintのキャンバス(保存前でも可)を、サーバーが保持している過去ローソク足履歴で
 * ウォークフォワード再生する読み取り専用バックテストパネル。DBへの書き込みは発生しない。
 */
export function BacktestPanel({
  graph,
  pair,
  timeframe,
  riskForm,
  maxPositionJpy,
  onStrategyRiskApplied,
}: BacktestPanelProps) {
  const [loading, setLoading] = useState(false);
  const [runningPeriod, setRunningPeriod] = useState<BacktestPeriod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [executionMode, setExecutionMode] = useState<BacktestExecutionMode>("closed_bar_next_tick");
  const [costScenario, setCostScenario] = useState<"standard" | "stressed">("standard");

  const handleRun = useCallback(async (period: BacktestPeriod) => {
    setError(null);
    const hasAction = graph.nodes.some((n) => n.type === "buy" || n.type === "sell");
    if (!hasAction) {
      setError("Buy / Sell ノードを最低1つ配置してください");
      return;
    }
    const risk = riskFormToInput(riskForm, maxPositionJpy);
    if (!risk.ok) {
      setError(risk.error);
      return;
    }
    setLoading(true);
    setRunningPeriod(period);
    try {
      const request: BacktestRequest = {
        graph,
        pair,
        timeframe,
        period,
        executionMode,
        costProfile:
          costScenario === "stressed"
            ? { feePct: 0.24, slippagePct: 0.04, label: "stressed_2x" }
            : { feePct: 0.12, slippagePct: 0.02, label: "standard" },
        ...risk.value,
      };
      const result = await runBacktest(request);
      setSummary(result);
    } catch (err) {
      setSummary(null);
      setError(err instanceof Error ? err.message : "バックテストの実行に失敗しました");
    } finally {
      setLoading(false);
      setRunningPeriod(null);
    }
  }, [graph, pair, timeframe, riskForm, maxPositionJpy, executionMode, costScenario]);

  return (
    <Stack gap={4}>
      <Stack direction="row" gap={3} align="center" flexWrap="wrap">
        <Box as="label" display="flex" alignItems="center" gap={2} fontFamily="mono" fontSize="11px" color="text.secondary">
          執行方式
          <select
            value={executionMode}
            onChange={(event) => setExecutionMode(event.target.value as BacktestExecutionMode)}
            style={{ background: "#1c1c24", color: "#f2f2f5", border: "1px solid rgba(255, 0, 60, 0.35)", padding: "6px 8px" }}
          >
            <option value="closed_bar_next_tick">確定足 → 次足始値</option>
            <option value="legacy_intrabar">従来方式（同足）</option>
          </select>
        </Box>
        <Box as="label" display="flex" alignItems="center" gap={2} fontFamily="mono" fontSize="11px" color="text.secondary">
          コスト
          <select
            value={costScenario}
            onChange={(event) => setCostScenario(event.target.value as "standard" | "stressed")}
            style={{ background: "#1c1c24", color: "#f2f2f5", border: "1px solid rgba(255, 0, 60, 0.35)", padding: "6px 8px" }}
          >
            <option value="standard">標準コスト</option>
            <option value="stressed">悪化想定（2倍）</option>
          </select>
        </Box>
        <CyberButton variant="primary" onClick={() => handleRun("loaded")} disabled={loading}>
          {loading && runningPeriod === "loaded" ? "Running..." : "Run Backtest"}
        </CyberButton>
        <CyberButton variant="secondary" onClick={() => handleRun("three_months")} disabled={loading}>
          {loading && runningPeriod === "three_months" ? "Loading 3 months..." : "Run 3-Month Simulation"}
        </CyberButton>
        <Text fontFamily="mono" fontSize="10px" color="text.disabled">
          {executionMode === "closed_bar_next_tick"
            ? "確定足で判断し、次足の始値で執行します。"
            : "既存互換の同足終値で執行します。"} 3-month simulation reads the rolling 90-day DB snapshot.
        </Text>
      </Stack>

      {error && (
        <Text fontFamily="mono" fontSize="11px" color="signal.red">
          {error}
        </Text>
      )}

      {summary && summary.warnings.length > 0 && (
        <Stack gap={1} borderWidth="1px" borderColor="signal.orange" bg="bg.surfaceRaised" px={3} py={2}>
          {summary.warnings.map((warning, i) => (
            <Text key={i} fontFamily="mono" fontSize="11px" color="signal.orange">
              {"⚠ "}
              {warning}
            </Text>
          ))}
        </Stack>
      )}

      {summary && (
        <Stack gap={4}>
          <SimpleGrid columns={2} gap={3}>
            <Tile
              label="Realized P&L"
              value={formatSignedJpy(summary.realizedPnl)}
              valueColor={pnlColor(summary.realizedPnl)}
              sub={`${summary.candleCount} candles / ${summary.period === "three_months" ? "latest 3 months" : "loaded history"}`}
            />
            <Tile
              label="Trades"
              value={String(summary.trades.length)}
              sub={`${summary.winCount}勝 / ${summary.lossCount}敗`}
            />
            <Tile
              label="Win Rate"
              value={summary.winRate === null ? "--" : `${(summary.winRate * 100).toFixed(1)}%`}
            />
            <Tile
              label="Profit Factor"
              value={summary.profitFactor === null ? "--" : summary.profitFactor.toFixed(2)}
            />
            <Tile label="Max Drawdown" value={formatJpy(summary.maxDrawdown)} />
            <Tile label="Fees Paid" value={formatJpy(summary.totalFeesJpy)} />
            <Tile
              label="値幅合計(手数料前)"
              value={formatSignedJpy(summary.grossPnlJpy)}
              valueColor={pnlColor(summary.grossPnlJpy)}
              sub="手数料を引く前の合計損益"
            />
            <Tile
              label="手数料負け"
              value={`${summary.feeLossCount}件`}
              valueColor={summary.feeLossCount > 0 ? "signal.orange" : "#F2F2F5"}
              sub="方向は合っていたが手数料で純損失"
            />
          </SimpleGrid>

          <EquityCurveChart points={summary.equityCurve} />

          {summary.trades.length > 0 && (
            <Box overflowX="auto">
              <Box minWidth="560px" maxHeight="240px" overflowY="auto">
                {summary.trades
                  .slice()
                  .reverse()
                  .map((trade, i) => (
                    <Stack
                      key={i}
                      direction="row"
                      gap={4}
                      px={3}
                      py={2}
                      bg="bg.surfaceRaised"
                      borderBottomWidth="1px"
                      borderBottomColor="bg.surface"
                      align="center"
                    >
                      <Text fontFamily="mono" fontSize="xs" color="text.secondary" minW="100px">
                        {formatDateTime(trade.closedAt)}
                      </Text>
                      <Text fontFamily="mono" fontSize="xs" color="text.primary" minW="90px">
                        {formatJpy(trade.entryPrice)} → {formatJpy(trade.closePrice)}
                      </Text>
                      <Text fontFamily="mono" fontSize="xs" color="text.secondary" minW="80px">
                        {REASON_LABEL[trade.closeReason] ?? trade.closeReason}
                      </Text>
                      <Text fontFamily="mono" fontSize="xs" color={pnlColor(trade.pnl)}>
                        {formatSignedJpy(trade.pnl)}
                      </Text>
                    </Stack>
                  ))}
              </Box>
            </Box>
          )}
        </Stack>
      )}

      <Box borderTopWidth="1px" borderColor="border.grid" pt={4}>
        <WalkForwardSection onStrategyRiskApplied={onStrategyRiskApplied} />
      </Box>
    </Stack>
  );
}

function formatPct(value: number | null): string {
  return value === null ? "--" : `${value}%`;
}

/**
 * 現在アクティブな全戦略(BacktestPanelが受け取るgraph/pair/timeframe propsとは無関係)の
 * SL/TP/トレーリングストップを、ローリング3ヶ月スナップショットに対して複数ウィンドウで
 * ウォークフォワード検証する読み取り専用セクション。戦略の保存済み設定は一切変更しない。
 */
function WalkForwardSection({
  onStrategyRiskApplied,
}: {
  onStrategyRiskApplied?: (strategyId: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WalkForwardBatchResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  // window.confirm()の代わりに使う非ブロッキングな確認ダイアログの保留状態(ConfirmDialogの
  // コメント参照)。ワンクリック適用が確認なしで行われないよう、必ずこのダイアログを経由する
  const [pendingApply, setPendingApply] = useState<{
    strategyId: string;
    strategyName: string;
    params: WalkForwardRecommendedParams;
  } | null>(null);

  const handleRun = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await runWalkForwardValidation();
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Walk-Forward Validationの実行に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApply = useCallback(
    async (strategyId: string, params: WalkForwardRecommendedParams) => {
      setPendingApply(null);
      setError(null);
      setApplyingId(strategyId);
      try {
        const updated = await applyWalkForwardParams(strategyId, params);
        setResult((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            results: prev.results.map((r) =>
              r.strategyId === strategyId
                ? {
                    ...r,
                    currentParams: {
                      stopLossPct: updated.stopLossPct,
                      takeProfitPct: updated.takeProfitPct,
                      trailingStopPct: updated.trailingStopPct,
                    },
                  }
                : r
            ),
          };
        });
        onStrategyRiskApplied?.(strategyId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "推奨値の適用に失敗しました");
      } finally {
        setApplyingId(null);
      }
    },
    [onStrategyRiskApplied]
  );

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <Text
          fontFamily="heading"
          fontSize="sm"
          fontWeight="700"
          letterSpacing="0.08em"
          textTransform="uppercase"
          color="text.primary"
        >
          Walk-Forward Validation
        </Text>
        <Text fontFamily="mono" fontSize="11px" color="text.secondary" lineHeight="1.7">
          現在アクティブな全戦略の損切り/利確/トレーリングストップを、90日分のローリングスナップショットを
          複数のin-sample(最適化用)/out-of-sample(検証用)ウィンドウに分けて検証します(過学習チェック)。
          戦略の保存済み設定は一切変更しません — あくまで参考情報の表示です。
        </Text>
      </Stack>

      <Stack direction="row" gap={3} align="center" flexWrap="wrap">
        <CyberButton variant="primary" onClick={handleRun} disabled={loading}>
          {loading ? "Running..." : "Run Walk-Forward Validation"}
        </CyberButton>
      </Stack>

      {error && (
        <Text fontFamily="mono" fontSize="11px" color="signal.red">
          {error}
        </Text>
      )}

      {result && result.warnings.length > 0 && (
        <Stack gap={1} borderWidth="1px" borderColor="signal.orange" bg="bg.surfaceRaised" px={3} py={2}>
          {result.warnings.map((warning, i) => (
            <Text key={i} fontFamily="mono" fontSize="11px" color="signal.orange">
              {"⚠ "}
              {warning}
            </Text>
          ))}
        </Stack>
      )}

      {result && result.results.length === 0 && result.activeStrategyCount === 0 && (
        <Text fontFamily="mono" fontSize="12px" color="text.secondary">
          現在アクティブな戦略がありません。
        </Text>
      )}

      {result &&
        result.results.map((r) => {
          const isOpen = expanded.has(r.strategyId);
          const agg = r.summary.aggregate;
          const recommended = r.summary.recommendedParams;
          const matchesCurrent =
            recommended !== null &&
            recommended.stopLossPct === r.currentParams.stopLossPct &&
            recommended.takeProfitPct === r.currentParams.takeProfitPct &&
            recommended.trailingStopPct === r.currentParams.trailingStopPct;
          const isApplying = applyingId === r.strategyId;
          return (
            <Box key={r.strategyId} borderWidth="1px" borderColor="border.grid" bg="bg.surfaceRaised" p={3}>
              <Stack gap={3}>
                <Stack direction="row" justify="space-between" align="flex-start" flexWrap="wrap" gap={3}>
                  <Stack gap={0.5}>
                    <Text fontFamily="heading" fontSize="13px" fontWeight="700" color="text.primary">
                      {r.strategyName}
                    </Text>
                    <Text fontFamily="mono" fontSize="11px" color="text.secondary">
                      {r.pair} / {r.timeframe} / {r.summary.windowCount}ウィンドウ
                    </Text>
                  </Stack>
                  <Stack direction="row" gap={4} align="flex-end" flexWrap="wrap">
                    <Stack gap={0.5} align="flex-end">
                      <Text
                        fontFamily="mono"
                        fontSize="10px"
                        color="text.disabled"
                        textTransform="uppercase"
                        letterSpacing="0.08em"
                      >
                        現在の設定 (SL/TP/TS)
                      </Text>
                      <Text fontFamily="mono" fontSize="12px" color="text.primary">
                        {formatPct(r.currentParams.stopLossPct)} / {formatPct(r.currentParams.takeProfitPct)} /{" "}
                        {formatPct(r.currentParams.trailingStopPct)}
                      </Text>
                    </Stack>
                    <Stack gap={0.5} align="flex-end">
                      <Text
                        fontFamily="mono"
                        fontSize="10px"
                        color="text.disabled"
                        textTransform="uppercase"
                        letterSpacing="0.08em"
                      >
                        推奨値 (Recommended)
                      </Text>
                      <Text fontFamily="mono" fontSize="12px" color="signal.cyan">
                        {recommended === null
                          ? "--"
                          : `${formatPct(recommended.stopLossPct)} / ${formatPct(recommended.takeProfitPct)} / ${formatPct(recommended.trailingStopPct)}`}
                      </Text>
                      <CyberButton
                        variant="primary"
                        size="sm"
                        disabled={recommended === null || matchesCurrent || isApplying}
                        onClick={() =>
                          recommended &&
                          setPendingApply({ strategyId: r.strategyId, strategyName: r.strategyName, params: recommended })
                        }
                      >
                        {isApplying ? "Applying..." : "推奨値を適用"}
                      </CyberButton>
                    </Stack>
                  </Stack>
                </Stack>

                {r.summary.warnings.length > 0 && (
                  <Stack gap={1}>
                    {r.summary.warnings.map((w, i) => (
                      <Text key={i} fontFamily="mono" fontSize="10px" color="signal.orange">
                        {"⚠ "}
                        {w}
                      </Text>
                    ))}
                  </Stack>
                )}

                <SimpleGrid columns={{ base: 2, md: 5 }} gap={2}>
                  <Tile
                    label="OOS Realized P&L"
                    value={formatSignedJpy(agg.outOfSampleRealizedPnl)}
                    valueColor={pnlColor(agg.outOfSampleRealizedPnl)}
                  />
                  <Tile
                    label="OOS Win Rate"
                    value={agg.outOfSampleWinRate === null ? "--" : `${(agg.outOfSampleWinRate * 100).toFixed(1)}%`}
                  />
                  <Tile
                    label="OOS Profit Factor"
                    value={agg.outOfSampleProfitFactor === null ? "--" : agg.outOfSampleProfitFactor.toFixed(2)}
                  />
                  <Tile label="OOS Max Drawdown" value={formatJpy(agg.outOfSampleMaxDrawdown)} />
                  <Tile
                    label="Consistency"
                    value={agg.consistencyRatio === null ? "--" : `${(agg.consistencyRatio * 100).toFixed(0)}%`}
                    sub={`${agg.outOfSampleTrades}件のOOSトレード`}
                  />
                </SimpleGrid>

                <CyberButton
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(r.strategyId)}
                  alignSelf="flex-start"
                >
                  {isOpen ? "Hide windows ▲" : `Show ${r.summary.windowCount} windows ▼`}
                </CyberButton>

                {isOpen && (
                  <Box overflowX="auto">
                    <Box minWidth="680px" maxHeight="260px" overflowY="auto">
                      {r.summary.windows.map((w) => (
                        <Stack
                          key={w.windowIndex}
                          direction="row"
                          gap={4}
                          px={3}
                          py={2}
                          bg="bg.surface"
                          borderBottomWidth="1px"
                          borderBottomColor="border.grid"
                          align="center"
                          flexWrap="wrap"
                        >
                          <Text fontFamily="mono" fontSize="10px" color="text.disabled" minW="30px">
                            #{w.windowIndex}
                          </Text>
                          <Text fontFamily="mono" fontSize="10px" color="text.secondary" minW="180px">
                            IS {formatDateTime(w.inSampleStart)} → {formatDateTime(w.inSampleEnd)}
                          </Text>
                          <Text fontFamily="mono" fontSize="10px" color="text.secondary" minW="180px">
                            OOS {formatDateTime(w.outOfSampleStart)} → {formatDateTime(w.outOfSampleEnd)}
                          </Text>
                          <Text fontFamily="mono" fontSize="10px" color="text.primary" minW="170px">
                            SL {formatPct(w.bestParams.stopLossPct)} / TP {formatPct(w.bestParams.takeProfitPct)} / TS{" "}
                            {formatPct(w.bestParams.trailingStopPct)}
                          </Text>
                          <Text fontFamily="mono" fontSize="10px" color="text.secondary" minW="100px">
                            IS {formatSignedJpy(w.inSample.realizedPnl)}
                          </Text>
                          <Text fontFamily="mono" fontSize="10px" color={pnlColor(w.outOfSample.realizedPnl)} minW="100px">
                            OOS {formatSignedJpy(w.outOfSample.realizedPnl)}
                          </Text>
                        </Stack>
                      ))}
                    </Box>
                  </Box>
                )}
              </Stack>
            </Box>
          );
        })}

      <ConfirmDialog
        open={pendingApply !== null}
        title="推奨値を適用"
        description={
          pendingApply
            ? `戦略 "${pendingApply.strategyName}" のライブリスク設定を、推奨値` +
              `(SL ${formatPct(pendingApply.params.stopLossPct)} / TP ${formatPct(pendingApply.params.takeProfitPct)} / ` +
              `TS ${formatPct(pendingApply.params.trailingStopPct)})に即座に置き換えます。` +
              `この戦略が稼働中の場合、次のtickから新しい設定で取引されます` +
              `(すでにオープン中のポジションの損切り/利確/トレーリング設定は変更されません)。`
            : ""
        }
        confirmLabel="適用する"
        tone="cyan"
        onConfirm={() => pendingApply && handleApply(pendingApply.strategyId, pendingApply.params)}
        onCancel={() => setPendingApply(null)}
      />
    </Stack>
  );
}
