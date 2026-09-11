const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const REPO = "sortbek/simc-builds";

const PLATFORM_ASSETS = {
  win32: "simc-windows-x64.zip",
  linux: "simc-linux-x64.tar.gz",
  darwin: "simc-macos-arm64.tar.gz",
};

const BINARY_NAME = process.platform === "win32" ? "simc.exe" : "simc";

// ── HTTP helpers ────────────────────────────────────────────────
//
// Inside the Electron main process we go through Electron's `net` module so
// downloads honour the system proxy (Clash, V2Ray, corporate proxies …) exactly
// like the renderer does. Plain Node `https` (the fallback used by dev.js and
// CLI runs) bypasses the system proxy, which made GitHub release downloads
// slow or flaky for users behind a proxy. Every response stream also gets an
// idle timeout so a stalled connection fails instead of hanging forever.

const IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_RETRIES = 2;

function electronNet() {
  if (!process.versions || !process.versions.electron) return null;
  try {
    const { net, app } = require("electron");
    if (net && typeof net.request === "function" && app && app.isReady()) return net;
  } catch {
    // not running inside Electron's main process
  }
  return null;
}

/**
 * Open a GET request and resolve with the final (post-redirect) response
 * stream. Resolves `{ statusCode, headers, stream, abort }`.
 */
function openRequest(url) {
  const net = electronNet();
  if (net) {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, method: "GET", redirect: "follow" });
      req.setHeader("User-Agent", "SimHammer");
      req.on("response", (res) => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          stream: res,
          abort: () => req.abort(),
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const follow = (requestUrl, hops) => {
      const req = https.get(requestUrl, { headers: { "User-Agent": "SimHammer" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
          res.resume();
          return follow(res.headers.location, hops + 1);
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          stream: res,
          abort: () => req.destroy(),
        });
      });
      req.on("error", reject);
    };
    follow(url, 0);
  });
}

/** Read a whole response into a Buffer, failing when no data arrives for IDLE_TIMEOUT_MS. */
function readBody(url, res, onProgress) {
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) {
      res.abort();
      return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
    }
    const lengthHeader = res.headers["content-length"];
    const total = parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader || "0", 10);
    let received = 0;
    const chunks = [];
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        res.abort();
        reject(new Error(`Download stalled for ${IDLE_TIMEOUT_MS / 1000}s: ${url}`));
      }, IDLE_TIMEOUT_MS);
    };
    arm();
    res.stream.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      arm();
      if (onProgress && total > 0) onProgress(received / total);
    });
    res.stream.on("end", () => {
      clearTimeout(timer);
      if (total > 0 && received !== total) {
        return reject(new Error(`Incomplete download (${received}/${total} bytes): ${url}`));
      }
      resolve(Buffer.concat(chunks));
    });
    res.stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function httpGet(url) {
  const res = await openRequest(url);
  return readBody(url, res);
}

async function httpGetWithProgress(url, onProgress) {
  const res = await openRequest(url);
  return readBody(url, res, onProgress);
}

// ── GitHub release queries ──────────────────────────────────────

/** Cache releases for 60s to avoid hammering the API */
let _releaseCache = null;
let _releaseCacheTime = 0;

async function fetchReleases() {
  if (_releaseCache && Date.now() - _releaseCacheTime < 60_000) return _releaseCache;
  const data = await httpGet(`https://api.github.com/repos/${REPO}/releases`);
  _releaseCache = JSON.parse(data.toString());
  _releaseCacheTime = Date.now();
  return _releaseCache;
}

async function getLatestRelease(prefix) {
  const releases = await fetchReleases();
  const asset = PLATFORM_ASSETS[process.platform];
  if (!asset) throw new Error(`Unsupported platform: ${process.platform}`);

  for (const release of releases) {
    if (!release.tag_name.startsWith(prefix)) continue;
    const match = release.assets.find((a) => a.name === asset);
    if (match) {
      return {
        tag: release.tag_name,
        type: prefix.replace("-", ""),
        assetUrl: match.browser_download_url,
      };
    }
  }
  return null;
}

function getLatestWeeklyRelease() {
  return getLatestRelease("weekly-");
}

function getLatestNightlyRelease() {
  return getLatestRelease("nightly-");
}

/**
 * Check for available updates (both weekly and nightly).
 * Returns available releases that aren't already installed.
 */
