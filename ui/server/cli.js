#!/usr/bin/env node
/**
 * pilotdeck CLI
 *
 * One-command deploy: auto-installs deps, detects conflicts, validates config,
 * opens a browser-based setup wizard when needed, then boots the full server.
 *
 * Commands:
 *   (no args)     - Start the server (default)
 *   start         - Start the server
 *   status        - Show configuration and data locations
 *   help          - Show help information
 *   version       - Show version information
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
    getEdgeClawConfigFilePath,
    getMissingEdgeClawEnvKeys,
    hasEdgeClawConfigFile,
    loadRootEdgeClawEnv,
} from './load-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
};

// Helper to colorize text
const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    error: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Load package.json for version info
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Get the database path (same logic as db.js)
function getDatabasePath() {
    loadRootEdgeClawEnv();
    return process.env.DATABASE_PATH || path.join(__dirname, 'database', 'auth.db');
}

// Get the installation directory
function getInstallDir() {
    return path.join(__dirname, '..');
}

// Show status command
function showStatus() {
    loadRootEdgeClawEnv();

    console.log(`\n${c.bright('pilotdeck - Status')}\n`);
    console.log(c.dim('═'.repeat(60)));

    console.log(`\n${c.info('[INFO]')} Version: ${c.bright(packageJson.version)}`);

    const installDir = getInstallDir();
    console.log(`\n${c.info('[INFO]')} Installation Directory:`);
    console.log(`       ${c.dim(installDir)}`);

    const dbPath = getDatabasePath();
    const dbExists = fs.existsSync(dbPath);
    console.log(`\n${c.info('[INFO]')} Database Location:`);
    console.log(`       ${c.dim(dbPath)}`);
    console.log(`       Status: ${dbExists ? c.ok('[OK] Exists') : c.warn('[WARN] Not created yet (will be created on first run)')}`);

    if (dbExists) {
        const stats = fs.statSync(dbPath);
        console.log(`       Size: ${c.dim((stats.size / 1024).toFixed(2) + ' KB')}`);
        console.log(`       Modified: ${c.dim(stats.mtime.toLocaleString())}`);
    }

    const missingConfig = getMissingEdgeClawEnvKeys();
    console.log(`\n${c.info('[INFO]')} Configuration:`);
    console.log(`       SERVER_PORT: ${c.bright(process.env.SERVER_PORT || process.env.PORT || '3001')} ${c.dim(process.env.SERVER_PORT || process.env.PORT ? '' : '(default)')}`);
    console.log(`       DATABASE_PATH: ${c.dim(process.env.DATABASE_PATH || '(using default location)')}`);
    console.log(`       EDGECLAW_API_BASE_URL: ${normalizeConfiguredValue(process.env.EDGECLAW_API_BASE_URL)}`);
    console.log(`       EDGECLAW_API_KEY: ${maskConfiguredSecret(process.env.EDGECLAW_API_KEY)}`);
    console.log(`       EDGECLAW_MODEL: ${normalizeConfiguredValue(process.env.EDGECLAW_MODEL)}`);
    console.log(`       Required Config: ${missingConfig.length === 0 ? c.ok('[OK] Complete') : c.warn(`[WARN] Missing ${missingConfig.join(', ')}`)}`);

    const configFilePath = getEdgeClawConfigFilePath();
    const configExists = hasEdgeClawConfigFile();
    console.log(`\n${c.info('[INFO]')} Configuration File:`);
    console.log(`       ${c.dim(configFilePath)}`);
    console.log(`       Status: ${configExists ? c.ok('[OK] Exists') : c.warn('[WARN] Not found')}`);

    console.log('\n' + c.dim('═'.repeat(60)));
    console.log(`\n${c.tip('[TIP]')} Hints:`);
    console.log(`      ${c.dim('>')} Use ${c.bright('pilotdeck --port 8080')} to run on a custom port`);
    console.log(`      ${c.dim('>')} Use ${c.bright('pilotdeck --database-path /path/to/db')} for custom database`);
    console.log(`      ${c.dim('>')} Run ${c.bright('pilotdeck help')} for all options`);
    console.log(`      ${c.dim('>')} Access the UI at http://localhost:${process.env.SERVER_PORT || process.env.PORT || '3001'}\n`);
}

// Show help
function showHelp() {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              pilotdeck - Command Line Tool                   ║
╚═══════════════════════════════════════════════════════════════╝

Usage:
  pilotdeck [command] [options]

Commands:
  start          Start the server (default)
  status         Show configuration and data locations
  update         Update to the latest version
  help           Show this help information
  version        Show version information

Options:
  -p, --port <port>           Set server port (default: 3001)
  --database-path <path>      Set custom database location
  -h, --help                  Show this help information
  -v, --version               Show version information

Examples:
  $ pilotdeck                        # Start with defaults
  $ pilotdeck --port 8080            # Start on port 8080
  $ pilotdeck -p 3000                # Short form for port
  $ pilotdeck start --port 4000      # Explicit start command
  $ pilotdeck status                 # Show configuration

Configuration:
  Edit ~/.edgeclaw/config.yaml directly or from Settings -> Config in the UI.
  First run will auto-open a browser setup wizard if no config exists.

Documentation:
  ${packageJson.homepage || 'https://github.com/siteboon/claudecodeui'}

Report Issues:
  ${packageJson.bugs?.url || 'https://github.com/siteboon/claudecodeui/issues'}
`);
}

// Show version
function showVersion() {
    console.log(`${packageJson.version}`);
}

// Compare semver versions, returns true if v1 > v2
function isNewerVersion(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (parts1[i] > parts2[i]) return true;
        if (parts1[i] < parts2[i]) return false;
    }
    return false;
}

// Check for updates
async function checkForUpdates(silent = false) {
    try {
        const { execSync } = await import('child_process');
        const latestVersion = execSync('npm show pilotdeck version 2>/dev/null || npm show @cloudcli-ai/cloudcli version', { encoding: 'utf8' }).trim();
        const currentVersion = packageJson.version;

        if (isNewerVersion(latestVersion, currentVersion)) {
            console.log(`\n${c.warn('[UPDATE]')} New version available: ${c.bright(latestVersion)} (current: ${currentVersion})`);
            console.log(`         Run ${c.bright('pilotdeck update')} to update\n`);
            return { hasUpdate: true, latestVersion, currentVersion };
        } else if (!silent) {
            console.log(`${c.ok('[OK]')} You are on the latest version (${currentVersion})`);
        }
        return { hasUpdate: false, latestVersion, currentVersion };
    } catch (e) {
        if (!silent) {
            console.log(`${c.warn('[WARN]')} Could not check for updates`);
        }
        return { hasUpdate: false, error: e.message };
    }
}

// Update the package
async function updatePackage() {
    try {
        const { execSync } = await import('child_process');
        console.log(`${c.info('[INFO]')} Checking for updates...`);

        const { hasUpdate, latestVersion, currentVersion } = await checkForUpdates(true);

        if (!hasUpdate) {
            console.log(`${c.ok('[OK]')} Already on the latest version (${currentVersion})`);
            return;
        }

        console.log(`${c.info('[INFO]')} Updating from ${currentVersion} to ${latestVersion}...`);
        execSync('npm update -g pilotdeck || npm update -g @cloudcli-ai/cloudcli', { stdio: 'inherit' });
        console.log(`${c.ok('[OK]')} Update complete! Restart pilotdeck to use the new version.`);
    } catch (e) {
        console.error(`${c.error('[ERROR]')} Update failed: ${e.message}`);
        console.log(`${c.tip('[TIP]')} Try running manually: npm update -g pilotdeck`);
    }
}

// Start the server with preflight checks
async function startServer() {
    console.log(`\n${c.bright('pilotdeck')} starting...\n`);

    // Phase A+B: Preflight (dependencies + port conflicts)
    const { runPreflight } = await import('./preflight.js');
    const pre = await runPreflight({
        cliRoot: __dirname,
        serverPort: process.env.SERVER_PORT || '3001',
    });
    if (!pre.ok) {
        console.error(`${c.error('[ERROR]')} ${pre.error}`);
        process.exit(1);
    }

    // Boot full server — config setup is handled in-browser via Onboarding
    checkForUpdates(true);
    await import('./index.js');
}

// Parse CLI arguments
function parseArgs(args) {
    const parsed = { command: 'start', options: {} };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--port' || arg === '-p') {
            parsed.options.serverPort = args[++i];
        } else if (arg.startsWith('--port=')) {
            parsed.options.serverPort = arg.split('=')[1];
        } else if (arg === '--database-path') {
            parsed.options.databasePath = args[++i];
        } else if (arg.startsWith('--database-path=')) {
            parsed.options.databasePath = arg.split('=')[1];
        } else if (arg === '--help' || arg === '-h') {
            parsed.command = 'help';
        } else if (arg === '--version' || arg === '-v') {
            parsed.command = 'version';
        } else if (!arg.startsWith('-')) {
            parsed.command = arg;
        }
    }

    return parsed;
}

// Main CLI handler
async function main() {
    const args = process.argv.slice(2);
    const { command, options } = parseArgs(args);

    // Apply CLI options to environment variables
    if (options.serverPort) {
        process.env.SERVER_PORT = options.serverPort;
    } else if (!process.env.SERVER_PORT && process.env.PORT) {
        process.env.SERVER_PORT = process.env.PORT;
    }
    if (options.databasePath) {
        process.env.DATABASE_PATH = options.databasePath;
    }

    switch (command) {
        case 'start':
            await startServer();
            break;
        case 'status':
        case 'info':
            showStatus();
            break;
        case 'help':
        case '-h':
        case '--help':
            showHelp();
            break;
        case 'version':
        case '-v':
        case '--version':
            showVersion();
            break;
        case 'update':
            await updatePackage();
            break;
        default:
            console.error(`\n❌ Unknown command: ${command}`);
            console.log('   Run "pilotdeck help" for usage information.\n');
            process.exit(1);
    }
}

// Run the CLI
main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});

function normalizeConfiguredValue(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized ? c.dim(normalized) : c.warn('[missing]');
}

function maskConfiguredSecret(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized ? c.dim('[set]') : c.warn('[missing]');
}
