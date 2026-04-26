// EdgeClaw App - Using packaged node_modules
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let serverProcess;

function log(msg) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync('/tmp/edgeclaw-webui.log', `[${timestamp}] ${msg}\n`);
  console.log(msg);
}

function createWindow(serverPort) {
  log('Creating window');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'EdgeClaw',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const url = `http://localhost:${serverPort}/?uiV2=1`;
  log('Loading URL: ' + url);
  mainWindow.loadURL(url);

  mainWindow.webContents.on('did-finish-load', () => {
    log('Web UI loaded');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log('Load failed: ' + errorCode + ' - ' + errorDescription);
  });
}

function startServer() {
  // __dirname in packaged app: Contents/Resources/app/src
  // We need to go up to Contents/Resources: ../../..
  // Then claudecodeui is at Contents/Resources/claudecodeui
  const appPath = app.getAppPath();
  log('App path: ' + appPath);

  // app.getAppPath() returns the path to the app.asar or the unpacked app
  // For our structure, we need to find claudecodeui
  let claudeCodeUI;
  let distDir;

  if (app.isPackaged) {
    // In packaged app, extraResources are at Contents/Resources/
    const resourcesPath = path.join(path.dirname(appPath), '..', 'Resources');
    claudeCodeUI = path.join(resourcesPath, 'claudecodeui');
    distDir = path.join(claudeCodeUI, 'dist');
    log('Packaged mode - Resources: ' + resourcesPath);
  } else {
    // Development mode
    claudeCodeUI = '/Users/da/ws/edgeclaw-test-0422/claudecodeui';
    distDir = path.join(claudeCodeUI, 'dist');
    log('Dev mode');
  }

  log('claudecodeui: ' + claudeCodeUI);
  log('claudecodeui exists: ' + fs.existsSync(claudeCodeUI));

  if (!fs.existsSync(claudeCodeUI)) {
    log('ERROR: claudecodeui not found');
    return;
  }

  const nodePath = process.execPath;
  log('Using Node: ' + nodePath);

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    SERVER_PORT: '3001'
  };

  log('Starting server...');
  serverProcess = spawn(nodePath, ['server/index.js'], {
    cwd: claudeCodeUI,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let serverReady = false;

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    log('[SERVER] ' + text.trim());
    if (!serverReady && (text.includes('listening') || text.includes('Server running') || text.includes('started'))) {
      serverReady = true;
      log('Server ready, creating window...');
      setTimeout(() => createWindow(3001), 2000);
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const text = data.toString();
    log('[SERVER ERR] ' + text.trim());
  });

  serverProcess.on('close', (code) => {
    log('[SERVER] Exit code: ' + code);
  });

  serverProcess.on('error', (err) => {
    log('[SERVER ERROR] ' + err.message);
  });

  setTimeout(() => {
    if (!serverReady) {
      log('Server startup timeout');
      createWindow(3001);
    }
  }, 30000);
}

log('App starting, isPackaged: ' + app.isPackaged);
startServer();

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) startServer();
});