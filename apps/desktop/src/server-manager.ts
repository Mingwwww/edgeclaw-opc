/**
 * ServerManager — owns the claudecodeui Express server child process.
 *
 * Adapted from OpenClaw's GatewayManager (apps/electron/src/gateway-manager.ts).
 * Key differences:
 *   - Spawns `node-bin/node claudecodeui/server/index.js` (instead of entry.js gateway)
 *   - Three tarballs to extract (claudecodeui/server resolves edgeclaw-memory-core
 *     via `../../../edgeclaw-memory-core/lib/index.js`, so all three must be siblings):
 *       Resources/claudecodeui-bundle.tar         → Resources/claudecodeui/
 *       Resources/claude-code-main-bundle.tar     → Resources/claude-code-main/
 *       Resources/edgeclaw-memory-core-bundle.tar → Resources/edgeclaw-memory-core/
 *   - Sets BUN_BIN, CLAUDE_CODE_MAIN_DIR so the server can spawn `bun` subprocesses
 *   - claudecodeui /health responds with `{status: "ok", ...}` (not `{ok: true}`)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
const execFile = promisify(execFileCb);
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PORT_START = 18790;
const DEFAULT_PORT_END = 18799;
const PROXY_PORT = 18080;
const HEALTH_POLL_MS = 1500;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;
const SHUTDOWN_SIGTERM_WAIT_MS = 5000;
const ORPHAN_TERM_WAIT_MS = 3000;
const STABLE_RUN_RESET_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000] as const;

// Reasoning models (e.g. MiniMax-M2.7-highspeed, DeepSeek-R1) emit large
// <think>/reasoning blocks that consume the output budget BEFORE the actual
// answer. Anthropic SDK's getMaxOutputTokensForModel falls back to 32_000 for
// unknown model names but a downstream GrowthBook gate (tengu_otk_slot_v1) can
// silently cap that to 8_000. 8k is barely enough room for thinking + a short
// answer; 16k leaves headroom without risking provider rejections (MiniMax
// caps at ~64k, OpenAI-compatible Chat caps at 32k for most providers).
//
// User can override via CLAUDE_CODE_MAX_OUTPUT_TOKENS env or
// agents.main.params.maxOutputTokens in ~/.edgeclaw/config.yaml (the latter is
// wired up in ui/server/services/edgeclawConfig.js → buildRuntimeEnv).
const REASONING_FRIENDLY_MAX_OUTPUT_TOKENS = "16000";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEdgeClawDir(): string {
  return path.join(os.homedir(), ".edgeclaw");
}

function getPidFilePath(): string {
  return path.join(getEdgeClawDir(), "desktop.server.pid");
}

async function ensureEdgeClawDir(): Promise<void> {
  await fs.mkdir(getEdgeClawDir(), { recursive: true });
}

/**
 * Per-version runtime extraction root.
 *
 * macOS protects `/Applications/<App>.app/Contents/Resources/` via SIP+TCC
 * (App Management gate, macOS 14+); writing extracted bundles there works on
 * first launch but can be wiped silently on app upgrade and is technically a
 * violation of Apple's "app bundle is read-only after install" guideline.
 *
 * The proper home is `~/Library/Application Support/<App>/runtime/<version>/`,
 * which is per-user, writable, survives macOS upgrades, and is the standard
 * location Electron's `app.getPath('userData')` resolves to.
 *
 * We key on the EdgeClaw bundle version so that upgrading the app forces a
 * fresh extraction (otherwise stale source files from the previous version
 * would silently win). Old version dirs are GC'd on next startup via
 * `cleanupStaleRuntimeVersions()`.
 */
function getRuntimeBaseDir(version: string): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "EdgeClaw",
    "runtime",
    version,
  );
}

