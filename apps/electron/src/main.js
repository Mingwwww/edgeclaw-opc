// EdgeClaw App - Test Version
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const APP_DIR = path.dirname(SCRIPT_DIR);
const PROJECT_ROOT = path.dirname(APP_DIR);
const HTML_PATH = path.join(SCRIPT_DIR, 'index.html');

const BUN_PATHS = [
  '/Users/da/.bun/bin/bun',
  '/opt/homebrew/bin/bun',
  'bun',
];

let mainWindow;

function findBun() {
  for (const p of BUN_PATHS) {
    try {
      if (p === 'bun') return 'bun';
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return 'bun';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'EdgeClaw',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(HTML_PATH);

  mainWindow.webContents.on('did-finish-load', () => {
    testBun();
  });
}

function testBun() {
  const bunExe = findBun();
  mainWindow.webContents.executeJavaScript(`window.appendOutput('Testing Bun at: ${bunExe}\\n', false, true)`);

  // Test 1: bun --version
  const versionProc = spawn(bunExe, ['--version'], { cwd: PROJECT_ROOT });
  versionProc.stdout.on('data', (d) => {
    mainWindow.webContents.executeJavaScript(`window.appendOutput('bun --version: ' + ${JSON.stringify(d.toString())} + '\\n')`);
  });
  versionProc.stderr.on('data', (d) => {
    mainWindow.webContents.executeJavaScript(`window.appendOutput('[stderr] ' + ${JSON.stringify(d.toString())}, true)`);
  });

  // Test 2: run a simple script
  mainWindow.webContents.executeJavaScript(`window.appendOutput('\\nRunning test script...\\n', false, true)`);
  const testProc = spawn(bunExe, ['-e', 'console.log("Hello from Bun!"); console.log("CWD:", process.cwd());'], { cwd: PROJECT_ROOT });
  testProc.stdout.on('data', (d) => {
    mainWindow.webContents.executeJavaScript(`window.appendOutput(${JSON.stringify(d.toString())})`);
  });
  testProc.stderr.on('data', (d) => {
    mainWindow.webContents.executeJavaScript(`window.appendOutput(${JSON.stringify(d.toString())}, true)`);
  });
  testProc.on('close', (code) => {
    mainWindow.webContents.executeJavaScript(`window.appendOutput('\\n[Test script exited with code ' + ${code} + ']\\n', false, true)`);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });