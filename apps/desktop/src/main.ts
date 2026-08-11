import path from "node:path";
import { app, BrowserWindow, dialog, shell, type Tray } from "electron";
import { guardServerPort } from "./portGuard";
import {
  startServerProcess,
  stopServerProcess,
  forceKillServerProcessSync,
} from "./serverProcess";
import { startWebProcess, stopWebProcess, forceKillWebProcessSync } from "./webProcess";
import {
  APP_RENDERER_URL,
  hasRendererBuild,
  registerRendererProtocolHandler,
  registerRendererProtocolPrivileges,
} from "./rendererProtocol";
import { getDatabaseUrl } from "./paths";
import { ensureUserEnvFile, readUserEnv } from "./userEnv";
import { runServerMigrations } from "./serverMigrate";
import { initAutoUpdater } from "./updater";
import { createTray, notifyBackgroundOnce } from "./tray";

const WEB_PORT = Number(process.env.NOCTAS_DESKTOP_WEB_PORT ?? 3000);
// Phase 2 で静的書き出しに切り替えた際に next dev を誤って起動しないよう、
// 明示的にオプトインした開発時 (npm run dev:desktop) だけ web を管理する。
const MANAGE_WEB = process.env.NOCTAS_DESKTOP_MANAGE_WEB === "1";
// web を管理しない = 静的書き出し済みの renderer を app:// から配信する。
const RENDERER_URL =
  process.env.NOCTAS_DESKTOP_RENDERER ??
  (MANAGE_WEB ? `http://localhost:${WEB_PORT}` : APP_RENDERER_URL);
// NOCTAS_DESKTOP_RENDERERで上書きされている場合、MANAGE_WEBの値に関わらず
// 実際に app:// を読み込むかどうかはこちらで判定する。
const USES_APP_PROTOCOL = RENDERER_URL === APP_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let loadRetried = false;

// 片方の停止が失敗しても、もう片方は必ず試行する。
async function stopAllProcesses(): Promise<void> {
  await Promise.allSettled([stopWebProcess(), stopServerProcess()]);
}

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#05070d",
    title: "Noctas",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ウィンドウを閉じてもサーバー/Bot戦略エンジンは動き続けさせるため、実際の破棄はせずhideする。
  // 明示的な終了 (トレイの「終了」) 時のみ quitting が立ち、通常どおり閉じられる。
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    if (tray) notifyBackgroundOnce(tray);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // web開発サーバーの listen 直後はまだ接続を取りこぼすことがあるため、一度だけ再試行する。
  // app:// 配信時はロード失敗が資産欠損を意味するので、握りつぶさずそのまま表示させる。
  mainWindow.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
    if (USES_APP_PROTOCOL || !isMainFrame || loadRetried || quitting) return;
    loadRetried = true;
    setTimeout(() => {
      void mainWindow?.loadURL(RENDERER_URL);
    }, 1_000);
  });

  void mainWindow.loadURL(RENDERER_URL);
  return mainWindow;
}

// userData のパスは app 名から決まるため、ロック取得やready前に確定させる。
app.setName("Noctas");
// registerSchemesAsPrivileged は app.whenReady() より前に呼ぶ必要がある。
registerRendererProtocolPrivileges();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    // トレイに格納 (hide) されている場合は minimized ではないため、別途 show() が必要。
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerRendererProtocolHandler();

    // サーバー/portGuardより前に確認する: レンダラーが無いなら、
    // バックエンドを起動する意味がないので早期に諦める。
    if (USES_APP_PROTOCOL && !hasRendererBuild()) {
      dialog.showErrorBox(
        "Noctas レンダラーが見つかりません",
        "apps/desktop/renderer が存在しません。`npm run build:desktop:renderer` を実行してビルドしてください。"
      );
      app.quit();
      return;
    }

    // パッケージ版は apps/server/.env が無いため、ユーザーが編集する .env を userData に用意する。
    if (app.isPackaged) ensureUserEnvFile();

    const decision = await guardServerPort();
    if (decision === "abort") {
      app.quit();
      return;
    }

    if (decision === "start-server") {
      // パッケージ版は初回インストール時にDBが存在せず、アップデートでスキーマが
      // 変わることもあるため、サーバー起動前に必ずマイグレーションを適用する。
      if (app.isPackaged) {
        try {
          await runServerMigrations();
        } catch (err) {
          dialog.showErrorBox(
            "Noctas データベースを準備できません",
            err instanceof Error ? err.message : String(err)
          );
          app.quit();
          return;
        }
      }

      // 開発版では getDatabaseUrl() が undefined を返し、apps/server/.env の
      // DATABASE_URL がそのまま使われる(挙動は従来どおり)。
      const databaseUrl = getDatabaseUrl();
      try {
        await startServerProcess(
          databaseUrl ? { ...readUserEnv(), DATABASE_URL: databaseUrl } : {}
        );
      } catch (err) {
        dialog.showErrorBox(
          "Noctas サーバーを起動できません",
          err instanceof Error ? err.message : String(err)
        );
        app.quit();
        return;
      }
    }

    if (MANAGE_WEB) {
      try {
        await startWebProcess();
      } catch (err) {
        dialog.showErrorBox(
          "Noctas web開発サーバーを起動できません",
          err instanceof Error ? err.message : String(err)
        );
        await stopAllProcesses();
        app.quit();
        return;
      }
    }

    initAutoUpdater(createWindow(), stopAllProcesses);
    tray = createTray({
      showWindow: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
      // quitting は before-quit ハンドラが一度だけ立てる (グレースフル停止 →
      // 再度の app.quit() で実際に終了、という二段構え)。ここで先に立てると
      // before-quit のガードに即弾かれ、stopAllProcesses() が走らなくなる。
      requestQuit: () => {
        app.quit();
      },
    });
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopAllProcesses().finally(() => app.quit());
  });

  process.on("exit", () => {
    forceKillWebProcessSync();
    forceKillServerProcessSync();
  });
}
