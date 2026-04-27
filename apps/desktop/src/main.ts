/**
 * Electron main process for EdgeClaw Desktop.
 *
 * Lifecycle:
 *   1. Single-instance lock
 *   2. Check ~/.edgeclaw/config.yaml exists; if not, show onboarding window
 *      (small BrowserWindow with onboarding/onboarding.html). User submits
 *      API credentials → main writes config.yaml → onboarding window closes.
 *   3. Start ServerManager (spawns claudecodeui server on bundled Node)
 *   4. Wait for /health, then load http://127.0.0.1:<port>/ in BrowserWindow
 */

import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { showOnboardingWindow } from "./onboarding-window";
import { ServerManager } from "./server-manager";

app.setName("EdgeClaw");

const isDev = !app.isPackaged;
const devRepoRoot = path.resolve(__dirname, "..", "..", "..");
const configPath = path.join(os.homedir(), ".edgeclaw", "config.yaml");

const serverManager = new ServerManager({
  dev: isDev,
  devRepoRoot: isDev ? devRepoRoot : undefined,
});

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let shutdownStarted = false;

function setupAppMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "EdgeClaw",
        submenu: [
          { role: "about", label: "关于 EdgeClaw" },
          { type: "separator" },
          { role: "hide", label: "隐藏 EdgeClaw" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "退出 EdgeClaw" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "resetZoom" },
        ],
      },
      {
        label: "窗口",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
      },
    ]),
  );
}

function resolveOnboardingHtmlPath(): string {
  // Compiled main lives at <root>/dist/main.js, while onboarding/ sits at
  // the project root (<root>/onboarding/onboarding.html). In the packaged
  // app electron-builder mirrors the same layout inside app.asar.
  return path.join(__dirname, "..", "onboarding", "onboarding.html");
}

async function ensureConfigOrOnboard(): Promise<boolean> {
  if (fs.existsSync(configPath)) return true;

  const htmlPath = resolveOnboardingHtmlPath();
  if (!fs.existsSync(htmlPath)) {
    // Defensive fallback: shouldn't happen in a correctly built app, but if
    // it does we still need to tell the user *something* before quitting.
    await dialog.showMessageBox({
      type: "error",
      title: "EdgeClaw",
      message: "Onboarding 资源缺失",
      detail: `未找到 onboarding HTML：\n${htmlPath}`,
      buttons: ["退出"],
    });
    return false;
  }

  const result = await showOnboardingWindow({
    preloadPath: path.join(__dirname, "preload.js"),
    htmlPath,
  });
  return result === "saved";
}

function registerIpcHandlers(): void {
  ipcMain.handle("get-version", () => app.getVersion());
  ipcMain.handle("get-server-port", () => serverManager.getPort());
  ipcMain.handle("get-server-status", () => ({
    state: serverManager.isRunning() ? "running" : "stopped",
    port: serverManager.getPort(),
  }));
}

function createMainWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "EdgeClaw",
    show: false,
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void win.loadURL(`http://127.0.0.1:${port}/?uiV2=1`);

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

async function shutdown(): Promise<void> {
  try {
    await serverManager.stop();
  } catch {
    /* ignore */
  }
  mainWindow = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    setupAppMenu();
    registerIpcHandlers();

    const configured = await ensureConfigOrOnboard();
    if (!configured) {
      app.quit();
      return;
    }

    let port: number;
    try {
      const started = await serverManager.start();
      port = started.port;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await dialog.showMessageBox({
        type: "error",
        title: "EdgeClaw",
        message: "本地服务启动失败",
        detail: msg,
        buttons: ["退出"],
      });
      app.quit();
      return;
    }

    serverManager.on("ready", (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`http://127.0.0.1:${p}/?uiV2=1`);
      }
    });

    serverManager.on("error", (err) => {
      console.error("[EdgeClaw] server error:", err);
    });

    serverManager.on("max-restarts", () => {
      void dialog.showMessageBox(mainWindow ?? (undefined as never), {
        type: "error",
        title: "EdgeClaw",
        message: "本地服务多次崩溃",
        detail: "服务进程已多次异常退出。请尝试重启应用。",
      });
    });

    mainWindow = createMainWindow(port);
  });
}

app.on("before-quit", (e) => {
  if (shutdownStarted) return;
  e.preventDefault();
  isQuitting = true;
  shutdownStarted = true;
  void shutdown().then(() => app.exit(0));
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    try {
      const u = new URL(url);
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
});
