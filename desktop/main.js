/**
 * Auto Apply Bot — Electron Main Process
 *
 * Launches backend services (FastAPI, Redis, Celery), serves the React
 * frontend in a BrowserWindow, provides a system tray icon, and supports
 * auto-updates via electron-updater.
 */

const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const path = require("path");
const log = require("electron-log");
const { autoUpdater } = require("electron-updater");
const { startAll, stopAll, resourcePath } = require("./services");
const { createTray, destroyTray } = require("./tray");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
log.transports.file.level = "info";
autoUpdater.logger = log;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
/** @type {BrowserWindow | null} */
let mainWindow = null;
const isDev = process.argv.includes("--dev");
const BACKEND_URL = "http://localhost:8000";
const FRONTEND_DEV_URL = "http://localhost:5173";

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Auto Apply Bot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false, // show after ready-to-show to avoid flash
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // In dev mode, load the Vite dev server; in production, load the built files.
  if (isDev) {
    mainWindow.loadURL(FRONTEND_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const frontendPath = path.join(resourcePath("frontend"), "index.html");
    mainWindow.loadFile(frontendPath);
  }

  // Minimize to tray instead of closing
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIPC() {
  ipcMain.handle("get-version", () => app.getVersion());
  ipcMain.handle("get-api-url", () => BACKEND_URL);
  ipcMain.on("minimize-to-tray", () => mainWindow?.hide());
  ipcMain.on("install-update", () => autoUpdater.quitAndInstall());
}

// ---------------------------------------------------------------------------
// Auto-updater
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
  if (isDev) return; // skip in dev mode

  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info.version);
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info.version);
    mainWindow?.webContents.send("update-downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err.message);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  log.info(`Auto Apply Bot v${app.getVersion()} starting (dev=${isDev})`);

  // Start backend services (skip in dev if user runs them externally)
  if (!isDev) {
    startAll();
  }

  registerIPC();
  createWindow();

  createTray(mainWindow, () => {
    app.isQuitting = true;
    app.quit();
  });

  setupAutoUpdater();

  app.on("activate", () => {
    // macOS: re-show window when dock icon clicked
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS keep the app running in the tray
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  destroyTray();
  stopAll();
});
