/**
 * Preload script — exposes minimal APIs to two different renderers:
 *
 *   1. `window.edgeclaw` — for the claudecodeui renderer (loaded from
 *      http://127.0.0.1:<port>/). Tells it that it's running inside the
 *      desktop shell.
 *   2. `window.edgeclawOnboarding` — for the first-run onboarding HTML.
 *      Lets it persist user-entered API credentials and quit the app.
 *
 * The same preload runs in both windows; only the relevant API surface is
 * actually used by each.
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

contextBridge.exposeInMainWorld("edgeclawOnboarding", {
  save: (payload: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke("onboarding:save", payload),
  cancel: (): void => ipcRenderer.send("onboarding:cancel"),
});
