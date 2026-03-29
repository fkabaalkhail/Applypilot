/**
 * System Tray — provides quick access to Dashboard, status info, and quit.
 */

const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

/** @type {Tray | null} */
let tray = null;

/**
 * Create the system tray icon and context menu.
 *
 * @param {import("electron").BrowserWindow} mainWindow
 * @param {() => void} onQuit
 */
function createTray(mainWindow, onQuit) {
  const iconPath = path.join(__dirname, "icon.png");
  let image;
  try {
    image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    // Fallback: create a tiny 1×1 transparent image so the tray still works
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image);
  tray.setToolTip("Auto Apply Bot");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Dashboard",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Status: Running",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit Auto Apply Bot",
      click: onQuit,
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click on tray icon opens the window
  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

/** Destroy the tray icon. */
function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
