export * from "./indicators";
export * from "./evaluator";

export type Pair = string; // 例: "btc_jpy"

export type OrderSide = "buy" | "sell";

export type AiAction = "buy" | "sell" | "hold";

/** チャートの時間足。分足はサーバーの1分足バッファを集計して生成する */
export type CandleTimeframe = "1min" | "5min" | "15min" | "30min" | "1hour" | "4hour" | "1day";

export interface CandleTimeframeOption {
  value: CandleTimeframe;
  label: string;
  /** 1本あたりの分数(集計バケットサイズ) */
  minutes: number;
}

/** UIの時間足セレクタ・サーバー集計の両方が参照する定義(表示順) */
export const CANDLE_TIMEFRAMES: CandleTimeframeOption[] = [
  { value: "1min", label: "1分", minutes: 1 },
  { value: "5min", label: "5分", minutes: 5 },
  { value: "15min", label: "15分", minutes: 15 },
  { value: "30min", label: "30分", minutes: 30 },
  { value: "1hour", label: "1時間", minutes: 60 },
  { value: "4hour", label: "4時間", minutes: 240 },
  { value: "1day", label: "1日", minutes: 1440 },
];

export const DEFAULT_CANDLE_TIMEFRAME: CandleTimeframe = "1min";

export function minutesOfTimeframe(timeframe: CandleTimeframe): number {
  return CANDLE_TIMEFRAMES.find((t) => t.value === timeframe)?.minutes ?? 1;
}

export function isCandleTimeframe(value: string): value is CandleTimeframe {
  return CANDLE_TIMEFRAMES.some((t) => t.value === value);
}

/** bitbank Public Stream の ticker_{pair} イベントを正規化したもの */
export interface Ticker {
  pair: Pair;
  sell: number;
  buy: number;
  high: number;
  low: number;
  last: number;
  vol: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  amount: number;
}

export interface OrderBook {
  pair: Pair;
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  timestamp: number;
}

/** ペーパートレードにおける仮想ポジション */
export interface Position {
  id: string;
  pair: Pair;
  side: OrderSide;
  entryPrice: number;
  amount: number;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  pnl: number | null;
  /** このポジションを建てたBot戦略ID(AI判断の場合はnull) */
  strategyId?: string | null;
}

/** 約定の発生理由。ai_decisionは廃止された旧AI判断ループの名残(過去データ表示用に残置)。
 *  現在の新規約定はBot戦略(ai_judgmentノードを含む場合も)経由でbot_strategyになる。
 *  manualはダッシュボードの手動決済ボタンから成行決済した場合 */
export type TradeReason =
  | "ai_decision"
  | "stop_loss"
  | "bot_strategy"
  | "take_profit"
  | "trailing_stop"
  | "manual";

/** ペーパートレードにおける仮想約定履歴 */
export interface Trade {
  id: string;
  pair: Pair;
  side: OrderSide;
  price: number;
  amount: number;
  executedAt: number;
  aiDecisionId: string | null;
  reason: TradeReason;
  /** この約定で支払った手数料(円、シミュレーション値) */
  fee?: number;
}

/** Bot Blueprintの「AI Judgment」ノードが参照する、ペアごとの最新AI判断キャッシュ(GET /api/ai-judgment) */
export interface AiJudgment {
  pair: Pair;
  action: AiAction;
  confidence: number; // 0.0 - 1.0
  reasoning: string;
  /** この判断がキャッシュされた時刻(エポックms) */
  updatedAt: number;
}

/** その日のAIトークン利用量・推定コストのサマリ */
export interface AiUsageStats {
  date: string; // "YYYY-MM-DD" (JST基準)
  model: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostJpy: number;
  dailyBudgetJpy: number;
  budgetExceeded: boolean;
}

// ---------------------------------------------------------------------------
// Bot戦略(ブループリント型ノードグラフ)
// ---------------------------------------------------------------------------

/**
 * 戦略グラフのノード種別。
 * - source: price(終値シリーズ), volume(出来高シリーズ), constant(定数), position(建玉の保有状況),
 *   time_filter(現在の足のJST時刻が除外時間帯の外にあるか)
 * - indicator: sma / ema / rsi(数値シリーズ → 数値シリーズ)
 * - condition: compare(大小比較), cross(クロス判定)
 * - logic: and / or / not(真偽シリーズの合成)
 * - ai: ai_judgment(Claudeの売買判断が指定アクションと一致した瞬間に真になる条件)
 * - action: buy / sell(条件の立ち上がりで発注)
 */
