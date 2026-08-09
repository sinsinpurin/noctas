import type {
  BacktestRequest,
  BacktestSummary,
  CandleTimeframe,
  GeneratedStrategy,
  Strategy,
  StrategyGraph,
  WalkForwardBatchResponse,
} from "@noctas/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `APIエラー (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchStrategies(): Promise<Strategy[]> {
  return handle(await fetch(`${API_URL}/api/strategies`));
}

export interface StrategyRiskInput {
  positionSizeJpy?: number | null;
  maxOpenPositions?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  trailingStopPct?: number | null;
}

export async function createStrategy(input: {
  name: string;
  pair?: string;
  timeframe?: CandleTimeframe;
  description?: string;
  graph: StrategyGraph;
} & StrategyRiskInput): Promise<Strategy> {
  return handle(
    await fetch(`${API_URL}/api/strategies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function updateStrategy(
  id: string,
  input: Partial<{
    name: string;
    pair: string;
    timeframe: CandleTimeframe;
    description: string;
    graph: StrategyGraph;
    isActive: boolean;
  }> &
    StrategyRiskInput
): Promise<Strategy> {
  return handle(
    await fetch(`${API_URL}/api/strategies/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function generateStrategy(
  prompt: string,
  pair?: string,
  reviewContext?: string,
  timeframe?: CandleTimeframe
): Promise<GeneratedStrategy> {
  return handle(
    await fetch(`${API_URL}/api/strategies/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, pair, reviewContext, timeframe }),
    })
  );
}

export interface StrategyOpenPositions {
  strategyId: string;
  count: number;
}

export async function fetchStrategyOpenPositions(id: string): Promise<StrategyOpenPositions> {
  return handle(await fetch(`${API_URL}/api/strategies/${id}/open-positions`));
}

export async function deleteStrategy(id: string): Promise<void> {
  await handle<{ ok: boolean }>(
    await fetch(`${API_URL}/api/strategies/${id}`, { method: "DELETE" })
  );
}

/** キャンバス上のグラフ(保存前でも可)をサーバーの過去ローソク足履歴でバックテストする(読み取り専用) */
export async function runBacktest(input: BacktestRequest): Promise<BacktestSummary> {
  return handle(
    await fetch(`${API_URL}/api/strategies/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

/**
 * 現在アクティブな全戦略のSL/TP/トレーリングを、ローリング3ヶ月スナップショットに対して
 * ウォークフォワード検証する(読み取り専用。戦略の保存済み設定は一切変更しない)。
 */
export async function runWalkForwardValidation(): Promise<WalkForwardBatchResponse> {
  // No request body: omit Content-Type too, since Fastify's JSON body parser rejects an
  // empty body when the header claims application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
  return handle(await fetch(`${API_URL}/api/strategies/walk-forward`, { method: "POST" }));
}

export interface WalkForwardRecommendedParams {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
}

/**
 * ウォークフォワード検証のrecommendedParamsを稼働中戦略のライブリスク設定へ即時反映する。
 * サーバー側でvalidateRiskSettingsによる再検証が行われる。
 */
export async function applyWalkForwardParams(
  id: string,
  params: WalkForwardRecommendedParams
): Promise<Strategy> {
  return handle(
    await fetch(`${API_URL}/api/strategies/${id}/apply-walk-forward-params`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}
