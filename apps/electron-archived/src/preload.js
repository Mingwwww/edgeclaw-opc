// Preload script for EdgeClaw
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edgeclaw', {
  onOutput: (callback) => ipcRenderer.on('cli-output', (event, data) => callback(data))
});