async function checkForUpdates(baseDir) {
  const installed = listInstalledVersions(baseDir);
  const installedTags = new Set(installed.map((v) => v.tag));

  const results = [];
  const errors = [];
  for (const fetcher of [getLatestWeeklyRelease, getLatestNightlyRelease]) {
    try {
      const release = await fetcher();
      if (release) {
        results.push({
          ...release,
          installed: installedTags.has(release.tag),
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (results.length === 0 && errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return results;
}

// ── Multi-version directory management ──────────────────────────
//
// baseDir/
//   weekly-2026-04-12/simc[.exe]
//   nightly-2026-04-11/simc[.exe]
//   .active            (contains tag name of active version)

/**
 * List all installed simc versions.
 * @param {string} baseDir
 * @returns {{ tag: string, type: string, binaryPath: string }[]}
 */
function listInstalledVersions(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const versions = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const binaryPath = path.join(baseDir, entry.name, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      const tag = entry.name;
      const type = tag.startsWith("weekly-") ? "weekly" : tag.startsWith("nightly-") ? "nightly" : tag.startsWith("source-") ? "source" : "unknown";
      versions.push({ tag, type, binaryPath });
    }
  }
  // Sort newest first (tags are date-based so string sort works)
  versions.sort((a, b) => b.tag.localeCompare(a.tag));
  return versions;
}

function getActiveVersion(baseDir) {
  try {
    return fs.readFileSync(path.join(baseDir, ".active"), "utf-8").trim();
  } catch {
    return null;
  }
}

function setActiveVersion(baseDir, tag) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, ".active"), tag);
}

/**
 * Get the binary path of the currently active version.
 * @returns {string|null}
 */
function getActiveBinaryPath(baseDir) {
  const tag = getActiveVersion(baseDir);
  if (!tag) return null;
  const binaryPath = path.join(baseDir, tag, BINARY_NAME);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

function removeVersion(baseDir, tag) {
  const wasActive = getActiveVersion(baseDir) === tag;
  const dir = path.join(baseDir, tag);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // If we just deleted the active version, promote the newest remaining install.
  if (wasActive) {
    const remaining = listInstalledVersions(baseDir);
    if (remaining.length > 0) {
      setActiveVersion(baseDir, remaining[0].tag);
    } else {
      try { fs.unlinkSync(path.join(baseDir, ".active")); } catch {}
    }
  }
}

// ── Download + extract ──────────────────────────────────────────

/**
 * Download and install a specific release.
 * @param {string} baseDir - Base simc directory
 * @param {{ tag: string, assetUrl: string }} release - Release info from getLatest*Release()
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<string>} Path to the simc binary
 */
async function downloadWithRetry(url, onProgress) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES + 1; attempt++) {
    try {
      return await httpGetWithProgress(url, onProgress);
    } catch (err) {
      lastError = err;
      // A 4xx answer will not change on retry (missing asset, bad tag).
      if (/^HTTP 4\d\d /.test(err.message)) break;
      if (attempt <= DOWNLOAD_RETRIES) {
        console.warn(`[simc] Download attempt ${attempt} failed (${err.message}); retrying…`);
        if (onProgress) onProgress(0);
      }
    }
  }
  throw lastError;
}

async function installVersion(baseDir, release, onProgress) {
  const versionDir = path.join(baseDir, release.tag);
  fs.mkdirSync(versionDir, { recursive: true });

  const asset = PLATFORM_ASSETS[process.platform];
  const tmpFile = path.join(os.tmpdir(), `simc-download-${Date.now()}-${asset}`);

  try {
    const data = await downloadWithRetry(release.assetUrl, onProgress);
    fs.writeFileSync(tmpFile, data);

    if (asset.endsWith(".zip")) {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpFile}' -DestinationPath '${versionDir}'"`,
        { stdio: "ignore" }
      );
    } else {
      execSync(`tar xzf "${tmpFile}" -C "${versionDir}"`, { stdio: "ignore" });
    }

    const binaryPath = path.join(versionDir, BINARY_NAME);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Extraction succeeded but ${BINARY_NAME} not found in ${versionDir}`);
    }

    if (process.platform !== "win32") {
      fs.chmodSync(binaryPath, 0o755);
    }

    // Remove older versions of the same branch (keep only the one we just installed)
    const branch = release.tag.startsWith("weekly-") ? "weekly-" : release.tag.startsWith("nightly-") ? "nightly-" : null;
    if (branch) {
      for (const v of listInstalledVersions(baseDir)) {
        if (v.tag !== release.tag && v.tag.startsWith(branch)) {
          console.log(`[simc] Removing old ${v.tag}`);
          removeVersion(baseDir, v.tag);
        }
      }
    }

    return binaryPath;
  } catch (err) {
    // Never leave a half-installed version directory behind: it would show up
    // as an unusable entry and block a clean retry.
    if (!fs.existsSync(path.join(versionDir, BINARY_NAME))) {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Ensure simc is available. Downloads latest weekly if nothing installed.
 * Sets it as active. Used on startup.
 * @param {string} baseDir
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<string>} Path to active simc binary
 */
async function ensureSimc(baseDir, onProgress) {
  // Migrate from old single-binary layout if needed
  migrateFromLegacy(baseDir);

  // If we have an active version, use it
  const activePath = getActiveBinaryPath(baseDir);
  if (activePath) return activePath;

  // If we have any installed versions, activate the newest
  const installed = listInstalledVersions(baseDir);
  if (installed.length > 0) {
    setActiveVersion(baseDir, installed[0].tag);
    return installed[0].binaryPath;
  }

  // Nothing installed — download latest weekly
  const release = await getLatestWeeklyRelease();
  if (!release) throw new Error("No weekly release found on sortbek/simc-builds");

  const binaryPath = await installVersion(baseDir, release, onProgress);
  setActiveVersion(baseDir, release.tag);
  return binaryPath;
}

/**
 * Migrate from old single-binary layout (simc[.exe] + .version in baseDir)
 * to the new versioned subdirectory layout.
 */
function migrateFromLegacy(baseDir) {
  const legacyBinary = path.join(baseDir, BINARY_NAME);
  const legacyVersion = path.join(baseDir, ".version");
  if (!fs.existsSync(legacyBinary)) return;

  let tag;
  try {
    tag = fs.readFileSync(legacyVersion, "utf-8").trim();
  } catch {
    tag = "weekly-legacy";
  }

  const versionDir = path.join(baseDir, tag);
  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true });
    fs.renameSync(legacyBinary, path.join(versionDir, BINARY_NAME));
  }

  // Clean up legacy files
  try { fs.unlinkSync(legacyBinary); } catch {}
  try { fs.unlinkSync(legacyVersion); } catch {}

  if (!getActiveVersion(baseDir)) {
    setActiveVersion(baseDir, tag);
  }
}

module.exports = {
  ensureSimc,
  installVersion,
  listInstalledVersions,
  getActiveVersion,
  setActiveVersion,
  getActiveBinaryPath,
  removeVersion,
  checkForUpdates,
  getLatestWeeklyRelease,
  getLatestNightlyRelease,
  BINARY_NAME,
};
