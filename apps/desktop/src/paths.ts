import path from "node:path";
import { app } from "electron";

// パッケージ版と開発版で場所が変わるパスを、この1ファイルに集約する。
//
// パッケージ版のレイアウト (electron-builder.yml の extraResources が
// apps/desktop/server-dist/ をまるごと resources/server/ に配置する):
//   <resources>/server/dist/index.js       サーバー本体
//   <resources>/server/prisma/             schema.prisma + migrations/
//   <resources>/server/node_modules/       本番依存 (.prisma/client を含む)
//   <resources>/server/prisma-cli/         起動時 migrate deploy 用
//
// 開発版では apps/server/ をそのまま使い、DBもDATABASE_URLも apps/server/.env のまま
// 変更しない (npm run dev:desktop の挙動を変えないため)。

// dist/paths.js から見て apps/desktop/dist -> リポジトリルート
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(repoRoot, "apps", "server");

export const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "index.js");
export const PRISMA_SCHEMA = path.join(SERVER_DIR, "prisma", "schema.prisma");
export const PRISMA_CLI = path.join(SERVER_DIR, "prisma-cli", "build", "index.js");
export const SCHEMA_ENGINE_BIN = path.join(
  SERVER_DIR,
  "prisma-cli",
  "schema-engine-windows.exe"
);

// asar 内に同梱される (electron-builder.yml の files に resources/**/* を含めている)。
export const USER_ENV_TEMPLATE = path.join(__dirname, "..", "resources", "env.template");

// システムトレイアイコン。上記と同じく resources/**/* でパッケージ実行時にも同梱される。
export const TRAY_ICON_PATH = path.join(__dirname, "..", "resources", "tray-icon.ico");

// userData は app.getName() から都度計算されるため、main.ts の app.setName("Noctas") より
// 先にモジュールが評価されても正しい値になるよう、定数ではなく関数で公開する。
export function getUserEnvPath(): string {
  return path.join(app.getPath("userData"), ".env");
}

// パッケージ版のDBはユーザーデータ領域に置く (インストール先はアップデートで入れ替わるため)。
// Prisma の file: URL は Windows のバックスラッシュを黙って壊すのでスラッシュに正規化する。
// 開発版は undefined を返し、apps/server/.env の DATABASE_URL をそのまま使わせる。
export function getDatabaseUrl(): string | undefined {
  if (!app.isPackaged) return undefined;
  return `file:${path.join(app.getPath("userData"), "noctas.db").replace(/\\/g, "/")}`;
}