export type StrategyNodeType =
  | "price"
  | "volume"
  | "constant"
  | "position"
  | "time_filter"
  | "sma"
  | "ema"
  | "rsi"
  | "compare"
  | "cross"
  | "logic"
  | "ai_judgment"
  | "buy"
  | "sell";

export type CompareOp = "gt" | "lt" | "gte" | "lte";
export type CrossOp = "cross_above" | "cross_below";
export type LogicOp = "and" | "or" | "not";

/** ノードのパラメータ。種別ごとに使用するキーが異なる(例: sma→period, compare→op) */
export type StrategyNodeParams = Record<string, number | string>;

export interface StrategyNode {
  id: string;
  type: StrategyNodeType;
  params: StrategyNodeParams;
  /** エディタ(React Flow)上の表示座標 */
  position: { x: number; y: number };
}

export interface StrategyEdge {
  id: string;
  source: string;
  /** 出力ハンドルID(通常 "out") */
  sourceHandle?: string | null;
  target: string;
  /** 入力ハンドルID("in" | "a" | "b" | "condition") */
  targetHandle?: string | null;
}

export interface StrategyGraph {
  nodes: StrategyNode[];
  edges: StrategyEdge[];
}

/** 戦略ごとのリスク設定。nullはサーバーのグローバル設定にフォールバック */
export interface StrategyRiskSettings {
  /** 1回の買いで投入する金額(円) */
  positionSizeJpy: number | null;
  /** この戦略が同時に持てる未決済ポジション数 */
  maxOpenPositions: number | null;
  /** 損切り率(%) */
  stopLossPct: number | null;
  /** 利確率(%)。建値からこの%上昇したら自動決済 */
  takeProfitPct: number | null;
  /** トレーリングストップ幅(%)。建玉後の最高値からこの%下落したら自動決済 */
  trailingStopPct: number | null;
}

export interface Strategy extends StrategyRiskSettings {
  id: string;
  name: string;
  /** 対象ペア(例: "btc_jpy")。このペア・時間足の組み合わせでグラフが評価される */
  pair: Pair;
  /** グラフを評価する時間足 */
  timeframe: CandleTimeframe;
  description: string;
  graph: StrategyGraph;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/** POST /api/strategies/generate のレスポンス(AIによる戦略グラフの自動生成結果) */
export interface GeneratedStrategy {
  name: string;
  description: string;
  graph: StrategyGraph;
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    estimatedCostJpy: number;
  };
}

