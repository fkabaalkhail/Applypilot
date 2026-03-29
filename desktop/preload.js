/**
 * Preload script — exposes a minimal API to the renderer process.
 *
 * Keeps the renderer sandboxed while allowing it to query app metadata
 * and request window actions through a safe bridge.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /** Get the app version string. */
  getVersion: () => ipcRenderer.invoke("get-version"),

  /** Get the backend API base URL. */
  getApiUrl: () => ipcRenderer.invoke("get-api-url"),

  /** Minimize the window to the system tray. */
  minimizeToTray: () => ipcRenderer.send("minimize-to-tray"),

  /** Listen for update-available events from the auto-updater. */
  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  /** Listen for update-downloaded events. */
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("update-downloaded", (_event, info) => callback(info));
  },

  /** Trigger install of a downloaded update (restarts the app). */
  installUpdate: () => ipcRenderer.send("install-update"),
});
