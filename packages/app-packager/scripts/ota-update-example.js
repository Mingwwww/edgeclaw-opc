// ============================================================================
// OTA Auto-Update Support for Electron
// ============================================================================
// This file shows how to integrate electron-updater for automatic updates.
// Include in your Electron main process.
// ============================================================================

const { app, autoUpdater } = require('electron-updater');

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Optional: Use custom update server
// autoUpdater.setFeedURL({
//   provider: 'generic',
//   url: 'https://your-update-server.com/releases/'
// });

// Events
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  // Show notification to user
  // autoUpdater.downloadUpdate();
});

autoUpdater.on('update-not-available', () => {
  console.log('No updates available');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`Download: ${progress.percent.toFixed(1)}%`);
});

autoUpdater.on('update-downloaded', () => {
  console.log('Update ready - restart to install');
});

autoUpdater.on('error', (err) => {
  console.error('Update error:', err);
});

// Check for updates on app ready
app.whenReady().then(() => {
  // Only check in production
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(console.error);
  }
});

module.exports = { autoUpdater };