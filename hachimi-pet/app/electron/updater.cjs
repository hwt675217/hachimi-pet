const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFile, execFileSync, spawn } = require('node:child_process');

const REPO_OWNER = 'hwt675217';
const REPO_NAME = 'hachimi-pet';
const APP_ROOT = path.resolve(__dirname, '..');

function resolvePluginRoot() {
  const parent = path.resolve(APP_ROOT, '..');
  if (fs.existsSync(path.join(parent, 'plugin.json'))) {
    return parent;
  }
  const installed = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'hachimi-pet');
  if (fs.existsSync(path.join(installed, 'plugin.json'))) {
    return installed;
  }
  return parent;
}

function readLocalPluginMeta(pluginRoot) {
  const pjPath = path.join(pluginRoot, 'plugin.json');
  try {
    if (fs.existsSync(pjPath)) {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      return {
        version: normalizeVersion(pj.version || '1.0.0'),
        name: String(pj.name || REPO_NAME),
        hasManifest: true,
      };
    }
  } catch { /* ignore */ }

  const pkgPath = path.join(APP_ROOT, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return {
        version: normalizeVersion(pkg.version || '1.0.0'),
        name: REPO_NAME,
        hasManifest: false,
      };
    }
  } catch { /* ignore */ }

  return { version: '1.0.0', name: REPO_NAME, hasManifest: false };
}

function normalizeVersion(v) {
  return String(v || '0.0.0').trim().replace(/^v/i, '');
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function getSystemProxyUrl() {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    '';
  if (envProxy.trim()) {
    return /^https?:\/\//i.test(envProxy.trim()) ? envProxy.trim() : `http://${envProxy.trim()}`;
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', windowsHide: true, timeout: 2500 }
      );
      const enableMatch = out.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      const enabled = enableMatch && parseInt(enableMatch[1], 16) === 1;
      if (!enabled) return '';
      const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
      if (!serverMatch) return '';
      let raw = serverMatch[1].trim();
      if (raw.includes('=')) {
        const httpsPart = raw.split(';').find((s) => /^https=/i.test(s.trim()));
        const httpPart = raw.split(';').find((s) => /^http=/i.test(s.trim()));
        raw = (httpsPart || httpPart || raw.split(';')[0]).replace(/^[^=]+=/, '').trim();
      }
      if (raw) {
        return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      }
    } catch { /* ignore */ }
  }
  return '';
}

