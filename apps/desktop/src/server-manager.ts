/**
 * ServerManager — owns the claudecodeui Express server child process.
 *
 * Adapted from OpenClaw's GatewayManager (apps/electron/src/gateway-manager.ts).
 * Key differences:
 *   - Spawns `node-bin/node claudecodeui/server/index.js` (instead of entry.js gateway)
 *   - Two tarballs to extract:
 *       Resources/claudecodeui-bundle.tar      → Resources/claudecodeui/
 *       Resources/claude-code-main-bundle.tar  → Resources/claude-code-main/
 *   - Sets BUN_BIN, CLAUDE_CODE_MAIN_DIR so the server can spawn `bun` subprocesses
 *   - claudecodeui /health responds with `{status: "ok", ...}` (not `{ok: true}`)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PORT_START = 18790;
const DEFAULT_PORT_END = 18799;
const HEALTH_POLL_MS = 1500;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;
const SHUTDOWN_SIGTERM_WAIT_MS = 5000;
const STABLE_RUN_RESET_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPidFilePath(): string {
  return path.join(os.homedir(), ".edgeclaw", "desktop.server.pid");
}

async function ensureEdgeClawDir(): Promise<void> {
  await fs.mkdir(path.join(os.homedir(), ".edgeclaw"), { recursive: true });
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickAvailablePort(): Promise<number> {
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free desktop server port in range ${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`,
  );
}

async function readPidFile(): Promise<number | null> {
  try {
    const raw = await fs.readFile(getPidFilePath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function waitForProcessExit(pid: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(50);
  }
}

async function cleanupStaleOrOrphanPid(): Promise<void> {
  const pid = await readPidFile();
  if (pid === null) return;
  if (!processExists(pid)) {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  await waitForProcessExit(pid, SHUTDOWN_SIGTERM_WAIT_MS);
  if (processExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    await fs.unlink(getPidFilePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function waitForServerHealth(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body && body.status === "ok") return;
      }
    } catch {
      /* retry until deadline */
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(
    `Server health check failed within ${STARTUP_HEALTH_TIMEOUT_MS}ms`,
  );
}

export type ServerManagerOptions = {
  /**
   * When true, spawns from the dev source tree.
   * When false (packaged app), uses `process.resourcesPath` from Electron.
   */
  dev?: boolean;
  /**
   * Repo root (the parent of `claudecodeui/` and `claude-code-main/`).
   * Required when `dev: true`.
   */
  devRepoRoot?: string;
};

