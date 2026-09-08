const RELEASES_URL = "https://github.com/Rex0519/simhammer/releases";

// macOS cannot install an update in place unless the app is signed with a
// Developer ID certificate (Squirrel.Mac validates the signature). This fork
// ships unsigned macOS builds, so on darwin the "install" action opens the
// release's DMG in the browser and the user drags the app over the old one.
function dmgDownloadUrl(info) {
  const dmg = (info?.files || []).map((f) => f.url).find((u) => /\.dmg$/i.test(u || ""));
  if (!dmg || !info?.version) return `${RELEASES_URL}/latest`;
  return `${RELEASES_URL}/download/v${info.version}/${encodeURIComponent(dmg)}`;
}

function setupAutoUpdater(app, ipcMain, getMainWindow, shell) {
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.disableDifferentialDownload = true;
    const version = app.getVersion();
    autoUpdater.allowPrerelease = version.includes("-dev.") || version.includes("-rex.");

    let availableUpdate = null;
    let availableInfo = null;

    autoUpdater.on("update-available", (info) => {
      if (info.version !== app.getVersion()) {
        availableUpdate = { version: info.version };
        availableInfo = info;
        getMainWindow()?.webContents.send("updater:update-available", info.version);
      }
    });

    autoUpdater.on("download-progress", (progress) => {
      getMainWindow()?.webContents.send("updater:download-progress", progress.percent);
    });

    autoUpdater.on("error", (err) => {
      console.warn("Auto-updater error:", err.message);
    });

    ipcMain.handle("updater:check", async () => {
      if (availableUpdate) {
        return availableUpdate;
      }

      try {
        await autoUpdater.checkForUpdates();
        return availableUpdate;
      } catch {
        return null;
      }
    });

    ipcMain.handle("updater:downloadAndInstall", async () => {
      if (process.platform === "darwin") {
        await shell.openExternal(dmgDownloadUrl(availableInfo));
        return;
      }
      await autoUpdater.downloadUpdate();
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    });

    ipcMain.handle("updater:installMode", () =>
      process.platform === "darwin" ? "download" : "inplace"
    );

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  } catch {
    // electron-updater is not available in development.
  }
}

module.exports = {
  setupAutoUpdater,
  dmgDownloadUrl,
};