function requestViaHttpOrProxy(targetUrl, { headers = {}, timeoutMs = 20000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('Too many redirects'));
      return;
    }

    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const targetPort = Number(u.port || (isHttps ? 443 : 80));
    const proxyStr = getSystemProxyUrl();

    const reqHeaders = {
      'User-Agent': 'hachimi-pet-updater/1.0',
      ...headers,
    };

    const handleResponse = (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        requestViaHttpOrProxy(nextUrl, { headers, timeoutMs, redirects: redirects + 1 })
          .then(resolve, reject);
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ statusCode: code, headers: res.headers, body });
      });
      res.on('error', reject);
    };

    if (proxyStr && isHttps) {
      let pu;
      try {
        pu = new URL(proxyStr);
      } catch {
        pu = null;
      }
      if (pu) {
        const connectReq = http.request({
          host: pu.hostname,
          port: Number(pu.port || 80),
          method: 'CONNECT',
          path: `${u.hostname}:${targetPort}`,
          timeout: timeoutMs,
        });

        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
            return;
          }
          const tlsSocket = tls.connect({
            socket,
            servername: u.hostname,
          });
          const httpsReq = https.request(
            {
              host: u.hostname,
              port: targetPort,
              path: u.pathname + u.search,
              method: 'GET',
              headers: reqHeaders,
              createConnection: () => tlsSocket,
              timeout: timeoutMs,
            },
            handleResponse
          );
          httpsReq.on('timeout', () => {
            httpsReq.destroy(new Error('Request timed out'));
          });
          httpsReq.on('error', reject);
          httpsReq.end();
        });

        connectReq.on('timeout', () => {
          connectReq.destroy(new Error('Proxy CONNECT timed out'));
        });
        connectReq.on('error', reject);
        connectReq.end();
        return;
      }
    }

    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: targetPort,
        path: u.pathname + u.search,
        method: 'GET',
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      handleResponse
    );
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson(url, timeoutMs = 20000) {
  const res = await requestViaHttpOrProxy(url, {
    headers: { Accept: 'application/vnd.github+json' },
    timeoutMs,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${new URL(url).hostname}`);
  }
  return JSON.parse(res.body.toString('utf8'));
}

async function checkForUpdates() {
  const pluginRoot = resolvePluginRoot();
  const local = readLocalPluginMeta(pluginRoot);

  let latestVersion = '';
  let tagName = '';
  let releaseName = '';
  let notes = '';
  let publishedAt = '';
  let htmlUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

  try {
    const rel = await fetchJson(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      18000
    );
    tagName = String(rel.tag_name || '').trim();
    latestVersion = normalizeVersion(tagName || rel.name || '');
    releaseName = String(rel.name || tagName || '');
    notes = String(rel.body || '').trim();
    publishedAt = String(rel.published_at || '');
    if (rel.html_url) htmlUrl = String(rel.html_url);
  } catch (err) {
    // Fallback to raw plugin.json on main if releases API fails/rate-limits
    try {
      const pj = await fetchJson(
        `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/hachimi-pet/plugin.json`,
        18000
      );
      latestVersion = normalizeVersion(pj.version || '');
      tagName = latestVersion ? `v${latestVersion}` : 'main';
      releaseName = `Hachimi Pet ${tagName}`;
    } catch {
      throw err;
    }
  }

  if (!latestVersion) {
    throw new Error('无法解析远程仓库最新版本号');
  }

  const hasUpdate = compareSemver(latestVersion, local.version) > 0;
  const refPart = tagName ? `refs/tags/${encodeURIComponent(tagName)}` : 'refs/heads/main';
  const downloadUrl = `https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/zip/${refPart}`;

  return {
    ok: true,
    currentVersion: local.version,
    latestVersion,
    hasUpdate,
    tagName,
    releaseName,
    notes: notes.slice(0, 800),
    publishedAt,
    htmlUrl,
    downloadUrl,
    pluginRoot,
    canApply: fs.existsSync(path.join(pluginRoot, 'plugin.json')),
  };
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { windowsHide: true, timeout: 60000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.trim() || err.message));
            return;
          }
          resolve();
        }
      );
    } else if (process.platform === 'darwin') {
      execFile('ditto', ['-xk', zipPath, destDir], { timeout: 60000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], { timeout: 60000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
}

function findExtractedPluginDir(extractDir) {
  const direct = path.join(extractDir, 'hachimi-pet');
  if (fs.existsSync(path.join(direct, 'plugin.json'))) return direct;

  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub1 = path.join(extractDir, ent.name, 'hachimi-pet');
    if (fs.existsSync(path.join(sub1, 'plugin.json'))) return sub1;
    const sub0 = path.join(extractDir, ent.name);
    if (fs.existsSync(path.join(sub0, 'plugin.json'))) return sub0;
  }
  return '';
}

function buildWorkerScriptContent({ sourceDir, targetDir, tempRoot, waitPid }) {
  return `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sourceDir = ${JSON.stringify(sourceDir)};
const targetDir = ${JSON.stringify(targetDir)};
const tempRoot = ${JSON.stringify(tempRoot)};
const waitPid = ${Number(waitPid) || 0};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const deadline = Date.now() + 9000;
  while (waitPid > 0 && isPidAlive(waitPid) && Date.now() < deadline) {
    await sleep(200);
  }
  await sleep(350);

  const assetsDir = path.join(targetDir, 'app', 'dist', 'assets');
  try {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  } catch {}

  let lastErr = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  if (lastErr) {
    process.exit(1);
  }

  const launcher = path.join(targetDir, 'scripts', 'launch-pet.mjs');
  if (fs.existsSync(launcher)) {
    const child = spawn(process.execPath, [launcher], {
      cwd: targetDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  await sleep(600);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

run().catch(() => process.exit(1));
`;
}

let updateInProgress = false;

async function applyUpdate({ onQuit } = {}) {
  if (updateInProgress) {
    throw new Error('更新正在进行中，请稍候');
  }
  updateInProgress = true;
  const tempRoot = path.join(os.tmpdir(), `hachimi-pet-update-${Date.now()}`);

  try {
    const info = await checkForUpdates();
    if (!info.canApply) {
      throw new Error(`未找到可覆盖的插件目录: ${info.pluginRoot}`);
    }
    if (!info.hasUpdate) {
      updateInProgress = false;
      return {
        ok: true,
        updated: false,
        currentVersion: info.currentVersion,
        latestVersion: info.latestVersion,
        message: '当前已是最新版本',
      };
    }

    fs.mkdirSync(tempRoot, { recursive: true });
    const zipPath = path.join(tempRoot, 'release.zip');
    const dlRes = await requestViaHttpOrProxy(info.downloadUrl, { timeoutMs: 120000 });
    if (dlRes.statusCode < 200 || dlRes.statusCode >= 300) {
      throw new Error(`下载更新包失败: HTTP ${dlRes.statusCode}`);
    }
    if (dlRes.body.length < 4096 || dlRes.body[0] !== 0x50 || dlRes.body[1] !== 0x4b) {
      throw new Error('下载的更新包格式无效');
    }
    fs.writeFileSync(zipPath, dlRes.body);

    const extractDir = path.join(tempRoot, 'extracted');
    await extractZip(zipPath, extractDir);

    const sourcePluginDir = findExtractedPluginDir(extractDir);
    if (!sourcePluginDir || !fs.existsSync(path.join(sourcePluginDir, 'app', 'dist', 'index.html'))) {
      throw new Error('更新包内缺少完整的 hachimi-pet 插件内容');
    }

    const workerScriptPath = path.join(tempRoot, 'apply-update.mjs');
    fs.writeFileSync(
      workerScriptPath,
      buildWorkerScriptContent({
        sourceDir: sourcePluginDir,
        targetDir: info.pluginRoot,
        tempRoot,
        waitPid: process.pid,
      }),
      'utf8'
    );

    const worker = spawn(process.execPath, [workerScriptPath], {
      cwd: tempRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    worker.unref();

    setTimeout(() => {
      if (typeof onQuit === 'function') {
        onQuit();
      } else {
        process.exit(0);
      }
    }, 260);

    return {
      ok: true,
      updated: true,
      fromVersion: info.currentVersion,
      toVersion: info.latestVersion,
      pluginRoot: info.pluginRoot,
    };
  } catch (err) {
    updateInProgress = false;
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

module.exports = {
  checkForUpdates,
  applyUpdate,
  compareSemver,
  normalizeVersion,
};
