/** 損益ダッシュボード共通の表示フォーマッタ。色は意味固定(緑=利益, 赤=損失) */

export const PROFIT_COLOR = "#39FF88";
export const LOSS_COLOR = "#FF003C";

export function formatJpy(value: number) {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

/** AIコスト表示用。少額(100円未満)は小数2桁まで表示する */
export function formatCostJpy(value: number) {
  if (Math.abs(value) < 100) {
    return `¥${value.toFixed(2)}`;
  }
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

/** 符号付き円表示。損益は必ず+/-を明示する(色だけに頼らない) */
export function formatSignedJpy(value: number) {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}¥${Math.round(Math.abs(value)).toLocaleString("ja-JP")}`;
}

export function pnlColor(value: number) {
  return value >= 0 ? PROFIT_COLOR : LOSS_COLOR;
}

/** 低勝率アラートのしきい値。少ないサンプル数でのノイズを警告しないよう最低件数を要求する */
export const LOW_WIN_RATE_MIN_SAMPLE = 5;
export const LOW_WIN_RATE_THRESHOLD = 0.4;

/** サンプル数が十分(5件以上)かつ勝率が40%未満なら低勝率とみなす */
export function isLowWinRate(winCount: number, count: number): boolean {
  if (count < LOW_WIN_RATE_MIN_SAMPLE) return false;
  return winCount / count < LOW_WIN_RATE_THRESHOLD;
}

export function formatDateTime(ts: number) {
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 保有時間("2d 3h" / "3h 12m" / "45m")*/
export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
