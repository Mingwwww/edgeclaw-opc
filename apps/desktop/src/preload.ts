/**
 * Preload script — exposes a minimal `window.edgeclaw` API to the
 * claudecodeui renderer (loaded from http://127.0.0.1:<port>/).
 *
 * The renderer is just a regular web app, so we only expose enough to
 * tell it that it's running inside the desktop shell.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("edgeclaw", {
  isDesktop: true,
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),
  getServerPort: (): Promise<number | null> =>
    ipcRenderer.invoke("get-server-port"),
  getServerStatus: (): Promise<{
    state: "running" | "stopped";
    port: number | null;
  }> => ipcRenderer.invoke("get-server-status"),
});
