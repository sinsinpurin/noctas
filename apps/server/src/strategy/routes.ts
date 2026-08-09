import type { FastifyInstance } from "fastify";
import type { Strategy as PrismaStrategy } from "@prisma/client";
import {
  DEFAULT_CANDLE_TIMEFRAME,
  isCandleTimeframe,
  minutesOfTimeframe,
  parseGraph,
  type BacktestRequest,
  type CandleTimeframe,
  type Strategy,
  type StrategyGraph,
  type WalkForwardBatchResponse,
  type WalkForwardStrategyResult,
} from "@noctas/shared";
import { prisma } from "../db/prisma";
import { aggregateCandles, reloadActiveStrategies, type CandleBucket } from "./botEngine";
import { getHistoricalCandles } from "./historicalCandleStore";
import { runBacktest, THREE_MONTH_BACKTEST_MAX_CANDLES } from "./backtestEngine";
import { maxWindowsForBatch, runWalkForwardForStrategy } from "./walkForwardEngine";
import { broadcast } from "../ws/relay";
import { generateStrategyFromPrompt } from "../ai/strategyGenerator";
import { getAnthropicApiKey } from "../ai/anthropicClient";
import { config } from "../config";

function toStrategyDto(row: PrismaStrategy): Strategy {
  return {
    id: row.id,
    name: row.name,
    pair: row.pair,
    timeframe: isCandleTimeframe(row.timeframe) ? row.timeframe : DEFAULT_CANDLE_TIMEFRAME,
    description: row.description,
    graph: parseGraph(row.graph) ?? { nodes: [], edges: [] },
    isActive: row.isActive,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    positionSizeJpy: row.positionSizeJpy,
    maxOpenPositions: row.maxOpenPositions,
    stopLossPct: row.stopLossPct,
    takeProfitPct: row.takeProfitPct,
    trailingStopPct: row.trailingStopPct,
  };
}

export interface StrategyBody {
  name?: string;
  pair?: string;
  timeframe?: CandleTimeframe;
  description?: string;
  graph?: StrategyGraph;
  isActive?: boolean;
  // リスク設定(nullでグローバル設定へ戻す)
  positionSizeJpy?: number | null;
  maxOpenPositions?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  trailingStopPct?: number | null;
}

/** リスク設定の妥当性を検証し、エラーメッセージまたはnullを返す */
export function validateRiskSettings(body: StrategyBody): string | null {
  const positives: [string, number | null | undefined][] = [
    ["positionSizeJpy", body.positionSizeJpy],
    ["stopLossPct", body.stopLossPct],
    ["trailingStopPct", body.trailingStopPct],
  ];
  for (const [key, value] of positives) {
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0)) {
      return `${key} は正の数値またはnullで指定してください`;
    }
  }
  // takeProfitPctだけは0を「利確を使わない(トレーリング/損切りのみで運用)」の明示指定として許容する
  if (
    body.takeProfitPct !== undefined &&
    body.takeProfitPct !== null &&
    (!Number.isFinite(body.takeProfitPct) || body.takeProfitPct < 0)
  ) {
    return "利確%は0以上の数値またはnullで指定してください(0は利確なしの指定)";
  }
  // 投入額の上限はAI_MAX_POSITION_JPY(config.risk.maxPositionJpy)。戦略ごとの上書きは
  // この上限を超えられない(超えて設定したい場合は環境変数側を上げる必要がある)
  if (
    body.positionSizeJpy !== undefined &&
    body.positionSizeJpy !== null &&
    body.positionSizeJpy > config.risk.maxPositionJpy
  ) {
    return `positionSizeJpy は上限(AI_MAX_POSITION_JPY = ¥${config.risk.maxPositionJpy.toLocaleString("ja-JP")})以下で指定してください`;
  }
  // 往復の手数料+スリッページ分に対する安全マージンを割る利確ラインは受け付けない
  // (0は利確なしの明示指定なので対象外)
  if (
    body.takeProfitPct !== undefined &&
    body.takeProfitPct !== null &&
    body.takeProfitPct !== 0 &&
    body.takeProfitPct < config.fees.roundTripCostPct
  ) {
    return `利確%は往復コスト(手数料+スリッページ = ${config.fees.roundTripCostPct}%)に対する安全マージンを下回っています。この値以上か、利確なしを意味する0で指定してください`;
  }
  if (
    body.maxOpenPositions !== undefined &&
    body.maxOpenPositions !== null &&
    (!Number.isInteger(body.maxOpenPositions) || body.maxOpenPositions < 1)
  ) {
    return "maxOpenPositions は1以上の整数またはnullで指定してください";
  }
  return null;
}

