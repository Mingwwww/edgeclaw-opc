import { plugin } from 'bun';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';

// Stub the bun:bundle module which is only available at build/bundle time.
// feature() returns false for most flags so gated code paths are skipped at
// runtime. Keep the daemon fast-path enabled in source mode so local dev can
// exercise `claude daemon ...` without a bundled build.
plugin({
  name: 'bun-bundle-stub',
  setup(build) {
    build.module('bun:bundle', () => ({
      exports: {
        feature: (name: string) => name === 'DAEMON',
      },
      loader: 'object',
    }));

    build.onLoad({ filter: /\.md$/ }, async (args) => ({
      contents: `export default ${JSON.stringify(await Bun.file(args.path).text())}`,
      loader: 'js',
    }));
  },
});

(globalThis as any).MACRO = {
  VERSION: '1.0.100',
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: '@anthropic-ai/claude-code',
  NATIVE_PACKAGE_URL: '@anthropic-ai/claude-code-native',
  FEEDBACK_CHANNEL: 'claude-code-dev',
  ISSUES_EXPLAINER: '',
  VERSION_CHANGELOG: '',
};

// ── Embedded CCR (Claude Code Router) — Zero-port mode ──────────────────────
// Intercepts fetch() in-process. No HTTP server, no port, no network overhead.
// Skip with CCR_DISABLED=1 or when ANTHROPIC_BASE_URL is already set externally.
const CCR_SENTINEL = 'http://ccr.local';
const CCR_DAEMON_FETCH_INTERCEPTOR = 'CCR_DAEMON_FETCH_INTERCEPTOR';

function isEnvDisabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isEnvTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function isDaemonPreloadContext(
  runtimeArgs = [...process.argv, ...process.execArgv],
): boolean {
  return runtimeArgs.some((arg) => (
    arg === 'daemon' ||
    arg === '--daemon-worker' ||
    arg.includes('daemonMain([') ||
    arg.includes('runDaemonWorker(')
  ));
}

export function shouldInstallCcrInterceptor(
  env: Record<string, string | undefined> = process.env,
  runtimeArgs = [...process.argv, ...process.execArgv],
): boolean {
  if (isEnvDisabled(env.CCR_DISABLED)) return false;
  if (
    env.ANTHROPIC_BASE_URL &&
    env.ANTHROPIC_BASE_URL !== CCR_SENTINEL
  ) {
    return false;
  }

  if (!isDaemonPreloadContext(runtimeArgs)) return true;

  return (
    env.ANTHROPIC_BASE_URL === CCR_SENTINEL ||
    isEnvTruthy(env[CCR_DAEMON_FETCH_INTERCEPTOR])
  );
}

if (shouldInstallCcrInterceptor()) {
  const DIR = dirname(new URL(import.meta.url).pathname);

  // Resolve CCR config: YAML (~/.edgeclaw/config.yaml) first, ccr-config.json fallback
  let config: any = null;
  try {
    const { loadEdgeClawConfig, buildCcrConfigFromEdgeClawConfig } = await import('./edgeclaw-config');
    const yamlConfig = loadEdgeClawConfig();
    if (yamlConfig?.router?.enabled) {
      config = buildCcrConfigFromEdgeClawConfig(yamlConfig);
    }
  } catch {}
  if (!config) {
    const configPath = resolve(DIR, 'ccr-config.json');
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
    }
  }

  if (config) {
    const routerDir = resolve(DIR, 'src/router');
    const cjsPath = resolve(routerDir, 'server.cjs');
    const buildScript = resolve(routerDir, 'build.mjs');

    function newestMtime(dir: string, ext = '.ts'): number {
      let newest = 0;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = `${dir}/${entry.name}`;
          if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, ext));
          else if (entry.name.endsWith(ext)) newest = Math.max(newest, statSync(full).mtimeMs);
        }
      } catch {}
      return newest;
    }

    if (existsSync(resolve(routerDir, 'src/server.ts')) && existsSync(buildScript)) {
      const cjsMtime = existsSync(cjsPath) ? statSync(cjsPath).mtimeMs : 0;
      const srcMtime = Math.max(
        newestMtime(resolve(routerDir, 'src')),
        newestMtime(resolve(routerDir, 'shared')),
      );
      if (srcMtime > cjsMtime || cjsMtime === 0) {
        console.error('[CCR] Source newer than bundle — rebuilding...');
        execSync('node build.mjs', { cwd: routerDir, stdio: 'inherit' });
        console.error('[CCR] Rebuild complete');
      }
    }

    if (existsSync(cjsPath)) {
      try {
        const CCR = require(cjsPath);
        const Server = CCR.default;

        const server = new Server({
          initialConfig: {
            providers: config.Providers,
            Router: config.Router,
            tokenStats: config.tokenStats,
            API_TIMEOUT_MS: config.API_TIMEOUT_MS,
            HOST: config.HOST || '127.0.0.1',
            PORT: 0,
            LOG: config.LOG ?? false,
          },
          logger: config.LOG !== false && process.env.CCR_LOG === '1',
        });

        await server.init();

        CCR.installFetchInterceptor(CCR_SENTINEL, {
          configService: server.configService,
          providerService: server.providerService,
          transformerService: server.transformerService,
          tokenizerService: server.tokenizerService,
          logger: process.env.CCR_LOG === '1'
            ? { info: (...a: any[]) => console.log('[CCR]', ...a),
                warn: (...a: any[]) => console.warn('[CCR]', ...a),
                error: (...a: any[]) => console.error('[CCR]', ...a),
                debug: () => {} }
            : { info: () => {},
                warn: (...a: any[]) => console.warn('[CCR]', ...a),
                error: (...a: any[]) => console.error('[CCR]', ...a),
                debug: () => {} },
        });

        process.env.ANTHROPIC_BASE_URL = CCR_SENTINEL;
        process.env.ANTHROPIC_API_KEY ??= 'dummy-key-for-ccr';
        console.error('[CCR] Router ready (zero-port mode, fetch interceptor)');

        (globalThis as any).__ccrServer = server;
        (globalThis as any).__ccrModule = CCR;
      } catch (err: any) {
        console.warn(`[CCR] Failed to start embedded router: ${err.message}`);
        console.warn('[CCR] Continuing without router — requests go directly to Anthropic API');
      }
    }
  }
}