/** Bot戦略が発火したシグナル。executed=falseはリスク制約等で発注を見送ったことを示す */
export interface BotSignal {
  id: string;
  strategyId: string;
  strategyName: string;
  pair: Pair;
  action: OrderSide;
  price: number;
  triggeredAt: number;
  executed: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// バックテスト(保存前のグラフを過去ローソク足でウォークフォワード再生する読み取り専用シミュレーション)
// ---------------------------------------------------------------------------

/**
 * POST /api/strategies/backtest のリクエストボディ。エディタのキャンバス上のグラフをそのまま渡せる
 * (保存前でも実行可能。DBへの書き込みは一切発生しない)。リスク設定はStrategyRiskSettingsと同じ
 * フィールド名で、未指定(undefined)またはnullはサーバーのグローバル設定にフォールバックする。
 */
export type BacktestPeriod = "loaded" | "three_months";
/** シグナルを同じ足の終値で約定させる旧方式か、次足始値で約定させる方式か */
export type BacktestExecutionMode = "legacy_intrabar" | "closed_bar_next_tick";

export interface BacktestCostProfile {
  feePct: number;
  slippagePct: number;
  label?: string;
}

export interface BacktestRequest extends Partial<StrategyRiskSettings> {
  graph: StrategyGraph;
  pair: Pair;
  timeframe: CandleTimeframe;
  /** loaded uses the server's live candle cache; three_months fetches the latest 90 days. */
  period?: BacktestPeriod;
  /** 仮想口座の開始円残高。未指定はペーパートレードの初期残高を使う */
  initialBalanceJpy?: number;
  /** 未指定は既存互換のlegacy_intrabar。新規検証ではclosed_bar_next_tickを推奨 */
  executionMode?: BacktestExecutionMode;
  costProfile?: BacktestCostProfile;
}

/** バックテストで仮想的に建てて決済した1回分の取引。ClosedPositionRecordに近い形にしている */
export interface BacktestTrade {
  side: OrderSide;
  entryPrice: number;
  amount: number;
  /** 建玉した足のtime(エポックms) */
  openedAt: number;
  /** 決済した足のtime(エポックms) */
  closedAt: number;
  closePrice: number;
  /** 手数料控除済みの実現損益(円) */
  pnl: number;
  closeReason: TradeReason;
  /** 建玉+決済の合計手数料(円、シミュレーション値) */
  totalFeeJpy: number;
}

/** POST /api/strategies/backtest のレスポンス。フィールド名はPnlSummaryとなるべく揃えている */
export interface BacktestSummary {
  /** シミュレーションに使ったローソク足の本数(CANDLE_SEED_DAYS日分が上限) */
  candleCount: number;
  /** 簡略化・再現不可能な点についての注意文言(例: ai_judgmentノードは常に不成立扱い) */
  warnings: string[];
  realizedPnl: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  /** 含み損益を含む清算価値ベースの最大ドローダウン(正の値) */
  liquidationMaxDrawdown: number;
  /** 最大ドローダウンを期間中の資産ピークで割った率 */
  liquidationMaxDrawdownPct: number | null;
  /** 期間末に未決済の建玉を成行売却した想定の損益 */
  unrealizedPnl: number;
  /** 期間末の清算価値(初期残高 + 実現損益 + 未実現損益) */
  endingEquityJpy: number;
  totalFeesJpy: number;
  /** 手数料控除前の合計損益(円)。各トレードのpnl + totalFeeJpyの合計 */
  grossPnlJpy: number;
  /** 値動きの方向は合っていた(grossPnlがプラス)のに、手数料込みの純pnlが0以下になったトレード件数 */
  feeLossCount: number;
  equityCurve: PnlCurvePoint[];
  /** 含み損益を含む清算価値カーブ(timeはUNIX秒) */
  liquidationEquityCurve: PnlCurvePoint[];
  trades: BacktestTrade[];
  /** The requested simulation period, included so the UI can label the result unambiguously. */
  period?: BacktestPeriod;
  dataStartAt?: number;
  dataEndAt?: number;
}

// ---------------------------------------------------------------------------
// ウォークフォワード検証(アクティブ戦略のSL/TP/トレーリングを複数ウィンドウで最適化・検証する)
// ---------------------------------------------------------------------------

/** グリッドサーチで試すSL/TP/トレーリングストップの候補値。戦略の保存済み設定は書き換えない */
export interface WalkForwardParamGrid {
  stopLossPct: number[];
  takeProfitPct: number[];
  trailingStopPct: (number | null)[];
}

export interface WalkForwardWindowResult {
  windowIndex: number;
  inSampleStart: number;
  inSampleEnd: number;
  outOfSampleStart: number;
  outOfSampleEnd: number;
  bestParams: { stopLossPct: number; takeProfitPct: number; trailingStopPct: number | null };
  inSample: BacktestSummary;
  outOfSample: BacktestSummary;
}

export interface WalkForwardSummary {
  warnings: string[];
  windowCount: number;
  windows: WalkForwardWindowResult[];
  aggregate: {
    outOfSampleRealizedPnl: number;
    outOfSampleWinRate: number | null;
    outOfSampleProfitFactor: number | null;
    outOfSampleMaxDrawdown: number;
    outOfSampleTrades: number;
    /** OOS pnlが非負だったウィンドウの割合(0-1)。ウィンドウ0件ならnull */
    consistencyRatio: number | null;
  };
  /**
   * 全ウィンドウのbestParamsから選んだ推奨パラメータ(最頻値。複数タイの場合はout-of-sample
   * realizedPnl合計が最大のものを採用)。ウィンドウが1つも無ければnull。
   */
  recommendedParams: { stopLossPct: number; takeProfitPct: number; trailingStopPct: number | null } | null;
  dataStartAt?: number;
  dataEndAt?: number;
}

export interface WalkForwardStrategyResult {
  strategyId: string;
  strategyName: string;
  pair: Pair;
  timeframe: CandleTimeframe;
  currentParams: { stopLossPct: number | null; takeProfitPct: number | null; trailingStopPct: number | null };
  summary: WalkForwardSummary;
}

/** POST /api/strategies/walk-forward のレスポンス */
export interface WalkForwardBatchResponse {
  generatedAt: number;
  activeStrategyCount: number;
  results: WalkForwardStrategyResult[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// アプリ設定・AI使用量
// ---------------------------------------------------------------------------

/** 取引モード。"paper"のみ対応(実運用注文APIは呼び出さない)。ペーパートレードのリセットはpaperモードでのみ許可する */
export type TradingMode = "paper" | "live";

/** ランタイムで変更できるアプリ設定 */
export interface AppSettings {
  /** AI判断(Bot BlueprintのAI Judgmentノード用、Claude定期呼び出し)を有効にするか */
  aiJudgmentEnabled: boolean;
  /** サーキットブレーカー(日次最大損失・連敗自動停止)を有効にするか */
  circuitBreakerEnabled: boolean;
  /** 本日(JST)の実現損失がこの額を超えたら全Botの新規買いを停止する(円) */
  dailyMaxLossJpy: number;
  /** 戦略がこの回数連続で負けたら自動でStandbyにする */
  maxConsecutiveLosses: number;
  /** Anthropic APIキーが設定済みか(DBまたは環境変数) */
  anthropicApiKeyConfigured: boolean;
  /** 有効なキーの取得元。未設定ならnull */
  anthropicApiKeySource: "db" | "env" | null;
  /** 末尾4文字のみのマスク表示(例 "••••••••ab12")。生値は絶対に返さない */
  anthropicApiKeyMasked: string | null;
}

/** サーキットブレーカーの発動状態 */
export interface CircuitBreakerStatus {
  /** 本日の新規買いが停止中か */
  halted: boolean;
  /** 停止理由(未発動ならnull) */
  reason: string | null;
  /** 発動日時(エポックms、未発動ならnull) */
  haltedAt: number | null;
}

/** JST日別のAIトークン使用量(売買判断+戦略生成の合算) */
export interface AiUsageDay {
  date: string; // "YYYY-MM-DD" (JST基準)
  decisionCalls: number;
  generationCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostJpy: number;
}

/** GET /api/settings が返すAI使用量サマリ */
export interface AiUsageSummary {
  decisionModel: string;
  strategyModel: string;
  dailyBudgetJpy: number;
  /** 本日(JST)のAI判断(Bot Blueprint AI Judgmentノード)分の推定コスト。日次予算の判定対象はこちらのみ */
  todayDecisionCostJpy: number;
  budgetExceeded: boolean;
  /** 直近30日(JST)の日別使用量。新しい日が先頭 */
  days: AiUsageDay[];
  /** daysに含まれる期間の合計 */
  totals: {
    decisionCalls: number;
    generationCalls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostJpy: number;
  };
}

export interface SettingsResponse {
  settings: AppSettings;
  circuitBreaker: CircuitBreakerStatus;
  usage: AiUsageSummary;
  /** 現在の取引モード。"paper"のときのみペーパートレードのリセットができる */
  tradingMode: TradingMode;
}

// ---------------------------------------------------------------------------
// 損益ダッシュボード
// ---------------------------------------------------------------------------

/** 累積実現損益カーブの1点(timeはUNIX秒) */
export interface PnlCurvePoint {
  time: number;
  value: number;
}

/** JST日次の実現損益 */
export interface PnlDailyPoint {
  date: string; // "YYYY-MM-DD" (JST基準)
  pnl: number;
  tradeCount: number;
}

/** 決済理由(≒発注経路)ごとの実現損益内訳 */
export interface PnlReasonBreakdown {
  reason: TradeReason;
  pnl: number;
  count: number;
  winCount: number;
}

/** 決済済みポジション+決済理由 */
export interface ClosedPositionRecord extends Position {
  closeReason: TradeReason | null;
  /** 建玉+決済の合計手数料(円、シミュレーション値)。pnlは控除済み */
  totalFeeJpy: number;
}

/** 戦略ごとの実現損益サマリ */
export interface PnlStrategyBreakdown {
  /** 戦略ID。AI判断など戦略に紐づかないものはnull */
  strategyId: string | null;
  /** 戦略名(削除済みは"(削除済み)"、null枠は"AI判断・その他") */
  strategyName: string;
  pair: Pair | null;
  isActive: boolean;
  closedCount: number;
  winCount: number;
  realizedPnl: number;
}

/** GET /api/pairs が返す取引対象ペア情報 */
export interface PairsInfo {
  pairs: Pair[];
  /** メインペア(先頭ペア) */
  primaryPair: Pair;
  /** 1回の投入額の上限(円)。AI_MAX_POSITION_JPYの値で、戦略ごとのpositionSizeJpyはこれを超えられない */
  maxPositionJpy: number;
}

/** GET /api/pnl が返す損益サマリ(全ペア合算) */
export interface PnlSummary {
  /** ペアごとの最新価格(1分足終値ベース)。履歴が無いペアは含まれない */
  currentPrices: Record<Pair, number>;
  /** 決済済みポジションの損益合計 */
  realizedPnl: number;
  /** 未決済ポジションの現在値評価損益(currentPrice不明時は0) */
  unrealizedPnl: number;
  totalPnl: number;
  winCount: number;
  lossCount: number;
  /** 勝率0-1。決済0件ならnull */
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** 総利益/総損失。損失0なら null */
  profitFactor: number | null;
  /** 累積実現損益カーブ上の最大ドローダウン(正の値) */
  maxDrawdown: number;
  /** これまでに支払った手数料の合計(円、シミュレーション値)。realizedPnlは控除済み */
  totalFeesJpy: number;
  balanceJpy: number;
  /** JPY以外の仮想残高(通貨コード→数量)。例: { btc: 0.003, eth: 0.1 } */
  assetBalances: Record<string, number>;
  /** JPY残高 + BTC残高の現在値評価 */
  equityJpy: number;
  initialBalanceJpy: number;
  equityCurve: PnlCurvePoint[];
  dailyPnl: PnlDailyPoint[];
  byReason: PnlReasonBreakdown[];
  /** 戦略別の実現損益(損益の大きい順) */
  byStrategy: PnlStrategyBreakdown[];
  openPositions: Position[];
  /** 直近の決済済みポジション(新しい順) */
  closedPositions: ClosedPositionRecord[];
}

/** POST /api/pnl/review が返す、AIによる過去取引実績のレビュー */
export interface PnlReview {
  /** レビュー本文(日本語の自由文。見出しや箇条書きを含むことがある) */
  review: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    estimatedCostJpy: number;
  };
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// カスタムシグナルモニター(ダッシュボードの監視条件)
// ---------------------------------------------------------------------------

/** シグナル条件のオペランド。constantは固定値、それ以外は1分足終値ベースの指標 */
export interface SignalOperand {
  type: "price" | "sma" | "ema" | "rsi" | "constant";
  /** sma/ema/rsi の期間 */
  period?: number;
  /** constant の値 */
  value?: number;
}

export type SignalOp = CompareOp | CrossOp;

/** 監視条件: left op right(例: rsi(14) lt 30) */
export interface SignalWatchConfig {
  left: SignalOperand;
  op: SignalOp;
  right: SignalOperand;
}

export interface SignalWatch {
  id: string;
  /** 表示名(空なら条件から自動生成) */
  name: string;
  pair: Pair;
  config: SignalWatchConfig;
  createdAt: number;
  updatedAt: number;
}

/** WebSocketでサーバーからフロントへ配信するメッセージの共通形式 */
export type ServerEvent =
  | { type: "ticker"; payload: Ticker }
  | { type: "trade"; payload: Trade }
  | { type: "position_update"; payload: Position }
  | { type: "usage_stats"; payload: AiUsageStats }
  | { type: "bot_signal"; payload: BotSignal }
  | { type: "strategy_update"; payload: Strategy }
  | { type: "paper_trading_reset"; payload: { resetAt: number } };