function getCronDaemonSocketPath(): string {
  return path.join(os.homedir(), ".claude", "cron-daemon.sock");
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

function getServerLogPath(): string {
  return path.join(os.homedir(), ".edgeclaw", "desktop.server.log");
}

function readTailSafe(filePath: string, maxBytes: number): string {
  try {
    const stat = fsSync.statSync(filePath);
    const fd = fsSync.openSync(filePath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fsSync.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    return "(no log)";
  }
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

/**
 * Poll http://127.0.0.1:<port>/health until it returns `{status: "ok"}` or
 * we hit the startup timeout.
 *
 * If `child` is provided, we additionally short-circuit the moment the
 * child process exits (exitCode !== null || signalCode !== null). Without
 * this fast-fail, a child that crashes ~10ms after spawn (e.g. because
 * load-env.js threw on missing config) still keeps us polling for the full
 * 60-second deadline before the user sees the error dialog.
 */
async function waitForServerHealth(
  port: number,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Server child exited before becoming healthy (code=${
          child.exitCode ?? "null"
        }, signal=${child.signalCode ?? "null"})`,
      );
    }
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
  /**
   * Bundle version (typically `app.getVersion()`). Used to pick the per-version
   * runtime extraction directory under `~/Library/Application Support/EdgeClaw/
   * runtime/<version>/`. Required when `dev: false` so that upgrading the app
   * forces a fresh re-extraction of bundled tarballs.
   */
  appVersion?: string;
};

export type ServerManagerEvents = {
  ready: [port: number];
  error: [error: Error];
  restarting: [attempt: number];
  "max-restarts": [];
  /**
   * Phase-label updates emitted while start() is in flight. Consumed by
   * the splash window so users get visible feedback during the long
   * first-launch tarball extraction. Strings are user-facing Chinese
   * copy — keep them short (≤ 24 chars) and end-state-shaped (e.g.
   * "解压 claudecodeui (560MB)..." not "Extracting...").
   */
  progress: [phase: string];
};

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private readonly dev: boolean;
  private readonly devRepoRoot: string | undefined;
  private readonly appVersion: string | undefined;

  private child: ChildProcess | null = null;
  private port: number | null = null;
  private stopRequested = false;
  private startPromise: Promise<{ port: number }> | null = null;

  private restartAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlerBound = false;
  /**
   * Set to true while the very first start() is in flight. The exit watchdog
   * checks this and refuses to schedule a restart until the initial start
   * either succeeds or rejects, otherwise an early-crashing child triggers
   * concurrent restart attempts that race against the still-pending health
   * polling loop (and double-emit "error" events).
   */
  private initialStartInFlight = false;

  constructor(options: ServerManagerOptions = {}) {
    super();
    this.dev = options.dev ?? false;
    this.devRepoRoot = options.devRepoRoot;
    this.appVersion = options.appVersion;
  }

  /**
   * Extract a tarball into `<runtimeBaseDir>/<destDirName>/`, idempotent via
   * marker. The marker stores the source tarball mtime+size so that if the
   * bundled tar is updated (e.g. after an in-place reinstall over the same
   * version) we re-extract automatically.
   *
   * Switched from `execSync('tar xf ...')` to `await execFile('tar', ...)`
   * so the Electron main loop can keep handling IPC (in particular the
   * splash window's status-update channel) while the ~700MB total of
   * bundled tarballs is unpacked. Sync extraction blocked the main thread
   * for tens of seconds on cold APFS caches; the splash text would freeze
   * mid-update and users would assume the app crashed.
   */
  private async ensureBundleExtracted(
    tarballSourceDir: string,
    runtimeBaseDir: string,
    tarballName: string,
    destDirName: string,
  ): Promise<string> {
    const destDir = path.join(runtimeBaseDir, destDirName);
    const tarball = path.join(tarballSourceDir, tarballName);
    const marker = path.join(destDir, ".extracted");

    if (!fsSync.existsSync(tarball)) {
      throw new Error(`Bundle not found: ${tarball}`);
    }

    const tarStat = fsSync.statSync(tarball);
    const expectedMarker = `${tarStat.mtimeMs.toFixed(0)}-${tarStat.size}`;

    if (fsSync.existsSync(marker)) {
      try {
        const recorded = fsSync.readFileSync(marker, "utf8").trim();
        if (recorded === expectedMarker) return destDir;
      } catch {
        /* fall through and re-extract */
      }
    }

    // Fresh extract: nuke any partial leftover so we don't merge stale + new
    // payloads (could happen if a previous extraction was interrupted).
    if (fsSync.existsSync(destDir)) {
      this.emit("progress", `清理旧 ${destDirName}…`);
      await fs.rm(destDir, { recursive: true, force: true });
    }
    await fs.mkdir(destDir, { recursive: true });

    // Show size in the progress label so users can roughly estimate how
    // long this phase will take (rule of thumb: ~1MB/100ms on warm SSD).
    const sizeMB = Math.round(tarStat.size / 1024 / 1024);
    this.emit(
      "progress",
      `解压 ${destDirName} (~${sizeMB}MB)…首次安装可能需要 30 秒`,
    );

    await execFile("/usr/bin/tar", ["xf", tarball, "-C", destDir], {
      timeout: 180_000,
      // Don't capture stdout/stderr to memory; tar is intentionally quiet
      // unless something fails, in which case it writes to stderr and
      // exits non-zero — execFile rejects with the stderr captured for us.
      maxBuffer: 1024 * 1024,
    });
    await fs.writeFile(marker, expectedMarker);
    return destDir;
  }

  /**
   * Best-effort cleanup of `~/Library/Application Support/EdgeClaw/runtime/`
   * subdirectories belonging to other versions. Called at startup so that
   * upgrading the app reclaims disk (~1GB per stale version).
   */
  private cleanupStaleRuntimeVersions(currentVersion: string): void {
    const runtimeRoot = path.dirname(getRuntimeBaseDir(currentVersion));
    if (!fsSync.existsSync(runtimeRoot)) return;
    let entries: string[];
    try {
      entries = fsSync.readdirSync(runtimeRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === currentVersion) continue;
      const stalePath = path.join(runtimeRoot, entry);
      try {
        fsSync.rmSync(stalePath, { recursive: true, force: true });
      } catch {
        /* ignore — best-effort GC */
      }
    }
  }

  private async resolvePaths(): Promise<{
    nodeBin: string;
    bunBin: string;
    serverEntry: string;
    serverCwd: string;
    claudeCodeMainDir: string;
  }> {
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
    if (!this.appVersion) {
      throw new Error(
        "ServerManager: appVersion is required for packaged mode (pass app.getVersion() into the constructor)",
      );
    }
    const runtimeBaseDir = getRuntimeBaseDir(this.appVersion);
    fsSync.mkdirSync(runtimeBaseDir, { recursive: true });
    this.emit("progress", "清理旧版本 runtime 缓存…");
    this.cleanupStaleRuntimeVersions(this.appVersion);

    // Order matters only for clarity; resolution at runtime is via ../../../
    // path walks so all three must end up as siblings inside runtimeBaseDir.
    // Each ensureBundleExtracted is awaited *sequentially* (not Promise.all)
    // because: (a) tar is single-threaded I/O bound — parallel extraction
    // saturates the disk and gives no wall-clock win; (b) sequential
    // execution means the splash status label tracks reality (one tarball
    // at a time) instead of showing one phase while three race in the
    // background.
    await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "edgeclaw-memory-core-bundle.tar",
      "edgeclaw-memory-core",
    );
    const claudeCodeUiDir = await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "claudecodeui-bundle.tar",
      "claudecodeui",
    );
    const claudeCodeMainDir = await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "claude-code-main-bundle.tar",
      "claude-code-main",
    );
    return {
      // Native binaries stay under the read-only Resources/ — no need to copy
      // them out (they're already executable + signed in place).
      nodeBin: path.join(resources, "node-bin", "node"),
      bunBin: path.join(resources, "bun-bin", "bun"),
      serverEntry: path.join(claudeCodeUiDir, "server", "index.js"),
      serverCwd: claudeCodeUiDir,
      claudeCodeMainDir,
    };
  }

  // ───────────────────────── Orphan-process cleanup ───────────────────────
  //
  // The claudecodeui server spawns a Bun "cron daemon" as a *detached* sibling
  // (so multiple UI servers across different windows can share state) AND a
  // Bun "proxy" child that listens on PROXY_PORT. Neither is automatically
  // killed when our top-level Node child dies; both can leak across app
  // restarts.
  //
  // We clean up in two places:
  //   • before each spawn (`cleanupOrphanRuntimeProcesses`) so a fresh start
  //     never silently reuses a stale upstream
  //   • after `stop()` so quitting Electron leaves no background processes
  //
  // Strategy: read the cron-daemon `owner.json` for a recorded processId, and
  // probe PROXY_PORT for whoever is listening. Both go through SIGTERM with a
  // short grace period before SIGKILL.

  private async killPidGracefully(pid: number): Promise<void> {
    if (!processExists(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await waitForProcessExit(pid, ORPHAN_TERM_WAIT_MS);
    if (processExists(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Politely shut down the bun cron-daemon via its UNIX socket protocol.
   * Returns true if the daemon acknowledged shutdown (or wasn't running).
   *
   * NOTE: owner.json.processId records the *ui-server* PID (the process that
   * spawned the daemon), NOT the daemon's own PID, so we can't just kill it.
   * The daemon listens on `~/.claude/cron-daemon.sock` and accepts a JSON
   * `{ type: "shutdown" }` request which triggers its own clean exit.
   */
  private async shutdownCronDaemonViaSocket(): Promise<boolean> {
    const socketPath = getCronDaemonSocketPath();
    if (!fsSync.existsSync(socketPath)) return true;
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      let buffer = "";
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2000, () => finish(false));
      socket.once("connect", () => {
        socket.write(JSON.stringify({ type: "shutdown" }) + "\n");
      });
      socket.once("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
          finish(Boolean(reply.ok));
        } catch {
          finish(false);
        }
      });
      socket.once("error", () => finish(false));
    });
  }

  /**
   * pgrep-fallback: if the socket-based shutdown fails (daemon hung, socket
   * stale, etc.), find any bun process whose argv contains the unique
   * "daemonMain(['serve'])" snippet and SIGTERM/SIGKILL it.
   */
  private async killOrphanCronDaemonByPgrep(): Promise<void> {
    let out = "";
    try {
      out = execSync(
        `/usr/bin/pgrep -f "daemonMain\\(\\['serve'\\]\\)" || true`,
        { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      ).toString("utf8");
    } catch {
      return;
    }
    const pids = out
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      await this.killPidGracefully(pid);
    }
  }

  private async killOrphanCronDaemon(): Promise<void> {
    const ok = await this.shutdownCronDaemonViaSocket();
    if (!ok) {
      await this.killOrphanCronDaemonByPgrep();
    }
  }

  private listenerPidForPort(port: number): number | null {
    try {
      // -t = terse (PID only); -i :port -sTCP:LISTEN = TCP LISTEN sockets only.
      const out = execSync(`/usr/sbin/lsof -nP -t -i :${port} -sTCP:LISTEN`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      })
        .toString("utf8")
        .trim();
      if (!out) return null;
      const first = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(first) && first > 0 ? first : null;
    } catch {
      return null;
    }
  }

  private async killOrphanProxy(): Promise<void> {
    const pid = this.listenerPidForPort(PROXY_PORT);
    if (pid === null) return;
    // Avoid suicide: if the listener is the current process tree (shouldn't
    // happen, but be defensive), skip.
    if (pid === process.pid) return;
    await this.killPidGracefully(pid);
  }

  private async cleanupOrphanRuntimeProcesses(): Promise<void> {
    // Order: proxy first (its parent is the cron daemon's child of the
    // previous UI server), then cron daemon.
    await this.killOrphanProxy();
    await this.killOrphanCronDaemon();
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

      // While the very first start is still pending, let the outer
      // startProcessAndWaitReady -> waitForServerHealth() short-circuit
      // path surface the failure (it already collects the log tail and
      // throws via start() -> caller). Skipping watchdog work here keeps
      // us from emitting a duplicate "error" event before the caller's
      // try/catch attaches its handler, and from spawning concurrent
      // restart attempts that race the still-pending health poll loop.
      if (this.initialStartInFlight) return;

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
    // Kill leftover proxy/cron-daemon from a previous (crashed or
    // SIGKILL'd-by-Activity-Monitor) run. ensureEdgeClawProxyRunning() in the
    // ui server otherwise short-circuits when port 18080 is occupied and
    // never gets a chance to attach its stdout pipe, so logs from the stale
    // proxy never reach desktop.server.log.
    await this.cleanupOrphanRuntimeProcesses();

    const chosenPort = await pickAvailablePort();
    // NOTE: proxy port is intentionally NOT overridden here. claudecodeui
    // spawns proxy.ts as a subprocess (in claude-code-main) which loads its
    // own config from ~/.edgeclaw/config.yaml. If we set EDGECLAW_PROXY_PORT
    // here, the parent server waits on the new port but the spawned proxy.ts
    // still binds runtime.proxyPort from yaml → mismatch. Leave proxy port
    // to YAML so parent + child agree.
    this.emit("progress", "准备 runtime 资源…");
    const { nodeBin, bunBin, serverEntry, serverCwd, claudeCodeMainDir } =
      await this.resolvePaths();

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
      // Force loopback regardless of what runtime.host says in YAML.
      // claudecodeui's buildRuntimeEnv now respects pre-set env vars.
      HOST: "127.0.0.1",
      // Ensure spawned `bun` subprocess (claude-code-main cli.tsx) finds the bundled bun
      BUN_BIN: bunBin,
      // Tell claudecodeui where claude-code-main lives
      CLAUDE_CODE_MAIN_DIR: claudeCodeMainDir,
      // Prepend bundled Node + Bun to PATH so any indirect lookups resolve our binaries
      PATH: `${path.dirname(nodeBin)}:${path.dirname(bunBin)}:${
        process.env.PATH ?? ""
      }`,
      // Reasoning-friendly default. Anything already present (env passthrough
      // from launchctl, user shell, or buildRuntimeEnv() reading
      // agents.main.params.maxOutputTokens) wins via the spread above… except
      // process.env doesn't normally carry this var, so this default applies
      // unless overridden. See REASONING_FRIENDLY_MAX_OUTPUT_TOKENS docstring.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS:
        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ??
        REASONING_FRIENDLY_MAX_OUTPUT_TOKENS,
    };

    // Mirror server stdout/stderr to ~/.edgeclaw/desktop.server.log so failures
    // are diagnosable even when the user launches via Finder/Dock (no terminal).
    await ensureEdgeClawDir();
    const logPath = getServerLogPath();
    const logStream = fsSync.createWriteStream(logPath, { flags: "a" });
    logStream.write(
      `\n=== ${new Date().toISOString()} spawn ${serverEntry} (port=${chosenPort}) ===\n`,
    );

    const child = spawn(nodeBin, [serverEntry], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: serverCwd,
      env,
      windowsHide: true,
    });

    if (!child.pid) {
      logStream.end();
      throw new Error("Failed to spawn server process");
    }

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.once("exit", () => {
      logStream.end();
    });

    this.child = child;
    this.exitHandlerBound = false;
    this.attachExitWatchdog();

    await this.writePidFile(child.pid);

    this.emit("progress", "等待本地服务就绪…");
    try {
      await waitForServerHealth(chosenPort, child);
    } catch (err) {
      this.stopRequested = true;
      await this.killChildGracefully();
      await this.removePidFile();
      this.child = null;
      this.stopRequested = false;
      const tail = readTailSafe(logPath, 4000);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n--- server log tail (${logPath}) ---\n${tail}`,
      );
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
    this.initialStartInFlight = true;

    this.startPromise = (async () => {
      try {
        const { port } = await this.startProcessAndWaitReady();
        this.port = port;
        this.initialStartInFlight = false;
        this.emit("ready", port);
        this.scheduleStableReset();
        return { port };
      } catch (e: unknown) {
        this.initialStartInFlight = false;
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
    // The ui-server's SIGTERM handler stops the proxy and (after our
    // edgeclawConfig.js patch) the cron daemon. As a belt-and-suspenders
    // safety net — in case the parent died via SIGKILL, hung past the SIGTERM
    // grace, or the user used `kill -9` from Activity Monitor — sweep any
    // remaining orphans now so quitting EdgeClaw really leaves zero processes.
    await this.cleanupOrphanRuntimeProcesses();
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
