/**
 * Electron main process for EdgeClaw Desktop.
 *
 * Lifecycle:
 *   1. Single-instance lock
 *   2. Check ~/.edgeclaw/config.yaml exists; if not, show onboarding dialog
 *   3. Start ServerManager (spawns claudecodeui server on bundled Node)
 *   4. Wait for /health, then load http://127.0.0.1:<port>/ in BrowserWindow
 */

import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function checkConfigOrShowOnboarding(): boolean {
  if (fs.existsSync(configPath)) return true;

  // claudecodeui's load-env.js will throw if EDGECLAW_API_KEY etc. are missing,
  // so we surface the issue here with a clear message before we even try to start.
  void dialog.showMessageBox({
    type: "info",
    title: "EdgeClaw 首次启动",
    message: "需要配置 API 凭证后才能启动。",
    detail:
      `请在以下路径创建配置文件：\n\n${configPath}\n\n` +
      `示例内容：\n\n` +
      `EDGECLAW_API_BASE_URL: https://api.anthropic.com\n` +
      `EDGECLAW_API_KEY: sk-ant-...\n` +
      `EDGECLAW_MODEL: claude-sonnet-4-5-20250929\n\n` +
      `保存后重新启动 EdgeClaw。`,
    buttons: ["退出"],
  });
  return false;
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

  void win.loadURL(`http://127.0.0.1:${port}/`);

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

    if (!checkConfigOrShowOnboarding()) {
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
        void mainWindow.loadURL(`http://127.0.0.1:${p}/`);
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
