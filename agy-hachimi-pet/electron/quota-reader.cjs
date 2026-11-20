const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');

/** @type {{ host: string, port: number, csrfToken: string, pid: number } | null} */
let cachedEndpoint = null;

function isPidAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function listCandidateEndpoints() {
  const candidates = [];

  if (cachedEndpoint && (!cachedEndpoint.pid || isPidAlive(cachedEndpoint.pid))) {
    candidates.push(cachedEndpoint);
  } else {
    cachedEndpoint = null;
  }

  const envAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envToken = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (envAddr && envToken) {
    const clean = envAddr.replace(/^https?:\/\//i, '');
    const [host, portStr] = clean.split(':');
    const port = Number(portStr || 0);
    if (host && port > 0) {
      candidates.push({ host, port, csrfToken: envToken, pid: 0 });
    }
  }

  try {
    if (fs.existsSync(DAEMON_DIR)) {
      const files = fs
        .readdirSync(DAEMON_DIR)
        .filter((f) => /^hub_\d+\.json$/i.test(f))
        .map((f) => {
          const full = path.join(DAEMON_DIR, f);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(full).mtimeMs || 0; } catch {}
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const item of files) {
        try {
          const data = JSON.parse(fs.readFileSync(item.full, 'utf8'));
          const port = Number(data?.httpPort || 0);
          const csrfToken = String(data?.csrfToken || '').trim();
          const pid = Number(data?.pid || 0);
          if (!port || !csrfToken || (pid && !isPidAlive(pid))) continue;
          const dup = candidates.some((c) => c.port === port && c.csrfToken === csrfToken);
          if (!dup) {
            candidates.push({ host: '127.0.0.1', port, csrfToken, pid });
          }
        } catch { /* ignore malformed hub json */ }
      }
    }
  } catch { /* ignore */ }

  return candidates;
}

function postLsRpc(endpoint, methodName, body = {}, timeoutMs = 2000) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: endpoint.host || '127.0.0.1',
        port: endpoint.port,
        path: `/exa.language_server_pb.LanguageServerService/${methodName}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-codeium-csrf-token': endpoint.csrfToken,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('LS RPC timeout'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function normalizeBucket(b) {
  if (!b || typeof b !== 'object') return null;
  const fracRaw = typeof b.remainingFraction === 'number' ? b.remainingFraction : Number(b.remainingFraction);
  const frac = Number.isFinite(fracRaw) ? Math.max(0, Math.min(1, fracRaw)) : 1;
  return {
    bucketId: String(b.bucketId || ''),
    window: String(b.window || ''),
    remainingFraction: Number(frac.toFixed(6)),
    remainingPercent: Number((frac * 100).toFixed(1)),
    usedPercent: Number(((1 - frac) * 100).toFixed(1)),
    resetTime: b.resetTime ? String(b.resetTime) : '',
    description: b.description ? String(b.description) : '',
  };
}

function deriveShortGroupName(displayName) {
  const name = String(displayName || '').trim();
  if (/gemini/i.test(name)) return 'Gemini';
  if (/claude/i.test(name) && /gpt/i.test(name)) return 'Claude / GPT';
  if (/claude/i.test(name)) return 'Claude';
  return name.replace(/\s*models$/i, '') || 'Model';
}

function normalizeQuotaSummary(rpcJson) {
  const resp = rpcJson?.response || rpcJson;
  const rawGroups = Array.isArray(resp?.groups) ? resp.groups : [];
  if (rawGroups.length === 0) return null;

  const groups = rawGroups.map((g, idx) => {
    const displayName = String(g.displayName || `Group ${idx + 1}`);
    const description = String(g.description || '').replace(/^Models within this group:\s*/i, '').trim();
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    const fiveHourRaw = buckets.find((b) => String(b.window || '').toLowerCase() === '5h' || /5h/i.test(String(b.bucketId || '')));
    const weeklyRaw = buckets.find((b) => String(b.window || '').toLowerCase() === 'weekly' || /weekly/i.test(String(b.bucketId || '')));
    return {
      id: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `group-${idx}`,
      displayName,
      shortName: deriveShortGroupName(displayName),
      modelsSummary: description,
      fiveHour: normalizeBucket(fiveHourRaw),
      weekly: normalizeBucket(weeklyRaw),
    };
  });

  let defaultGroupIndex = groups.findIndex((g) => /gemini/i.test(g.displayName));
  if (defaultGroupIndex < 0) defaultGroupIndex = 0;

  return {
    groups,
    defaultGroupIndex,
    updatedAt: Date.now(),
  };
}

async function readQuotaSummary() {
  const endpoints = listCandidateEndpoints();
  for (const ep of endpoints) {
    try {
      const json = await postLsRpc(ep, 'RetrieveUserQuotaSummary', {});
      const parsed = normalizeQuotaSummary(json);
      if (parsed) {
        cachedEndpoint = ep;
        return parsed;
      }
    } catch {
      if (cachedEndpoint && cachedEndpoint.port === ep.port) {
        cachedEndpoint = null;
      }
    }
  }
  return null;
}

module.exports = {
  readQuotaSummary,
  normalizeQuotaSummary,
};