/** bodyに含まれるリスク設定フィールドだけをPrismaのdataへ写す */
function riskSettingsData(body: StrategyBody) {
  return {
    ...(body.positionSizeJpy !== undefined ? { positionSizeJpy: body.positionSizeJpy } : {}),
    ...(body.maxOpenPositions !== undefined ? { maxOpenPositions: body.maxOpenPositions } : {}),
    ...(body.stopLossPct !== undefined ? { stopLossPct: body.stopLossPct } : {}),
    ...(body.takeProfitPct !== undefined ? { takeProfitPct: body.takeProfitPct } : {}),
    ...(body.trailingStopPct !== undefined ? { trailingStopPct: body.trailingStopPct } : {}),
  };
}

function isValidPair(pair: string): boolean {
  return config.targetPairs.includes(pair);
}

// P&L ReportのAI Reviewから引き継ぐ取引レビュー本文の上限文字数(プロンプト肥大化防止)
const MAX_REVIEW_CONTEXT_LENGTH = 4000;

function validateGraph(graph: unknown): graph is StrategyGraph {
  if (!graph || typeof graph !== "object") return false;
  const g = graph as StrategyGraph;
  return Array.isArray(g.nodes) && Array.isArray(g.edges);
}

export async function strategyRoutes(app: FastifyInstance) {
  app.get("/api/strategies", async () => {
    const rows = await prisma.strategy.findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map(toStrategyDto);
  });

  // 自由文の要望からAIで戦略グラフを生成する(保存はしない — エディタで確認・調整後にSave)
  // reviewContextはP&L ReportのAI Review結果から引き継がれた参考テキスト(任意)
  app.post<{ Body: { prompt?: string; pair?: string; reviewContext?: string; timeframe?: string } }>(
    "/api/strategies/generate",
    async (request, reply) => {
      const prompt = request.body?.prompt?.trim();
      const pair = request.body?.pair ?? config.targetPair;
      const reviewContext = request.body?.reviewContext?.trim() || undefined;
      const timeframe = request.body?.timeframe ?? DEFAULT_CANDLE_TIMEFRAME;
      if (!prompt) {
        return reply.status(400).send({ error: "prompt は必須です" });
      }
      if (!isValidPair(pair)) {
        return reply.status(400).send({ error: `未対応のペアです: ${pair}` });
      }
      if (!isCandleTimeframe(timeframe)) {
        return reply.status(400).send({ error: `未対応の時間足です: ${timeframe}` });
      }
      if (prompt.length > 1000) {
        return reply.status(400).send({ error: "prompt は1000文字以内で入力してください" });
      }
      if (reviewContext && reviewContext.length > MAX_REVIEW_CONTEXT_LENGTH) {
        return reply
          .status(400)
          .send({ error: `reviewContext は${MAX_REVIEW_CONTEXT_LENGTH}文字以内で指定してください` });
      }
      if (!getAnthropicApiKey()) {
        return reply.status(503).send({
          error:
            "Anthropic APIキーが設定されていないため、AI生成は利用できません。Settings画面から設定してください",
        });
      }

      try {
        return await generateStrategyFromPrompt(prompt, pair, reviewContext, timeframe);
      } catch (err) {
        request.log.error(err, "戦略グラフのAI生成に失敗しました");
        return reply.status(502).send({
          error: err instanceof Error ? err.message : "戦略グラフの生成に失敗しました",
        });
      }
    }
  );

  // 保存前(未保存でも可)のグラフを、サーバーが保持している過去ローソク足履歴に対して
  // ウォークフォワードで再生する読み取り専用のバックテスト。DBへの書き込みは一切行わない
  app.post<{ Body: BacktestRequest }>("/api/strategies/backtest", async (request, reply) => {
    const { graph, pair, timeframe, period = "loaded" } = request.body ?? ({} as BacktestRequest);
    if (!validateGraph(graph)) {
      return reply.status(400).send({ error: "graph (nodes/edges) は必須です" });
    }
    if (!pair || !isValidPair(pair)) {
      return reply.status(400).send({ error: `未対応のペアです: ${pair}` });
    }
    if (!timeframe || !isCandleTimeframe(timeframe)) {
      return reply.status(400).send({ error: `未対応の時間足です: ${timeframe}` });
    }
    if (period !== "loaded" && period !== "three_months") {
      return reply.status(400).send({ error: `unsupported backtest period: ${period}` });
    }
    const riskError = validateRiskSettings(request.body ?? {});
    if (riskError) {
      return reply.status(400).send({ error: riskError });
    }

    try {
      const candlesOverride =
        period === "three_months"
          ? aggregateCandles(await getHistoricalCandles(pair), minutesOfTimeframe(timeframe))
          : undefined;
      if (period === "three_months" && candlesOverride && candlesOverride.length > THREE_MONTH_BACKTEST_MAX_CANDLES) {
        return reply.status(400).send({
          error: `3ヶ月シミュレーションはこの時間足(${timeframe})だと${candlesOverride.length}本のローソク足を評価する必要があり、計算量(runBacktestの特性上O(n²))的にサーバー全体を長時間ブロックしてしまうため実行できません。5分足以上の粗い時間足を選択して再実行してください。`,
        });
      }
      if (period === "three_months" && (!candlesOverride || candlesOverride.length < 2)) {
        return reply.status(503).send({ error: "3-month candle snapshot is not ready yet; please retry after the next sync" });
      }
      return runBacktest({ ...request.body, graph, pair, timeframe, period }, candlesOverride);
    } catch (err) {
      request.log.error(err, "バックテストの実行に失敗しました");
      return reply.status(500).send({
        error: err instanceof Error ? err.message : "バックテストの実行に失敗しました",
      });
    }
  });

  // 現在アクティブな全戦略のSL/TP/トレーリングを、ローリング3ヶ月スナップショットに対して
  // ウォークフォワード検証する読み取り専用エンドポイント。戦略の保存済み設定は一切変更しない。
  app.post("/api/strategies/walk-forward", async (request, reply) => {
    const rows = await prisma.strategy.findMany({ where: { isActive: true } });
    if (rows.length === 0) {
      const body: WalkForwardBatchResponse = {
        generatedAt: Date.now(),
        activeStrategyCount: 0,
        results: [],
        warnings: ["現在アクティブな戦略がありません。"],
      };
      return body;
    }

    const warnings: string[] = [];
    const maxWindows = maxWindowsForBatch(rows.length);
    // ペア単位の生の1分足スナップショットと、pair+timeframe単位の集計結果を
    // このリクエスト内でキャッシュし、同じ組み合わせを複数戦略が使っていても再取得・再集計しない
    const rawCandleCache = new Map<string, Promise<CandleBucket[]>>();
    const aggregatedCache = new Map<string, CandleBucket[]>();
    const results: WalkForwardStrategyResult[] = [];

    for (const row of rows) {
      const graph = parseGraph(row.graph);
      if (!graph) {
        warnings.push(`戦略 "${row.name}" のグラフをパースできないためスキップしました。`);
        continue;
      }
      if (!isValidPair(row.pair)) {
        warnings.push(`戦略 "${row.name}" のペア ${row.pair} は対象外のためスキップしました。`);
        continue;
      }
      if (!isCandleTimeframe(row.timeframe)) {
        warnings.push(`戦略 "${row.name}" の時間足 ${row.timeframe} は不正なためスキップしました。`);
        continue;
      }
      const timeframe = row.timeframe;

      try {
        let rawPromise = rawCandleCache.get(row.pair);
        if (!rawPromise) {
          rawPromise = getHistoricalCandles(row.pair);
          rawCandleCache.set(row.pair, rawPromise);
        }
        const raw = await rawPromise;

        const key = `${row.pair}|${timeframe}`;
        let candles = aggregatedCache.get(key);
        if (!candles) {
          candles = aggregateCandles(raw, minutesOfTimeframe(timeframe));
          aggregatedCache.set(key, candles);
        }

        const positionSizeJpy = Math.min(
          row.positionSizeJpy ?? config.risk.maxPositionJpy,
          config.risk.maxPositionJpy
        );
        const maxOpenPositions = row.maxOpenPositions ?? config.risk.maxOpenPositions;

        const summary = runWalkForwardForStrategy(
          graph,
          row.pair,
          timeframe,
          positionSizeJpy,
          maxOpenPositions,
          candles,
          maxWindows
        );

        if (summary.windowCount === 0) {
          warnings.push(
            `戦略 "${row.name}" (${row.pair} / ${timeframe}) はローソク足スナップショットが不足しているため検証をスキップしました。`
          );
          continue;
        }

        results.push({
          strategyId: row.id,
          strategyName: row.name,
          pair: row.pair,
          timeframe,
          currentParams: {
            stopLossPct: row.stopLossPct,
            takeProfitPct: row.takeProfitPct,
            trailingStopPct: row.trailingStopPct,
          },
          summary,
        });
      } catch (err) {
        request.log.error(err, `戦略 "${row.name}" のウォークフォワード検証に失敗しました`);
        warnings.push(`戦略 "${row.name}" のウォークフォワード検証中にエラーが発生しました。`);
      }
    }

    const body: WalkForwardBatchResponse = {
      generatedAt: Date.now(),
      activeStrategyCount: rows.length,
      results,
      warnings,
    };
    return body;
  });

  app.post<{ Body: StrategyBody }>("/api/strategies", async (request, reply) => {
    const { name, pair, timeframe, description, graph } = request.body ?? {};
    if (!name || !validateGraph(graph)) {
      return reply.status(400).send({ error: "name と graph (nodes/edges) は必須です" });
    }
    if (pair !== undefined && !isValidPair(pair)) {
      return reply.status(400).send({ error: `未対応のペアです: ${pair}` });
    }
    if (timeframe !== undefined && !isCandleTimeframe(timeframe)) {
      return reply.status(400).send({ error: `未対応の時間足です: ${timeframe}` });
    }
    const riskError = validateRiskSettings(request.body ?? {});
    if (riskError) {
      return reply.status(400).send({ error: riskError });
    }

    const row = await prisma.strategy.create({
      data: {
        name,
        pair: pair ?? config.targetPair,
        timeframe: timeframe ?? DEFAULT_CANDLE_TIMEFRAME,
        description: description ?? "",
        graph: JSON.stringify(graph),
        ...riskSettingsData(request.body ?? {}),
      },
    });

    const dto = toStrategyDto(row);
    broadcast({ type: "strategy_update", payload: dto });
    return dto;
  });

  app.put<{ Params: { id: string }; Body: StrategyBody }>(
    "/api/strategies/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { name, pair, timeframe, description, graph, isActive } = request.body ?? {};

      if (graph !== undefined && !validateGraph(graph)) {
        return reply.status(400).send({ error: "graph の形式が不正です" });
      }
      if (pair !== undefined && !isValidPair(pair)) {
        return reply.status(400).send({ error: `未対応のペアです: ${pair}` });
      }
      if (timeframe !== undefined && !isCandleTimeframe(timeframe)) {
        return reply.status(400).send({ error: `未対応の時間足です: ${timeframe}` });
      }
      const riskError = validateRiskSettings(request.body ?? {});
      if (riskError) {
        return reply.status(400).send({ error: riskError });
      }

      const existing = await prisma.strategy.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ error: "指定された戦略が見つかりません" });
      }

      const row = await prisma.strategy.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(pair !== undefined ? { pair } : {}),
          ...(timeframe !== undefined ? { timeframe } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(graph !== undefined ? { graph: JSON.stringify(graph) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...riskSettingsData(request.body ?? {}),
        },
      });

      await reloadActiveStrategies();
      const dto = toStrategyDto(row);
      broadcast({ type: "strategy_update", payload: dto });
      return dto;
    }
  );

  // ウォークフォワード検証結果のrecommendedParamsを戦略のライブリスク設定へ反映する。
  // 稼働中戦略のstopLossPct/takeProfitPct/trailingStopPctはbotEngine/paperTradingEngineが
  // 毎tick参照するため、適用は即座に効く(オープン済みPositionのSL/TP/TSスナップショットは対象外)。
  // クライアントから来た数値をそのまま信頼せず、PUT /api/strategies/:idと同じvalidateRiskSettingsで再検証する。
  app.post<{
    Params: { id: string };
    Body: { stopLossPct?: number; takeProfitPct?: number; trailingStopPct?: number | null };
  }>("/api/strategies/:id/apply-walk-forward-params", async (request, reply) => {
    const { id } = request.params;
    const { stopLossPct, takeProfitPct, trailingStopPct } = request.body ?? {};

    if (
      typeof stopLossPct !== "number" ||
      typeof takeProfitPct !== "number" ||
      (trailingStopPct !== null && typeof trailingStopPct !== "number")
    ) {
      return reply.status(400).send({
        error: "stopLossPct・takeProfitPctは数値、trailingStopPctは数値またはnullで指定してください",
      });
    }

    const riskBody: StrategyBody = { stopLossPct, takeProfitPct, trailingStopPct };
    const riskError = validateRiskSettings(riskBody);
    if (riskError) {
      return reply.status(400).send({ error: riskError });
    }

    const existing = await prisma.strategy.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: "指定された戦略が見つかりません" });
    }

    const row = await prisma.strategy.update({
      where: { id },
      data: riskSettingsData(riskBody),
    });

    await reloadActiveStrategies();
    const dto = toStrategyDto(row);
    broadcast({ type: "strategy_update", payload: dto });
    return dto;
  });

  // Bot Blueprintの「Position」ノードのライブ値表示・エディタのライブプレビュー用
  app.get<{ Params: { id: string } }>(
    "/api/strategies/:id/open-positions",
    async (request, reply) => {
      const { id } = request.params;
      const strategy = await prisma.strategy.findUnique({ where: { id } });
      if (!strategy) {
        return reply.status(404).send({ error: "指定された戦略が見つかりません" });
      }
      const count = await prisma.position.count({
        where: { strategyId: id, pair: strategy.pair, side: "buy", closedAt: null },
      });
      return { strategyId: id, count };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/strategies/:id", async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.strategy.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: "指定された戦略が見つかりません" });
    }

    await prisma.strategy.delete({ where: { id } });
    await reloadActiveStrategies();
    return { ok: true };
  });
}
