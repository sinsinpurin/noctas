import { Menu, Tray, nativeImage } from "electron";
import { TRAY_ICON_PATH } from "./paths";

let balloonShown = false;

export function createTray(opts: { showWindow: () => void; requestQuit: () => void }): Tray {
  const tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
  tray.setToolTip("Noctas - 稼働中");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "開く", click: opts.showWindow },
      { type: "separator" },
      { label: "終了", click: opts.requestQuit },
    ])
  );
  // Windows標準の単クリックで復帰できるようにする。
  tray.on("click", opts.showWindow);
  return tray;
}

// displayBalloon は Windows 専用の Tray API (このアプリは Windows 専用ビルドなので分岐不要)。
export function notifyBackgroundOnce(tray: Tray): void {
  if (balloonShown) return;
  balloonShown = true;
  tray.displayBalloon({
    title: "Noctas",
    content: "Noctasはバックグラウンドで動作中です",
  });
}
