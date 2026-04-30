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
import { validateEdgeClawConfigFile } from "./config-validator";
import { showOnboardingWindow } from "./onboarding-window";
import { ServerManager } from "./server-manager";
import { resolveSplashHtmlPath, showSplashWindow } from "./splash-window";

app.setName("EdgeClaw");

const isDev = !app.isPackaged;
const devRepoRoot = path.resolve(__dirname, "..", "..", "..");
const configPath = path.join(os.homedir(), ".edgeclaw", "config.yaml");

const serverManager = new ServerManager({
  dev: isDev,
  devRepoRoot: isDev ? devRepoRoot : undefined,
  appVersion: app.getVersion(),
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

/**
 * Take the messy multi-line "health-check failed + N kB of ANSI-colored log
 * tail" string that ServerManager throws and pull out the *one* line the user
 * actually needs to see. Falls back to a generic message if no known pattern
 * matches so we never end up with an empty dialog body.
 *
 * Why this exists: the bundled server logs through a colorize() helper that
 * emits SGR escapes ("\x1b[36m[INFO]\x1b[0m" etc.) into desktop.server.log;
 * showing the raw tail in a dialog produces a blob the user can't parse.
 */
function summarizeStartupFailure(message: string): {
  headline: string;
  detail: string;
} {
  const stripped = message.replace(/\x1b\[[0-9;]*m/g, "");

  const missingEnvMatch = stripped.match(
    /Missing required EdgeClaw configuration:\s*([^\n]+)/i,
  );
  if (missingEnvMatch) {
    return {
      headline: "本地服务无法启动：配置不完整",
      detail:
        `~/.edgeclaw/config.yaml 缺少必填字段，子进程已退出。\n\n` +
        `缺失项：${missingEnvMatch[1].trim()}\n\n` +
        `选择"重新配置"会重启应用并打开初始化窗口。`,
    };
  }

  if (/EADDRINUSE|No free desktop server port/i.test(stripped)) {
    return {
      headline: "本地服务无法启动：端口被占用",
      detail:
        `EdgeClaw 默认使用 18790-18799 区间的端口，全部被占用。\n\n` +
        `请关闭占用这些端口的程序后重试。`,
    };
  }

  if (/Bundle not found/i.test(stripped)) {
    return {
      headline: "本地服务无法启动：runtime 资源损坏",
      detail:
        `App Bundle 内的 runtime tar 缺失或损坏。\n\n` +
        `${stripped.split("\n").slice(0, 4).join("\n")}\n\n` +
        `请重新安装 EdgeClaw。`,
    };
  }

  // Fall back to the first non-noisy line of the tail.
  const detailLines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 6)
    .join("\n");
  return {
    headline: "本地服务启动失败",
    detail: detailLines || "未知错误",
  };
}

function resolveOnboardingHtmlPath(): string {
  // Compiled main lives at <root>/dist/main.js, while onboarding/ sits at
  // the project root (<root>/onboarding/onboarding.html). In the packaged
  // app electron-builder mirrors the same layout inside app.asar.
  return path.join(__dirname, "..", "onboarding", "onboarding.html");
}

async function ensureConfigOrOnboard(): Promise<boolean> {
  // Two-stage check: file must exist AND its contents must satisfy what the
  // bundled server's load-env.js will assert at startup. Skipping the second
  // stage is what produced the historical "Server health check failed within
  // 60000ms" pop-up — the file existed (so we skipped onboarding), but the
  // server then crashed on import because models.providers.<x>.{baseUrl,
  // apiKey} or models.entries.default.name were empty.
  const validation = validateEdgeClawConfigFile(configPath);
  if (validation.ok) return true;

  const htmlPath = resolveOnboardingHtmlPath();
  if (!fs.existsSync(htmlPath)) {
    // Defensive fallback: shouldn't happen in a correctly built app, but if
    // it does we still need to tell the user *something* before quitting.
    await dialog.showMessageBox({
      type: "error",
      title: "EdgeClaw",
      message: "Onboarding 资源缺失",
      detail: `未找到 onboarding HTML：\n${htmlPath}\n\n配置问题：${validation.reason}`,
      buttons: ["退出"],
    });
    return false;
  }

  // Tell the user *why* onboarding is showing up. For first-launch (file
  // doesn't exist yet) the validator returns reason = "配置文件不存在", which
  // would be confusing — suppress that. Only show the explanation if the
  // user already had a config but it was incomplete/invalid.
  if (fs.existsSync(configPath)) {
    await dialog.showMessageBox({
      type: "warning",
      title: "EdgeClaw",
      message: "需要重新配置",
      detail:
        `已有的 ~/.edgeclaw/config.yaml 不完整或缺少模型凭据，无法启动本地服务。\n\n` +
        `${validation.reason}\n\n点击"确定"后会打开初始化窗口，重新填入即可。\n` +
        `（旧文件不会被覆盖，保存时会被新内容替换。）`,
      buttons: ["确定"],
    });
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

function createMainWindow(
  port: number,
  options: { onReadyToShow?: () => void } = {},
): BrowserWindow {
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

  win.once("ready-to-show", () => {
    win.show();
    if (options.onReadyToShow) {
      try {
        options.onReadyToShow();
      } catch {
        /* ignore — splash close is best-effort */
      }
    }
  });

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

    // CRITICAL: register the "error" listener *before* start(), otherwise
    // the EventEmitter in ServerManager.attachExitWatchdog can fire
    // `emit("error", ...)` when the spawned child crashes early (e.g.
    // missing config env), and Node's default behaviour for unhandled
    // "error" events is to throw — which Electron then surfaces as a
    // confusing "A JavaScript error occurred in the main process" dialog
    // that hides the actual root cause.
    serverManager.on("error", (err) => {
      console.error("[EdgeClaw] server error:", err);
    });

    serverManager.on("ready", (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`http://127.0.0.1:${p}/?uiV2=1`);
      }
    });

    serverManager.on("max-restarts", () => {
      void dialog.showMessageBox(mainWindow ?? (undefined as never), {
        type: "error",
        title: "EdgeClaw",
        message: "本地服务多次崩溃",
        detail: "服务进程已多次异常退出。请尝试重启应用。",
      });
    });

    // Splash window — shown immediately so the user has a visible "I'm
    // working on it" surface during the slow first-launch tarball
    // extraction (~700MB) and the subsequent server health-check wait.
    // Its sole job is showing the current phase label that ServerManager
    // emits via 'progress'. Lifetime-scoped to the start() attempt: torn
    // down either when the main window's first paint fires (success) or
    // before any error dialog appears (failure).
    const splash = showSplashWindow({
      preloadPath: path.join(__dirname, "preload.js"),
      htmlPath: resolveSplashHtmlPath(),
    });
    splash.setStatus(
      "准备启动…",
      `EdgeClaw v${app.getVersion()} · ${process.platform}-${process.arch}`,
    );
    const onProgress = (phase: string): void => splash.setStatus(phase);
    serverManager.on("progress", onProgress);

    let port: number;
    try {
      const started = await serverManager.start();
      port = started.port;
    } catch (e: unknown) {
      serverManager.off("progress", onProgress);
      splash.close();
      const msg = e instanceof Error ? e.message : String(e);
      const { headline, detail } = summarizeStartupFailure(msg);
      const choice = await dialog.showMessageBox({
        type: "error",
        title: "EdgeClaw",
        message: headline,
        detail,
        buttons: ["重新配置", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        // Re-launch the app so onboarding can pick up cleanly. We don't try
        // to invoke onboarding inline because the previous start() left a
        // half-spun child + cleanup state that's safer to discard.
        app.relaunch();
      }
      app.exit(0);
      return;
    }

    splash.setStatus("加载界面…");
    mainWindow = createMainWindow(port, {
      onReadyToShow: () => {
        serverManager.off("progress", onProgress);
        splash.close();
      },
    });
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