export type ServerManagerEvents = {
  ready: [port: number];
  error: [error: Error];
  restarting: [attempt: number];
  "max-restarts": [];
};

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private readonly dev: boolean;
  private readonly devRepoRoot: string | undefined;

  private child: ChildProcess | null = null;
  private port: number | null = null;
  private stopRequested = false;
  private startPromise: Promise<{ port: number }> | null = null;

  private restartAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlerBound = false;

  constructor(options: ServerManagerOptions = {}) {
    super();
    this.dev = options.dev ?? false;
    this.devRepoRoot = options.devRepoRoot;
  }

  /**
   * Extract a tarball into `<resources>/<destDirName>/`, idempotent via marker.
   */
  private ensureBundleExtracted(
    resources: string,
    tarballName: string,
    destDirName: string,
  ): string {
    const destDir = path.join(resources, destDirName);
    const tarball = path.join(resources, tarballName);
    const marker = path.join(destDir, ".extracted");

    if (fsSync.existsSync(marker)) return destDir;

    if (!fsSync.existsSync(tarball)) {
      throw new Error(`Bundle not found: ${tarball}`);
    }

    fsSync.mkdirSync(destDir, { recursive: true });
    execSync(`tar xf "${tarball}" -C "${destDir}"`, {
      stdio: "ignore",
      timeout: 120_000,
    });
    fsSync.writeFileSync(marker, new Date().toISOString());
    return destDir;
  }

  private resolvePaths(): {
    nodeBin: string;
    bunBin: string;
    serverEntry: string;
    serverCwd: string;
    claudeCodeMainDir: string;
  } {
    if (this.dev) {
      const root = this.devRepoRoot;
      if (!root)
        throw new Error("ServerManager: devRepoRoot is required when dev=true");
      return {
        nodeBin: path.join(
          root,
          "apps",
          "desktop",
          "resources",
          "node-bin",
          "node",
        ),
        bunBin: path.join(
          root,
          "apps",
          "desktop",
          "resources",
          "bun-bin",
          "bun",
        ),
        serverEntry: path.join(root, "claudecodeui", "server", "index.js"),
        serverCwd: path.join(root, "claudecodeui"),
        claudeCodeMainDir: path.join(root, "claude-code-main"),
      };
    }
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    const resources = typeof resourcesPath === "string" ? resourcesPath : "";
    if (!resources) {
      throw new Error(
        "ServerManager: process.resourcesPath unavailable; pass dev/devRepoRoot or run under Electron",
      );
    }
    const claudeCodeUiDir = this.ensureBundleExtracted(
      resources,
      "claudecodeui-bundle.tar",
      "claudecodeui",
    );
    const claudeCodeMainDir = this.ensureBundleExtracted(
      resources,
      "claude-code-main-bundle.tar",
      "claude-code-main",
    );
    return {
      nodeBin: path.join(resources, "node-bin", "node"),
      bunBin: path.join(resources, "bun-bin", "bun"),
      serverEntry: path.join(claudeCodeUiDir, "server", "index.js"),
      serverCwd: claudeCodeUiDir,
      claudeCodeMainDir,
    };
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, STABLE_RUN_RESET_MS);
  }

  private attachExitWatchdog(): void {
    if (!this.child || this.exitHandlerBound) return;
    this.exitHandlerBound = true;
    this.child.once("exit", (code, signal) => {
      this.exitHandlerBound = false;
      this.child = null;
      this.clearStableTimer();

      if (this.stopRequested) return;

      const err = new Error(
        `Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      this.emit("error", err);

      if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        this.emit("max-restarts");
        this.port = null;
        return;
      }

      const attempt = this.restartAttempts + 1;
      this.emit("restarting", attempt);
      const delay =
        RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)] ??
        RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];

      void (async () => {
        await sleep(delay);
        if (this.stopRequested) return;
        this.restartAttempts = attempt;
        try {
          const { port } = await this.startProcessAndWaitReady();
          this.port = port;
          this.emit("ready", port);
          this.scheduleStableReset();
        } catch (e: unknown) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
          this.port = null;
        }
      })();
    });
  }

  private async writePidFile(pid: number): Promise<void> {
    await ensureEdgeClawDir();
    await fs.writeFile(getPidFilePath(), `${pid}\n`, "utf8");
  }

  private async removePidFile(): Promise<void> {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async startProcessAndWaitReady(): Promise<{ port: number }> {
    await cleanupStaleOrOrphanPid();

    const chosenPort = await pickAvailablePort();
    const { nodeBin, bunBin, serverEntry, serverCwd, claudeCodeMainDir } =
      this.resolvePaths();

    if (!fsSync.existsSync(nodeBin)) {
      throw new Error(`Bundled Node not found at ${nodeBin}`);
    }
    if (!fsSync.existsSync(serverEntry)) {
      throw new Error(`Server entry not found at ${serverEntry}`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      SERVER_PORT: String(chosenPort),
      // Ensure spawned `bun` subprocess (claude-code-main cli.tsx) finds the bundled bun
      BUN_BIN: bunBin,
      // Tell claudecodeui where claude-code-main lives
      CLAUDE_CODE_MAIN_DIR: claudeCodeMainDir,
      // Prepend bundled Node + Bun to PATH so any indirect lookups resolve our binaries
      PATH: `${path.dirname(nodeBin)}:${path.dirname(bunBin)}:${
        process.env.PATH ?? ""
      }`,
    };

    const child = spawn(nodeBin, [serverEntry], {
      stdio: ["ignore", "inherit", "inherit"],
      cwd: serverCwd,
      env,
      windowsHide: true,
    });

    if (!child.pid) throw new Error("Failed to spawn server process");

    this.child = child;
    this.exitHandlerBound = false;
    this.attachExitWatchdog();

    await this.writePidFile(child.pid);

    try {
      await waitForServerHealth(chosenPort);
    } catch (err) {
      this.stopRequested = true;
      await this.killChildGracefully();
      await this.removePidFile();
      this.child = null;
      this.stopRequested = false;
      throw err;
    }

    return { port: chosenPort };
  }

  private async killChildGracefully(): Promise<void> {
    const proc = this.child;
    if (!proc || !proc.pid) return;
    const pid = proc.pid;

    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }

    const deadline = Date.now() + SHUTDOWN_SIGTERM_WAIT_MS;
    while (Date.now() < deadline) {
      if (!processExists(pid)) return;
      await sleep(50);
    }

    if (processExists(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  start(): Promise<{ port: number }> {
    if (this.startPromise) return this.startPromise;

    this.stopRequested = false;
    this.restartAttempts = 0;

    this.startPromise = (async () => {
      try {
        const { port } = await this.startProcessAndWaitReady();
        this.port = port;
        this.emit("ready", port);
        this.scheduleStableReset();
        return { port };
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.emit("error", err);
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearStableTimer();
    this.child?.removeAllListeners("exit");

    await this.killChildGracefully();
    this.child = null;
    this.port = null;

    await this.removePidFile();
    this.stopRequested = false;
  }

  getPort(): number | null {
    return this.port;
  }

  isRunning(): boolean {
    const c = this.child;
    return c !== null && c.exitCode === null && c.signalCode === null;
  }
}
