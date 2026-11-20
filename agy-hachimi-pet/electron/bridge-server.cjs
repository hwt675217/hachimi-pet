const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('./mini-ws.cjs');
const { TranscriptWatcher } = require('./transcript-watcher.cjs');
const { AgyRunner } = require('./agy-runner.cjs');
const { SubagentTracker } = require('./subagent-tracker.cjs');
const {
  readLatestDbTelemetry,
  buildTranscriptTelemetry,
  buildCompactedTelemetry,
  readInitialTranscriptTelemetry,
} = require('./telemetry-reader.cjs');
const { readQuotaSummary } = require('./quota-reader.cjs');
const { readUsageStats, readModelDetailStats } = require('./stats-reader.cjs');
const {
  ANNOTATIONS_DIR,
  loadAntigravityCatalog,
  readSingleAnnotation,
  isTranscriptLikelySubagent,
  findTranscriptPath,
  saveConversationAnnotationTitle,
  formatRelativeTime,
} = require('./antigravity-catalog.cjs');

const DEFAULT_PORT = Number(process.env.HACHIMI_PET_PORT || process.env.AGY_WHALE_PORT || 17890);
const DATA_DIR = path.join(os.homedir(), '.agy-whale-pet');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PARENT_WORKSPACE = path.resolve(PROJECT_ROOT, '..');

function sanitizeWorkspace(dir) {
  if (!dir || typeof dir !== 'string') return PARENT_WORKSPACE;
  if (/[\\/]\.gemini[\\/]/i.test(dir)) return PARENT_WORKSPACE;
  return fs.existsSync(dir) ? dir : PARENT_WORKSPACE;
}

function isNativeCliSession(cid, transcriptPath = '') {
  if (!cid || cid === 'default-session' || cid.startsWith('local-')) return false;
  if (String(transcriptPath).toLowerCase().includes('antigravity-cli')) return true;
  const cliDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', cid);
  return fs.existsSync(cliDir);
}

const RISKY_CMD_REGEX = /\b(rm\s+-rf|Remove-Item\b.*-Recurse|del\s+\/[fsq]|git\s+push\b.*--force|git\s+reset\s+--hard|format\s+[a-z]:|drop\s+(table|database)|shutdown\b|Restart-Computer)\b/i;

function loadSettings() {
  const initialProjects = Array.from(new Set([PARENT_WORKSPACE, PROJECT_ROOT]));
  const LEGACY_MAP = {
    gemini: 'astral',
    deepseek: 'azure',
    claude: 'amber',
    minimax: 'sakura',
    qwen: 'astral',
    kimi: 'emerald',
    chatgpt: 'arctic',
    harness: 'obsidian',
  };
  const VALID = new Set(['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian']);
  const defaults = {
    mode: 'companion',          // 'companion' | 'standalone'
    scheme: 'astral',           // 'astral' | 'sakura' | 'azure' | 'emerald' | 'amber' | 'crimson' | 'arctic' | 'obsidian'
    outfit: 'maid',             // 'maid' (Starry Gothic Dress)
    autoSchemeByModel: false,   // Auto-switch color scheme based on modelName
    roam: 'free',               // 'free' | 'off' (pinned corner)
    scale: 0.95,
    soundOn: true,
    safetyGateEnabled: false,   // Toggle PreToolUse hook on run_command
    interceptRiskyOnly: true,   // Pop Allow/Deny bubble on risky run_command
    interceptAllCommands: false,// Pop Allow/Deny bubble on EVERY run_command
    defaultWorkspace: sanitizeWorkspace(process.cwd()),
    savedProjects: initialProjects,
    selectedProject: PARENT_WORKSPACE,
  };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      saved.defaultWorkspace = sanitizeWorkspace(saved.defaultWorkspace);
      const mergedProjects = Array.from(
        new Set([...(Array.isArray(saved.savedProjects) ? saved.savedProjects : []), ...initialProjects])
      ).filter((p) => typeof p === 'string' && !/[\\/]\.gemini[\\/]/i.test(p) && fs.existsSync(p));
      saved.savedProjects = mergedProjects.length > 0 ? mergedProjects : initialProjects;
      saved.selectedProject = sanitizeWorkspace(saved.selectedProject || saved.defaultWorkspace);
      if (!saved.savedProjects.includes(saved.selectedProject)) {
        saved.savedProjects.unshift(saved.selectedProject);
      }
      const rawScheme = String(saved.scheme || 'astral').toLowerCase();
      saved.scheme = VALID.has(rawScheme) ? rawScheme : (LEGACY_MAP[rawScheme] || 'astral');
      saved.outfit = 'maid';
      return { ...defaults, ...saved };
    }
  } catch { /* ignore */ }
  return defaults;
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function shortPath(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function mapToolPresentation(toolName, args = {}) {
  const name = String(toolName || '').toLowerCase();
  if (/read_file|view_file|list_dir|find_by_name|grep_search/.test(name)) {
    const target = shortPath(args.Path || args.SearchPath || args.DirectoryPath || args.Query || '');
    return {
      status: 'READING',
      badge: `📖 正在查阅 ${target || name}`,
      expression: 'determined',
      motion: 'look',
      thinking: false,
    };
  }
  if (/edit_file|write_file|replace|multi_replace/.test(name)) {
    const target = shortPath(args.Path || args.TargetFile || '');
    return {
      status: 'CODING',
      badge: `⌨️ 正在编写 ${target || '代码'}`,
      expression: 'determined',
      motion: 'nod',
      thinking: false,
    };
  }
  if (/run_command/.test(name)) {
    const cmd = String(args.CommandLine || args.command || '').trim();
    const shortCmd = cmd.length > 42 ? cmd.slice(0, 40) + '…' : cmd;
    return {
      status: 'RUNNING_CMD',
      badge: `⚙️ 执行终端: ${shortCmd || '命令'}`,
      expression: 'excited',
      motion: 'hop',
      thinking: false,
    };
  }
  if (/search_web|read_url|browser/.test(name)) {
    const q = String(args.query || args.Url || '').trim();
    return {
      status: 'READING',
      badge: `🌐 检索网络: ${q.slice(0, 34) || '网页浏览'}`,
      expression: 'thinking',
      motion: 'look',
      thinking: true,
    };
  }
  if (/invoke_subagent|send_message/.test(name)) {
    return {
      status: 'THINKING',
      badge: `🐳 调度子代理: ${args.Role || args.TypeName || '协作任务'}`,
      expression: 'love',
      motion: 'wave',
      thinking: true,
    };
  }
  if (/^swarm$|post_message|read_board/.test(name)) {
    return {
      status: 'THINKING',
      badge: `🐝 蜂群看板协作: ${args.name || args.action || 'Swarm'}`,
      expression: 'excited',
      motion: 'jump',
      thinking: true,
    };
  }
  if (/ask_question/.test(name)) {
    return {
      status: 'WAITING_USER',
      badge: '❓ 等待主人确认选项',
      expression: 'confused',
      motion: 'wave',
      thinking: false,
    };
  }
  return {
    status: 'THINKING',
    badge: `🔧 调用工具: ${toolName}`,
    expression: 'thinking',
    motion: null,
    thinking: true,
  };
}

function detectSchemeForModel(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini') || m.includes('argon')) return 'gemini';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'claude';
  if (m.includes('gpt') || m.includes('codex') || m.includes('o1') || m.includes('o3')) return 'chatgpt';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('minimax')) return 'minimax';
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function serveStaticFile(reqPath, res) {
  const projectRoot = path.join(__dirname, '..');
  const distDir = path.join(projectRoot, 'dist');
  const publicDir = path.join(projectRoot, 'public');
  const cleanRel = decodeURIComponent(reqPath === '/' ? '/index.html' : reqPath).replace(/^\/+/, '');

  for (const baseDir of [distDir, publicDir]) {
    const candidate = path.resolve(baseDir, cleanRel);
    if (!candidate.startsWith(path.resolve(baseDir))) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(candidate).pipe(res);
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

function createBridgeServer({ port = DEFAULT_PORT, onShowPanel, onCheckPixels, onGetMouseState, onQuit } = {}) {
  let settings = loadSettings();
  let whaleDiag = null;
  let hostMouseState = null;
  let rendererLogs = [];
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, string>} Maps companion CLI trajectory ID -> parent Desktop session ID */
  const linkedCliToOwner = new Map();
  /** @type {Array<any>} Antigravity Projects & Conversations catalog */
  let antigravityProjects = [];
  /** @type {Set<string>} Known subagent/swarm child conversation IDs */
  const knownChildIds = new Set();
  let activeConversationId = null;
  let quotaSummary = null;
  let quotaPending = false;

  function shortTitleLabel(t, maxLen = 18) {
    const clean = String(t || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
  }

  function isSubagentCid(cid, transcriptPath = '') {
    if (!cid) return false;
    if (subagentTracker?.isChildConversation(cid) || knownChildIds.has(cid)) return true;
    const tp = transcriptPath || findTranscriptPath(cid);
    if (tp && isTranscriptLikelySubagent(tp)) {
      knownChildIds.add(cid);
      return true;
    }
    return false;
  }

  /** @type {Map<string, Array<{ id: string, text: string, createdAt: number }>>} */
  const queuedMessages = new Map();
  /** @type {Map<string, { id: string, conversationId: string, toolName: string, commandLine: string, summary: string, createdAt: number, resolve: Function, timer: NodeJS.Timeout }>} */
  const pendingApprovals = new Map();
  /** @type {Map<string, { id: string, conversationId: string, summary: string, quickReplies: string[], createdAt: number, resolve: Function, timer: NodeJS.Timeout }>} */
  const pendingMcpWaits = new Map();

  const watcher = new TranscriptWatcher();
  const runner = new AgyRunner();

  let subagentTracker = null;

  const server = http.createServer(async (req, res) => {
    try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        activeConversationId,
        sessionCount: sessions.size,
        agyRunning: runner.isRunning,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/diag') {
      let pixelCheck = null;
      if (onCheckPixels && whaleDiag?.box) {
        try { pixelCheck = await onCheckPixels(whaleDiag.box); } catch (e) { pixelCheck = { error: String(e) }; }
      }
      const mouseState = typeof onGetMouseState === 'function' ? onGetMouseState() : hostMouseState;
      sendJson(res, 200, { whaleDiag, mouseState, pixelCheck, rendererLogs: rendererLogs.slice(-25) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, snapshotState());
      return;
    }

    const buildTitleLookup = () => {
      const map = new Map();
      for (const proj of antigravityProjects) {
        for (const c of proj.conversations || []) {
          if (c.conversationId && c.title) map.set(c.conversationId, c.title);
        }
      }
      for (const [cid, s] of sessions.entries()) {
        if (s.title) map.set(cid, s.title);
      }
      return map;
    };

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const preset = url.searchParams.get('preset') || '7d';
      const start = url.searchParams.get('start') || '';
      const end = url.searchParams.get('end') || '';
      const stats = await readUsageStats({ preset, start, end, titleLookup: buildTitleLookup() });
      sendJson(res, 200, stats);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stats/model') {
      const model = url.searchParams.get('model') || 'unknown';
      const preset = url.searchParams.get('preset') || '7d';
      const start = url.searchParams.get('start') || '';
      const end = url.searchParams.get('end') || '';
      const tab = url.searchParams.get('tab') || 'turns';
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 10);
      const detail = await readModelDetailStats({
        model,
        preset,
        start,
        end,
        tab,
        page,
        pageSize,
        titleLookup: buildTitleLookup(),
      });
      sendJson(res, 200, detail);
      return;
    }

    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (url.pathname.startsWith('/api/hook/')) {
        const eventName = url.pathname.slice('/api/hook/'.length);
        const hookReply = await handleHookEvent(eventName, body);
        sendJson(res, 200, hookReply);
        return;
      }

      if (url.pathname === '/api/mcp/notify') {
        handleMcpNotify(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/mcp/await-command') {
        const result = await handleMcpAwaitCommand(body, req, res);
        if (!res.writableEnded) {
          sendJson(res, 200, result);
        }
        return;
      }

      if (url.pathname === '/api/subagents') {
        if (body.action === 'clear') {
          subagentTracker?.clearAll();
          sendJson(res, 200, { ok: true, subagents: [] });
        } else if (body.action === 'remove' && body.id) {
          subagentTracker?.removeById(body.id);
          sendJson(res, 200, { ok: true, subagents: subagentTracker?.getPublicList() || [] });
        } else {
          const item = subagentTracker?.spawnTestSubagent(body);
          const list = subagentTracker?.getPublicList() || [];
          const pubItem = item ? list.find((x) => x.id === item.id) || null : null;
          sendJson(res, 200, { ok: true, item: pubItem, subagents: list });
        }
        return;
      }

      if (url.pathname === '/api/command') {
        const result = dispatchUserCommand({
          text: body.text,
          targetConversationId: body.conversationId || activeConversationId,
          mode: body.mode || settings.mode,
          cwd: body.cwd,
        });
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/settings') {
        if (body && typeof body === 'object') {
          settings = { ...settings, ...body };
          saveSettings(settings);
          if (body.scheme || body.outfit) {
            broadcast('pet:scheme', { scheme: settings.scheme, outfit: settings.outfit });
          }
          broadcast('state:sync', snapshotState());
        }
        sendJson(res, 200, { ok: true, settings });
        return;
      }

      if (url.pathname === '/api/host-state') {
        if (body && typeof body === 'object') {
          hostMouseState = { ...body, updatedAt: Date.now() };
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/renderer-log') {
        if (body && typeof body === 'object') {
          rendererLogs.push({
            level: String(body.level || 'error'),
            source: String(body.source || 'renderer'),
            message: String(body.message || ''),
            stack: body.stack ? String(body.stack).slice(0, 1600) : '',
            ts: Date.now(),
          });
          if (rendererLogs.length > 50) rendererLogs.shift();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/pet-command') {
        broadcast('pet:command', body || {});
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/quit') {
        sendJson(res, 200, { ok: true });
        if (typeof onQuit === 'function') {
          setTimeout(() => onQuit(), 40);
        }
        return;
      }
    }

    if (req.method === 'GET' && serveStaticFile(url.pathname, res)) {
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.writableEnded) {
        try {
          sendJson(res, 500, { error: err?.message || 'Internal server error' });
        } catch {
          try { res.end(); } catch {}
        }
      }
    }
  });

  const wss = new WebSocketServer({ server });

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  function findCatalogConversation(cid) {
    if (!cid) return null;
    for (const proj of antigravityProjects) {
      const found = proj.conversations.find((c) => c.conversationId === cid);
      if (found) return { proj, convo: found };
    }
    return null;
  }

  function findCatalogProjectByPath(wsPath) {
    if (!wsPath) return null;
    const norm = String(wsPath).replace(/\\/g, '/').toLowerCase();
    return (
      antigravityProjects.find((p) => p.workspacePaths?.some((wp) => String(wp).replace(/\\/g, '/').toLowerCase() === norm)) ||
      null
    );
  }

  function buildMergedProjectsSnapshot() {
    return antigravityProjects.map((proj) => {
      const convos = [...proj.conversations];
      // Prepend any local newly-created or active sessions belonging to this project that aren't in DB yet
      for (const s of sessions.values()) {
        if (s.projectId === proj.id && !convos.some((c) => c.conversationId === s.conversationId)) {
          convos.unshift({
            conversationId: s.conversationId,
            title: s.title || s.lastUserInput || '✨ 新对话 (待输入)',
            projectId: proj.id,
            projectName: proj.name,
            workspacePath: s.workspacePath || proj.workspacePath,
            transcriptPath: s.transcriptPath || '',
            updatedAt: s.updatedAt || Date.now(),
            relativeTime: formatRelativeTime(s.updatedAt || Date.now()),
            status: s.status === 'IDLE' ? 'IDLE' : 'RUNNING',
            source: 'PET',
          });
        }
      }
      return {
        ...proj,
        conversations: convos,
      };
    });
  }

  function snapshotState() {
    return {
      settings,
      activeConversationId,
      agyRunning: runner.isRunning,
      projects: buildMergedProjectsSnapshot(),
      sessions: Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
      pendingApprovals: Array.from(pendingApprovals.values()).map(({ id, conversationId, toolName, commandLine, summary, createdAt }) => ({
        id, conversationId, toolName, commandLine, summary, createdAt,
      })),
      pendingMcpWaits: Array.from(pendingMcpWaits.values()).map(({ id, conversationId, summary, quickReplies, createdAt }) => ({
        id, conversationId, summary, quickReplies, createdAt,
      })),
      queuedCounts: Object.fromEntries(
        Array.from(queuedMessages.entries()).map(([k, arr]) => [k, arr.length])
      ),
      subagents: subagentTracker ? subagentTracker.getPublicList() : [],
      quota: quotaSummary,
    };
  }

  function quotaSignature(q) {
    if (!q || !Array.isArray(q.groups)) return '';
    return q.groups
      .map((g) => `${g.id}:${g.fiveHour?.remainingPercent ?? ''}:${g.fiveHour?.resetTime ?? ''}:${g.weekly?.remainingPercent ?? ''}:${g.weekly?.resetTime ?? ''}`)
      .join('|');
  }

  function refreshQuotaSummary() {
    if (quotaPending) return;
    quotaPending = true;
    readQuotaSummary()
      .then((nextQuota) => {
        if (!nextQuota) return;
        const changed = quotaSignature(quotaSummary) !== quotaSignature(nextQuota);
        quotaSummary = nextQuota;
        if (changed) {
          broadcast('state:sync', snapshotState());
        }
      })
      .catch(() => {})
      .finally(() => {
        quotaPending = false;
      });
  }

  subagentTracker = new SubagentTracker({
    watcher,
    getMainSettings: () => settings,
    getWatchedRootIds: () => {
      const ids = new Set();
      if (activeConversationId) ids.add(activeConversationId);
      for (const s of sessions.values()) ids.add(s.conversationId);
      const now = Date.now();
      for (const proj of antigravityProjects) {
        for (const c of proj.conversations || []) {
          if (c.conversationId && now - (c.updatedAt || 0) < 30 * 60 * 1000) {
            ids.add(c.conversationId);
          }
        }
      }
      return Array.from(ids);
    },
    onChange: () => {
      broadcast('state:sync', snapshotState());
    },
    onReaction: (ev) => {
      broadcast('pet:Reaction', ev);
    },
  });

  function ensureSession(payload) {
    const rawCid = payload.conversationId || 'default-session';
    const cid = linkedCliToOwner.get(rawCid) || rawCid;
    let s = sessions.get(cid);
    const catalogHit = findCatalogConversation(cid);
    const candidateWs = Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]
      ? payload.workspacePaths[0]
      : (catalogHit?.convo?.workspacePath || s?.workspacePath || settings.defaultWorkspace);
    const workspacePath = sanitizeWorkspace(candidateWs);
    const matchedProj = catalogHit?.proj || findCatalogProjectByPath(workspacePath);
    const projectId = payload.projectId || s?.projectId || matchedProj?.id || '';
    const projectName = payload.projectName || s?.projectName || matchedProj?.name || path.basename(workspacePath);
    const title = payload.title || catalogHit?.convo?.title || s?.title || '';
    const resolvedTranscript =
      payload.transcriptPath || catalogHit?.convo?.transcriptPath || s?.transcriptPath || (!cid.startsWith('proj-') && !cid.startsWith('mini-') ? findTranscriptPath(cid) : '');

    if (!s) {
      s = {
        conversationId: cid,
        cliCompanionId: isNativeCliSession(cid, resolvedTranscript) ? cid : null,
        projectId,
        projectName,
        title,
        workspacePath,
        transcriptPath: resolvedTranscript,
        modelName: payload.modelName || 'auto',
        status: 'IDLE',
        badge: '待机摸鱼中～',
        lastThinking: '',
        lastUserInput: payload.lastUserInput || '',
        lastAssistantReply: '',
        telemetry: resolvedTranscript ? readInitialTranscriptTelemetry(resolvedTranscript) : null,
        lastInvocationStartMs: 0,
        messages: [],
        updatedAt: catalogHit?.convo?.updatedAt || Date.now(),
      };
      sessions.set(cid, s);
      refreshSessionTelemetry(cid);
    } else {
      if (resolvedTranscript && cid === rawCid) s.transcriptPath = resolvedTranscript;
      if (payload.modelName) s.modelName = payload.modelName;
      if (workspacePath) s.workspacePath = workspacePath;
      if (projectId) s.projectId = projectId;
      if (projectName) s.projectName = projectName;
      if (title) s.title = title;
      if (payload.lastUserInput) s.lastUserInput = payload.lastUserInput;
      if (!s.cliCompanionId && isNativeCliSession(cid, s.transcriptPath)) {
        s.cliCompanionId = cid;
      }
      if (!payload.preserveTimestamp) {
        s.updatedAt = Date.now();
      }
    }

    if (projectId && settings.selectedProjectId !== projectId && !payload.preserveSelection) {
      settings.selectedProjectId = projectId;
    }
    if (workspacePath && !settings.savedProjects.includes(workspacePath)) {
      settings.savedProjects.unshift(workspacePath);
      saveSettings(settings);
    }

    if (!payload.preserveSelection) {
      activeConversationId = cid;
    }
    if (s.transcriptPath) {
      watcher.attach(cid, s.transcriptPath);
    }

    if (settings.autoSchemeByModel && payload.modelName) {
      const autoScheme = detectSchemeForModel(payload.modelName);
      if (autoScheme && autoScheme !== settings.scheme) {
        settings.scheme = autoScheme;
        saveSettings(settings);
        broadcast('pet:scheme', { scheme: settings.scheme, outfit: settings.outfit });
      }
    }
    return s;
  }

  const telemetryPending = new Set();
  function refreshSessionTelemetry(cid) {
    if (!cid || cid.startsWith('proj-') || cid.startsWith('mini-') || telemetryPending.has(cid)) return;
    telemetryPending.add(cid);
    readLatestDbTelemetry(cid)
      .then((tel) => {
        if (!tel) return;
        const s = sessions.get(cid);
        if (!s) return;
        const prev = s.telemetry;
        const changed =
          !prev ||
          prev.contextUsed !== tel.contextUsed ||
          prev.contextLimit !== tel.contextLimit ||
          prev.overallTokPerSec !== tel.overallTokPerSec ||
          prev.streamTokPerSec !== tel.streamTokPerSec ||
          prev.outputTokens !== tel.outputTokens ||
          Boolean(prev.compacted) !== Boolean(tel.compacted);
        s.telemetry = tel;
        if (changed) {
          broadcast('state:sync', snapshotState());
        }
      })
      .catch(() => {})
      .finally(() => {
        telemetryPending.delete(cid);
      });
  }

  function applySessionCanceled(s, { quiet = false, announce = true } = {}) {
    if (!s) return;
    s.status = 'AWAITING_NEXT';
    s.lastCancelAt = Date.now();
    const label = shortTitleLabel(s.title || s.projectName);
    s.badge = label ? `⏸️ 已取消 · ${label}` : '⏸️ 已暂停，等待下一步指令';
    for (const [aid, appr] of pendingApprovals.entries()) {
      if (appr.conversationId === s.conversationId) {
        clearTimeout(appr.timer);
        pendingApprovals.delete(aid);
        try { appr.resolve({ decision: 'deny', reason: 'Canceled by user' }); } catch {}
      }
    }
    subagentTracker?.handleParentCanceled?.(s.conversationId);
    if (!quiet) {
      broadcast('pet:Reaction', {
        expression: announce ? 'surprised' : 'neutral',
        motion: announce ? 'look' : null,
        speech: announce ? '已紧急刹车！下一步想怎么改告诉我吧～' : undefined,
        badge: s.badge,
        thinking: false,
      });
      broadcast('state:sync', snapshotState());
    }
  }

  function popQueuedMessages(cid) {
    const items = [];
    for (const key of [cid, '__any__']) {
      const q = queuedMessages.get(key);
      if (q && q.length > 0) {
        items.push(...q.splice(0, q.length));
      }
    }
    return items;
  }

  function dockToLatestSession(cid, opts = {}) {
    if (!cid || isSubagentCid(cid, opts.transcriptPath)) return null;
    const prevActive = activeConversationId;
    const catalogHit = findCatalogConversation(cid);
    const s = ensureSession({
      conversationId: cid,
      projectId: opts.projectId || catalogHit?.proj?.id,
      projectName: opts.projectName || catalogHit?.proj?.name,
      title: opts.title || catalogHit?.convo?.title,
      workspacePaths: opts.workspacePath
        ? [opts.workspacePath]
        : catalogHit?.convo?.workspacePath
        ? [catalogHit.convo.workspacePath]
        : undefined,
      transcriptPath: opts.transcriptPath || catalogHit?.convo?.transcriptPath,
      preserveTimestamp: true,
      preserveSelection: true,
    });

    if (opts.timestampMs && opts.timestampMs > (s.updatedAt || 0)) {
      s.updatedAt = opts.timestampMs;
    }

    if (prevActive !== cid) {
      activeConversationId = cid;
      const label = shortTitleLabel(s.title || s.projectName);
      if (s.status === 'IDLE' || s.status === 'AWAITING_NEXT') {
        s.badge = label ? `🐳 当前会话: ${label}` : '🐳 已自动对接最新会话';
      }
      refreshSessionTelemetry(cid);
      if (opts.announceSwitch && prevActive) {
        broadcast('pet:Reaction', {
          expression: 'happy',
          motion: 'look',
          badge: s.badge,
          thinking: false,
        });
      }
      broadcast('state:sync', snapshotState());
    }
    return s;
  }

  async function handleHookEvent(eventName, payload) {
    const rawCid = payload.conversationId || '';
    const isSubagentTurn = Boolean(rawCid && isSubagentCid(rawCid, payload.transcriptPath));

    // If a child subagent / swarm worker triggers hooks, track its nested subagent/swarm calls
    // without overwriting the user's active root conversation in the console!
    if (isSubagentTurn) {
      if (eventName === 'PreToolUse') {
        const tc = payload.toolCall || {};
        const toolName = tc.name || 'tool';
        const args = tc.args || {};
        subagentTracker.handleLiveToolCall(rawCid, toolName, args);
        if (toolName === 'run_command') {
          const cmd = String(args.CommandLine || '').trim();
          const shouldIntercept = settings.interceptAllCommands || (settings.interceptRiskyOnly && RISKY_CMD_REGEX.test(cmd));
          if (shouldIntercept && wss.clients.size > 0) {
            return await requestPetApproval(rawCid, toolName, cmd, args.toolSummary || '');
          }
        }
        return { decision: 'ask' };
      }
      if (eventName === 'Stop') {
        subagentTracker.handleSessionStopped(rawCid, payload);
        return { decision: 'stop' };
      }
      return {};
    }

    const s = ensureSession(payload);

    switch (eventName) {
      case 'SessionStart': {
        s.status = 'IDLE';
        s.badge = `✨ 新会话已连接 (${shortPath(s.workspacePath) || 'Workspace'})`;
        broadcast('pet:Reaction', {
          expression: 'happy',
          motion: 'wave',
          speech: '主人好呀～新会话已经连上啦！随时听候差遣～',
          badge: s.badge,
          thinking: false,
        });
        broadcast('state:sync', snapshotState());
        return {};
      }

      case 'PreInvocation': {
        s.status = 'THINKING';
        s.lastInvocationStartMs = Date.now();
        s.badge = '💭 正在深度思考中…';
        broadcast('pet:Reaction', {
          expression: 'thinking',
          motion: null,
          badge: s.badge,
          thinking: true,
        });
        broadcast('state:sync', snapshotState());
        return {};
      }

      case 'PreToolUse': {
        const tc = payload.toolCall || {};
        const toolName = tc.name || 'tool';
        const args = tc.args || {};
        subagentTracker.handleLiveToolCall(s.conversationId, toolName, args);
        const pres = mapToolPresentation(toolName, args);
        s.status = pres.status;
        s.badge = pres.badge;

        broadcast('pet:Reaction', {
          expression: pres.expression,
          motion: pres.motion,
          badge: pres.badge,
          thinking: pres.thinking,
        });
        broadcast('state:sync', snapshotState());

        // Check if this tool call should trigger interactive approval on the desktop pet
        if (toolName === 'run_command') {
          const cmd = String(args.CommandLine || '').trim();
          const shouldIntercept = settings.interceptAllCommands || (settings.interceptRiskyOnly && RISKY_CMD_REGEX.test(cmd));
          if (shouldIntercept && wss.clients.size > 0) {
            return await requestPetApproval(s.conversationId, toolName, cmd, args.toolSummary || '');
          }
        }
        // Respect Antigravity's standard permission cache ("ask" prompts only when not already allowed)
        return { decision: 'ask' };
      }

      case 'PostToolUse': {
        if (payload.error) {
          const shortErr = String(payload.error).slice(0, 80);
          s.status = 'ERROR';
          s.badge = `💦 工具报错: ${shortErr}`;
          broadcast('pet:Reaction', {
            expression: 'flustered',
            motion: 'shiver',
            speech: `呜哇，刚才的命令报错了：${shortErr}`,
            badge: s.badge,
            thinking: false,
          });
          broadcast('state:sync', snapshotState());
        }
        return {};
      }

      case 'PostInvocation': {
        refreshSessionTelemetry(s.conversationId);
        refreshQuotaSummary();
        setTimeout(() => refreshQuotaSummary(), 1400);
        const queued = popQueuedMessages(s.conversationId);
        if (queued.length > 0) {
          const combined = queued.map((m) => m.text).join('\n');
          s.messages.push({ role: 'user', text: combined, via: 'pet-queue', ts: Date.now() });
          s.badge = '📨 已注入桌宠排队指令！';
          broadcast('pet:Reaction', {
            expression: 'excited',
            motion: 'nod',
            speech: `收到补充指令，马上继续干活！`,
            badge: s.badge,
            thinking: true,
          });
          broadcast('state:sync', snapshotState());
          return {
            injectSteps: [{ userMessage: combined }],
            terminationBehavior: 'force_continue',
          };
        }
        return {};
      }

      case 'Stop': {
        const queued = popQueuedMessages(s.conversationId);
        if (queued.length > 0) {
          const combined = queued.map((m) => m.text).join('\n');
          s.messages.push({ role: 'user', text: combined, via: 'pet-stop-hook', ts: Date.now() });
          s.badge = '🚀 接力执行桌宠下一条指令…';
          broadcast('pet:Reaction', {
            expression: 'excited',
            motion: 'jump',
            speech: '收到下一步命令，继续冲鸭！',
            badge: s.badge,
            thinking: true,
          });
          broadcast('state:sync', snapshotState());
          return {
            decision: 'continue',
            reason: `用户在桌宠下达了下一步指令，请立即按此继续执行：\n${combined}`,
          };
        }

        const reason = String(payload.terminationReason || 'NO_TOOL_CALL');
        if (reason === 'ERROR' || payload.error) {
          s.status = 'ERROR';
          s.badge = `🚨 执行异常中断 (${reason})`;
          for (const [aid, appr] of pendingApprovals.entries()) {
            if (appr.conversationId === s.conversationId) {
              clearTimeout(appr.timer);
              pendingApprovals.delete(aid);
              try { appr.resolve({ decision: 'deny', reason: 'Turn errored' }); } catch {}
            }
          }
          broadcast('pet:Reaction', {
            expression: 'cry',
            motion: 'shiver',
            speech: `任务遇到错误停下来了，要点「自动修复」让我接着看吗？`,
            badge: s.badge,
            thinking: false,
          });
        } else if (/CANCEL/i.test(reason)) {
          applySessionCanceled(s, { quiet: false, announce: true });
          refreshSessionTelemetry(s.conversationId);
          return { decision: 'stop' };
        } else {
          s.status = 'AWAITING_NEXT';
          s.badge = '🎉 本轮任务已完成';
          broadcast('pet:Reaction', {
            expression: 'happy',
            motion: 'hop',
            speech: '本轮任务搞定啦～',
            badge: s.badge,
            thinking: false,
          });
        }
        refreshSessionTelemetry(s.conversationId);
        broadcast('state:sync', snapshotState());
        return { decision: 'stop' };
      }

      default:
        return {};
    }
  }

  function requestPetApproval(conversationId, toolName, commandLine, summary) {
    const id = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    onShowPanel?.();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        broadcast('state:sync', snapshotState());
        resolve({ decision: 'ask' });
      }, 85000);

      pendingApprovals.set(id, {
        id,
        conversationId,
        toolName,
        commandLine,
        summary,
        createdAt: Date.now(),
        timer,
        resolve: (decision, reason) => {
          clearTimeout(timer);
          pendingApprovals.delete(id);
          broadcast('state:sync', snapshotState());
          resolve(reason ? { decision, reason } : { decision });
        },
      });

      broadcast('pet:Reaction', {
        expression: 'surprised',
        motion: 'wave',
        speech: `主人！检测到敏感终端命令，快帮我点一下允许或拦截～`,
        badge: '🛡️ 等待审批危险命令',
        thinking: false,
      });
      broadcast('state:sync', snapshotState());
    });
  }

  function handleMcpNotify(body) {
    const cid = body.conversationId || activeConversationId || 'mcp-session';
    const s = ensureSession({ conversationId: cid });
    if (body.message) s.badge = body.message.slice(0, 48);
    broadcast('pet:Reaction', {
      expression: body.expression || 'happy',
      motion: body.motion || 'wave',
      speech: body.message || '',
      badge: s.badge,
      thinking: false,
    });
    broadcast('state:sync', snapshotState());
  }

  function handleMcpAwaitCommand(body) {
    const latestDesktop = Array.from(sessions.values())
      .filter((x) => !x.conversationId.startsWith('proj-') && !x.conversationId.startsWith('mini-') && !isNativeCliSession(x.conversationId, x.transcriptPath))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const cid = body.conversationId || latestDesktop?.conversationId || activeConversationId || 'mcp-session';
    const s = ensureSession({ conversationId: cid });
    const summary = String(body.summary || '本轮任务已完成～');

    s.status = 'AWAITING_NEXT';
    s.lastAssistantReply = summary;
    s.badge = '🎉 本轮已完成';
    refreshSessionTelemetry(cid);

    broadcast('pet:Reaction', {
      expression: 'happy',
      motion: 'wave',
      speech: summary.length > 110 ? summary.slice(0, 108) + '…' : summary,
      badge: s.badge,
      thinking: false,
      openMiniBar: false,
    });
    broadcast('state:sync', snapshotState());
    return Promise.resolve({ nextInstruction: '', endCompanion: true, nonBlockingSync: true });
  }

  /**
   * Unified command dispatcher from Whale Girl Mini Command Bar.
   */
  function dispatchUserCommand({ text, targetConversationId, mode, cwd }) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: 'Empty command' };

    // 1. If there is a pending MCP await-command call FOR THIS TARGET SESSION, satisfy it immediately!
    const waitEntry = targetConversationId
      ? Array.from(pendingMcpWaits.values()).find((w) => w.conversationId === targetConversationId)
      : Array.from(pendingMcpWaits.values())[0];

    if (waitEntry && mode !== 'standalone-new') {
      const s = sessions.get(waitEntry.conversationId);
      if (s) {
        s.messages.push({ role: 'user', text: trimmed, via: 'mcp-companion', ts: Date.now() });
        s.status = 'THINKING';
        s.badge = '💭 已回传主窗口会话执行…';
      }
      waitEntry.resolve({ nextInstruction: trimmed, endCompanion: false });
      broadcast('pet:Reaction', {
        expression: 'determined',
        motion: 'nod',
        speech: '好嘞！已经传回主会话继续执行啦～',
        badge: '💭 已回传主窗口会话执行…',
        thinking: true,
      });
      broadcast('state:sync', snapshotState());
      return { ok: true, delivery: 'mcp-live' };
    }

    // 2. If target session in Companion mode is currently busy running tools/thinking, queue it for PostInvocation/Stop injection!
    const targetSession = targetConversationId ? sessions.get(targetConversationId) : null;
    const isBusy = targetSession && ['THINKING', 'READING', 'CODING', 'RUNNING_CMD'].includes(targetSession.status);

    if (mode === 'companion' && isBusy && !runner.isRunning) {
      const key = targetSession.conversationId;
      const list = queuedMessages.get(key) || [];
      list.push({ id: `q-${Date.now()}`, text: trimmed, createdAt: Date.now() });
      queuedMessages.set(key, list);
      broadcast('pet:Reaction', {
        expression: 'wink',
        motion: 'nod',
        speech: '记在小本本上啦！等这一步跑完马上接力执行～',
        badge: `⏳ 已排队 ${list.length} 条后续指令`,
      });
      broadcast('state:sync', snapshotState());
      return { ok: true, delivery: 'hook-queue' };
    }

    // 3. Otherwise (Standalone Mini mode OR continuing from an idle session): run via `agy.exe` CLI stream-json!
    let ownerSession = targetSession;
    const selectedProjObj =
      antigravityProjects.find((p) => p.id === settings.selectedProjectId) ||
      antigravityProjects[0] ||
      null;

    if (mode === 'standalone-new' || !ownerSession) {
      const newLocalId = `proj-${Date.now().toString(36)}`;
      ownerSession = ensureSession({
        conversationId: newLocalId,
        projectId: selectedProjObj?.id || '',
        projectName: selectedProjObj?.name || '',
        title: trimmed.slice(0, 36),
        workspacePaths: [cwd || selectedProjObj?.workspacePath || settings.defaultWorkspace],
        lastUserInput: trimmed,
      });
    } else if (!ownerSession.title || ownerSession.title.startsWith('✨')) {
      ownerSession.title = trimmed.slice(0, 36);
    }

    const workspaceDir = sanitizeWorkspace(
      cwd || ownerSession.workspacePath || selectedProjObj?.workspacePath || settings.defaultWorkspace
    );
    ownerSession.workspacePath = workspaceDir;

    // Only pass --conversation when we have a valid `antigravity-cli` trajectory UUID!
    // Passing an Antigravity Desktop GUI UUID to `agy.exe --conversation` fails with `trajectory not found`.
    const cliResumeId = mode === 'standalone-new'
      ? null
      : (ownerSession.cliCompanionId || (isNativeCliSession(ownerSession.conversationId, ownerSession.transcriptPath) ? ownerSession.conversationId : null));

    let effectivePrompt = trimmed;
    if (!cliResumeId && mode !== 'standalone-new' && (ownerSession.lastUserInput || ownerSession.lastAssistantReply)) {
      const ctxSnippet = (ownerSession.lastAssistantReply || '').slice(0, 500);
      effectivePrompt =
        `[桌面会话上下文参考（项目: ${ownerSession.projectName || workspaceDir}）：\n` +
        (ownerSession.title ? `- 会话标题：${ownerSession.title}\n` : '') +
        (ownerSession.lastUserInput ? `- 最近用户问题：${ownerSession.lastUserInput.slice(0, 200)}\n` : '') +
        (ctxSnippet ? `- 最近助手结论摘要：${ctxSnippet}\n` : '') +
        `]\n\n请直接针对以下新指令作答或执行操作：\n${trimmed}`;
    }

    ownerSession.lastUserInput = trimmed;
    ownerSession.messages.push({ role: 'user', text: trimmed, via: 'agy-cli', ts: Date.now() });
    if (ownerSession.messages.length > 40) ownerSession.messages.shift();
    ownerSession.status = 'THINKING';
    ownerSession.badge = '🚀 正在通过 agy 执行指令…';
    activeConversationId = ownerSession.conversationId;

    runner.runTurn({
      prompt: effectivePrompt,
      ownerSessionId: ownerSession.conversationId,
      cliConversationId: cliResumeId,
      projectId: ownerSession.projectId || selectedProjObj?.id || null,
      cwd: workspaceDir,
    });

    broadcast('pet:Reaction', {
      expression: 'determined',
      motion: 'jump',
      speech: cliResumeId ? '正在续接会话执行新命令～' : '收到指令，马上开干～',
      badge: '🚀 正在执行指令…',
      thinking: true,
    });
    broadcast('state:sync', snapshotState());
    return { ok: true, delivery: 'agy-cli', resumedConversationId: cliResumeId || null };
  }

  // Wire TranscriptWatcher real-time events (both root conversations and recursive subagent/swarm trees)
  watcher.on('step', (ev) => {
    subagentTracker.handleTranscriptStep(ev);

    if (subagentTracker.isChildConversation(ev.conversationId) || knownChildIds.has(ev.conversationId)) {
      return;
    }
    let s = sessions.get(ev.conversationId);
    if (!s && !ev.quiet && !isSubagentCid(ev.conversationId)) {
      s = dockToLatestSession(ev.conversationId, { timestampMs: Date.now(), announceSwitch: true });
    }
    if (!s) return;
    if (!ev.quiet) {
      s.updatedAt = Date.now();
      if (activeConversationId !== ev.conversationId) {
        dockToLatestSession(ev.conversationId, { timestampMs: Date.now(), announceSwitch: true });
      }
    }

    if (ev.kind === 'compacted') {
      const prevLimit = s.telemetry?.contextLimit || (Number(ev.step?.input_tokens || 0) > 256000 ? 512000 : 256000);
      s.telemetry = buildCompactedTelemetry(
        ev.step?.output_tokens || 0,
        prevLimit,
        ev.step?.input_tokens || 0
      );
      if (!ev.quiet) {
        s.badge = '🗜️ 上下文已压缩';
        refreshSessionTelemetry(ev.conversationId);
        broadcast('pet:Reaction', {
          expression: 'happy',
          motion: 'nod',
          badge: s.badge,
          thinking: false,
        });
        broadcast('state:sync', snapshotState());
      }
      return;
    }

    if (ev.kind === 'usage') {
      s.telemetry = buildTranscriptTelemetry(ev.step, s.telemetry, s.lastInvocationStartMs);
      if (!ev.quiet) {
        refreshSessionTelemetry(ev.conversationId);
        refreshQuotaSummary();
        broadcast('state:sync', snapshotState());
      }
      return;
    }

    if (ev.kind === 'thinking') {
      s.lastThinking = ev.text;
      if (!ev.quiet) {
        broadcast('pet:thinking', { conversationId: ev.conversationId, text: ev.text });
      }
    } else if (ev.kind === 'assistant_reply') {
      s.lastAssistantReply = ev.text;
      if (ev.finalTurn) {
        s.status = 'AWAITING_NEXT';
        const label = shortTitleLabel(s.title || s.projectName);
        s.badge = label ? `🎉 已完成 · ${label}` : '🎉 本轮回复已完成';
      }
      // Avoid duplicating identical consecutive assistant messages
      const lastMsg = s.messages[s.messages.length - 1];
      if (!lastMsg || lastMsg.text !== ev.text) {
        s.messages.push({ role: 'assistant', text: ev.text, ts: Date.parse(ev.createdAt) || Date.now() });
        if (s.messages.length > 40) s.messages.shift();
      }
      if (!ev.quiet) {
        broadcast('pet:assistant', { conversationId: ev.conversationId, text: ev.text });
        broadcast('state:sync', snapshotState());
      }
    } else if (ev.kind === 'user_input') {
      s.lastUserInput = ev.text;
      if (!s.title || s.title === '新对话') s.title = ev.text.slice(0, 36);
      s.status = 'THINKING';
      s.badge = `💭 正在处理: ${shortTitleLabel(ev.text, 16)}`;
      const lastMsg = s.messages[s.messages.length - 1];
      if (!lastMsg || lastMsg.text !== ev.text) {
        s.messages.push({ role: 'user', text: ev.text, ts: Date.parse(ev.createdAt) || Date.now() });
        if (s.messages.length > 40) s.messages.shift();
      }
      if (!ev.quiet) {
        // Auto-yield any pending MCP wait if user typed directly in the main Desktop window
        for (const w of pendingMcpWaits.values()) {
          if (w.conversationId === ev.conversationId) {
            w.resolve({ nextInstruction: '', endCompanion: false, yieldedToMainWindow: true });
          }
        }
        broadcast('state:sync', snapshotState());
      }
    } else if (ev.kind === 'tool_call') {
      const pres = mapToolPresentation(ev.toolName, ev.args);
      s.status = pres.status;
      s.badge = pres.badge;
      if (!ev.quiet) {
        activeConversationId = ev.conversationId;
        broadcast('pet:Reaction', {
          expression: pres.expression,
          motion: pres.motion,
          badge: pres.badge,
          thinking: pres.thinking,
        });
        broadcast('state:sync', snapshotState());
      }
    } else if (ev.kind === 'canceled') {
      applySessionCanceled(s, { quiet: ev.quiet, announce: !ev.quiet });
    } else if (ev.kind === 'turn_end') {
      if (s.status !== 'IDLE' && s.status !== 'AWAITING_NEXT') {
        s.status = 'AWAITING_NEXT';
        const label = shortTitleLabel(s.title || s.projectName);
        s.badge = label ? `🎉 已结束 · ${label}` : '🎉 本轮已结束';
        if (!ev.quiet) {
          broadcast('pet:Reaction', {
            expression: 'neutral',
            motion: null,
            badge: s.badge,
            thinking: false,
          });
          broadcast('state:sync', snapshotState());
        }
      }
    } else if (ev.kind === 'error_step') {
      if (/interrupt|cancel/i.test(ev.text || '')) {
        s.lastCancelAt = Date.now();
        s.status = 'AWAITING_NEXT';
        s.badge = '⏸️ 对话流已中断';
        if (!ev.quiet) {
          broadcast('pet:Reaction', {
            expression: 'surprised',
            motion: 'look',
            badge: s.badge,
            thinking: false,
          });
          broadcast('state:sync', snapshotState());
        }
      }
    } else if (ev.kind === 'ask_question') {
      s.status = 'WAITING_USER';
      s.badge = '❓ 主窗口正在向你提问确认！';
      if (!ev.quiet) {
        activeConversationId = ev.conversationId;
        broadcast('pet:Reaction', {
          expression: 'confused',
          motion: 'wave',
          speech: '主人～Antigravity 有个选择题等你拍板哦！',
          badge: s.badge,
          thinking: false,
        });
        broadcast('state:sync', snapshotState());
      }
    }
  });

  // Wire AgyRunner standalone/resumed CLI streaming events
  function bindCliIdToOwner(ownerSessionId, cliConversationId) {
    if (ownerSessionId && cliConversationId && ownerSessionId !== cliConversationId) {
      linkedCliToOwner.set(cliConversationId, ownerSessionId);
      const owner = sessions.get(ownerSessionId);
      if (owner) {
        owner.cliCompanionId = cliConversationId;
        const candidateTitle =
          owner.title && !owner.title.startsWith('✨') ? owner.title : owner.lastUserInput;
        if (candidateTitle) {
          saveConversationAnnotationTitle(cliConversationId, candidateTitle);
        }
      }
      // Merge & remove accidental duplicate entry if hooks created one milliseconds earlier
      if (sessions.has(cliConversationId)) {
        sessions.delete(cliConversationId);
      }
      if (activeConversationId === cliConversationId) {
        activeConversationId = ownerSessionId;
      }
    }
  }

  runner.on('delta', ({ ownerSessionId, cliConversationId, delta, fullText }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    s.lastAssistantReply = fullText;
    broadcast('pet:stream_delta', { conversationId: cid, delta, fullText });
  });

  runner.on('thinking', ({ ownerSessionId, cliConversationId, thinking }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    const short = thinking.trim().slice(-86);
    s.lastThinking = short;
    broadcast('pet:thinking', { conversationId: cid, text: short });
  });

  runner.on('tool', ({ ownerSessionId, cliConversationId, toolName, toolArgs }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    subagentTracker.handleLiveToolCall(cliConversationId || cid, toolName, toolArgs);
    const pres = mapToolPresentation(toolName, toolArgs);
    s.status = pres.status;
    s.badge = pres.badge;
    broadcast('pet:Reaction', {
      expression: pres.expression,
      motion: pres.motion,
      badge: pres.badge,
      thinking: pres.thinking,
    });
    broadcast('state:sync', snapshotState());
  });

  runner.on('done', ({ code, ownerSessionId, cliConversationId, reply, stderr }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    if (code === 0) {
      s.status = 'AWAITING_NEXT';
      s.badge = '🎉 指令执行完毕！';
      if (reply) {
        s.lastAssistantReply = reply;
        const lastMsg = s.messages[s.messages.length - 1];
        if (!lastMsg || lastMsg.text !== reply) {
          s.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
        }
      }
      broadcast('pet:Reaction', {
        expression: 'happy',
        motion: 'hop',
        speech: reply ? (reply.length > 100 ? reply.slice(0, 98) + '…' : reply) : '执行完成啦！',
        badge: s.badge,
        thinking: false,
      });
    } else {
      s.status = 'ERROR';
      s.badge = `🚨 agy 退出码 ${code}`;
      broadcast('pet:Reaction', {
        expression: 'flustered',
        motion: 'shiver',
        speech: `执行出错了：${(stderr || '未知错误').slice(0, 80)}`,
        badge: s.badge,
        thinking: false,
      });
    }
    broadcast('state:sync', snapshotState());
    refreshCatalog().catch(() => {});
  });

  function startNewConversationUnderProject(proj) {
    if (!proj) return null;
    settings.selectedProjectId = proj.id;
    if (proj.workspacePath) {
      settings.selectedProject = proj.workspacePath;
      settings.defaultWorkspace = proj.workspacePath;
    }
    saveSettings(settings);

    const newId = `proj-${Date.now().toString(36)}`;
    const s = ensureSession({
      conversationId: newId,
      projectId: proj.id,
      projectName: proj.name,
      title: '✨ 新对话',
      workspacePaths: [proj.workspacePath || settings.defaultWorkspace],
    });
    s.badge = `📂 已选中项目「${proj.name}」，请输入指令开启新对话`;
    s.status = 'IDLE';
    activeConversationId = newId;
    return s;
  }

  // WebSocket client connection from Renderer UI
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state:sync', payload: snapshotState(), ts: Date.now() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      const { type, payload = {} } = msg;
      if (type === 'ui:send_command') {
        dispatchUserCommand({
          text: payload.text,
          targetConversationId: payload.conversationId || activeConversationId,
          mode: payload.mode || settings.mode,
          cwd: payload.cwd,
        });
      } else if (type === 'ui:resolve_approval') {
        const appr = pendingApprovals.get(payload.id);
        if (appr) {
          appr.resolve(
            payload.decision === 'allow' ? 'allow' : 'deny',
            payload.decision === 'deny' ? (payload.reason || '用户在鲸鱼娘桌宠拦截了该命令') : undefined
          );
          broadcast('pet:Reaction', {
            expression: payload.decision === 'allow' ? 'happy' : 'determined',
            motion: payload.decision === 'allow' ? 'nod' : 'shake',
            speech: payload.decision === 'allow' ? '已放行命令～' : '已帮你拦下该命令！',
          });
        }
      } else if (type === 'ui:cancel_mcp_wait') {
        const w = pendingMcpWaits.get(payload.id);
        if (w) {
          w.resolve({ nextInstruction: '用户已结束桌宠值守模式，本轮无需其他操作。', endCompanion: true });
        }
      } else if (type === 'ui:stop_agy') {
        runner.stop();
        broadcast('state:sync', snapshotState());
      } else if (type === 'ui:select_project') {
        const proj = antigravityProjects.find((p) => p.id === payload.projectId);
        if (proj) {
          settings.selectedProjectId = proj.id;
          if (proj.workspacePath) {
            settings.selectedProject = proj.workspacePath;
          }
          saveSettings(settings);

          if (proj.conversations && proj.conversations.length > 0) {
            const topConvo = proj.conversations[0];
            ensureSession({
              conversationId: topConvo.conversationId,
              projectId: proj.id,
              projectName: proj.name,
              title: topConvo.title,
              workspacePaths: [topConvo.workspacePath || proj.workspacePath],
              transcriptPath: topConvo.transcriptPath,
              preserveTimestamp: true,
            });
            activeConversationId = topConvo.conversationId;
          } else {
            startNewConversationUnderProject(proj);
          }
          broadcast('state:sync', snapshotState());
        }
      } else if (type === 'ui:select_session') {
        const cid = payload.conversationId;
        if (!cid) return;
        const catalogHit = findCatalogConversation(cid);
        const sel = ensureSession({
          conversationId: cid,
          projectId: catalogHit?.proj?.id,
          projectName: catalogHit?.proj?.name,
          title: catalogHit?.convo?.title,
          workspacePaths: catalogHit?.convo?.workspacePath ? [catalogHit.convo.workspacePath] : undefined,
          transcriptPath: catalogHit?.convo?.transcriptPath,
          preserveTimestamp: true,
        });
        activeConversationId = cid;
        if (sel?.projectId) {
          settings.selectedProjectId = sel.projectId;
        }
        if (sel?.workspacePath) {
          settings.selectedProject = sel.workspacePath;
        }
        saveSettings(settings);
        broadcast('state:sync', snapshotState());
      } else if (type === 'ui:new_project_chat') {
        const proj =
          antigravityProjects.find((p) => p.id === (payload.projectId || settings.selectedProjectId)) ||
          findCatalogProjectByPath(payload.projectPath || settings.selectedProject) ||
          antigravityProjects[0];
        if (proj) {
          const s = startNewConversationUnderProject(proj);
          broadcast('pet:Reaction', {
            expression: 'excited',
            motion: 'wave',
            speech: `已在项目「${proj.name}」下准备好新对话～想做什么直接吩咐我吧！`,
            badge: s?.badge || `📂 项目「${proj.name}」新对话`,
            thinking: false,
          });
          broadcast('state:sync', snapshotState());
        }
      } else if (type === 'ui:update_settings') {
        settings = { ...settings, ...payload };
        saveSettings(settings);
        broadcast('state:sync', snapshotState());
      } else if (type === 'ui:test_spawn_subagent') {
        subagentTracker.spawnTestSubagent(payload);
      } else if (type === 'ui:clear_subagents') {
        subagentTracker.clearAll();
      } else if (type === 'ui:remove_subagent') {
        if (payload.id) {
          subagentTracker.removeById(payload.id);
        }
      } else if (type === 'ui:whale_diag') {
        whaleDiag = { ...payload, ts: Date.now() };
      }
    });
  });

  async function refreshCatalog() {
    try {
      const list = await loadAntigravityCatalog();
      if (list?.childIds) {
        for (const cid of list.childIds) knownChildIds.add(cid);
      }
      if (!Array.isArray(list) || list.length === 0) return;
      antigravityProjects = list;

      const allConvos = [];
      for (const proj of list) {
        for (const c of proj.conversations || []) {
          allConvos.push(c);
          const existing = sessions.get(c.conversationId);
          if (existing) {
            existing.projectId = proj.id;
            existing.projectName = proj.name;
            if (c.title && (!existing.title || existing.title === '新对话' || existing.title.startsWith('对话 '))) {
              existing.title = c.title;
              if ((existing.status === 'IDLE' || existing.status === 'AWAITING_NEXT') && activeConversationId === c.conversationId) {
                existing.badge = `🐳 当前会话: ${shortTitleLabel(c.title)}`;
              }
            }
            if (!existing.transcriptPath && c.transcriptPath) {
              existing.transcriptPath = c.transcriptPath;
              watcher.attach(c.conversationId, c.transcriptPath);
            }
          }
        }
      }

      // Sort globally by most recent view OR message activity (`updatedAt` = max(activityMs, viewTimeMs, transcriptMtimeMs))
      allConvos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      // Pre-attach TranscriptWatcher to top 8 most recent root conversations so any prompt in any open window switches in <50ms!
      // Also reconcile busy sessions back to AWAITING_NEXT/IDLE when SQLite conversation_summaries reports CASCADE_RUN_STATUS_IDLE
      // (covers manual Cancel mid-stream or tool abort if the Stop hook was skipped or delayed).
      const nowMs = Date.now();
      for (const c of allConvos.slice(0, 8)) {
        if (!sessions.has(c.conversationId)) {
          ensureSession({
            conversationId: c.conversationId,
            projectId: c.projectId,
            projectName: c.projectName,
            title: c.title,
            workspacePaths: [c.workspacePath],
            transcriptPath: c.transcriptPath,
            preserveTimestamp: true,
            preserveSelection: true,
          });
        } else if (String(c.status || '').toUpperCase().includes('IDLE')) {
          const existing = sessions.get(c.conversationId);
          const isBusy =
            existing &&
            ['THINKING', 'READING', 'CODING', 'RUNNING_CMD', 'WAITING_USER'].includes(existing.status);
          const lastBusyAt = Math.max(existing?.lastInvocationStartMs || 0, existing?.updatedAt || 0);
          if (isBusy && (c.updatedAt || 0) >= lastBusyAt - 200 && nowMs - lastBusyAt > 2500) {
            applySessionCanceled(existing, {
              quiet: c.conversationId !== activeConversationId,
              announce: false,
            });
          }
        }
      }

      // Also scan `brain/` for brand-new conversations created in the last 20 seconds before SQLite summary flushes
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      if (fs.existsSync(brainDir)) {
        const now = Date.now();
        try {
          for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
            if (!ent.isDirectory() || knownChildIds.has(ent.name)) continue;
            const tp = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
            if (!fs.existsSync(tp)) continue;
            const st = fs.statSync(tp);
            if (now - st.mtimeMs < 20000 && !isSubagentCid(ent.name, tp)) {
              const s = sessions.get(ent.name) || ensureSession({
                conversationId: ent.name,
                transcriptPath: tp,
                preserveTimestamp: true,
                preserveSelection: true,
              });
              if (st.mtimeMs > (s.updatedAt || 0)) s.updatedAt = Math.floor(st.mtimeMs);
            }
          }
        } catch { /* ignore */ }
      }

      // Pick the globally newest root session across both catalog and live sessions
      let newestCid = allConvos[0]?.conversationId || null;
      let newestTs = allConvos[0]?.updatedAt || 0;
      for (const s of sessions.values()) {
        if (s.conversationId.startsWith('proj-') || s.conversationId.startsWith('mini-') || isSubagentCid(s.conversationId, s.transcriptPath)) {
          continue;
        }
        if ((s.updatedAt || 0) > newestTs) {
          newestTs = s.updatedAt || 0;
          newestCid = s.conversationId;
        }
      }

      if (newestCid) {
        const curActive = activeConversationId ? sessions.get(activeConversationId) : null;
        const shouldSwitch =
          !activeConversationId ||
          !curActive ||
          (newestCid !== activeConversationId && newestTs > (curActive.updatedAt || 0) + 500);

        if (shouldSwitch) {
          dockToLatestSession(newestCid, {
            timestampMs: newestTs,
            announceSwitch: Boolean(activeConversationId),
          });
        }
      }

      if (activeConversationId) {
        refreshSessionTelemetry(activeConversationId);
      }
      broadcast('state:sync', snapshotState());
    } catch {
      // Ignore transient DB/FS read error
    }
  }

  // Real-time `fs.watch` on `annotations/*.pbtxt`: detects tab switches & `+ New Chat` in Antigravity IDE in <50ms!
  let annotationWatcher = null;
  try {
    if (fs.existsSync(ANNOTATIONS_DIR)) {
      annotationWatcher = fs.watch(ANNOTATIONS_DIR, { persistent: false }, (_ev, filename) => {
        if (!filename || !filename.endsWith('.pbtxt')) return;
        const cid = filename.slice(0, -6);
        setTimeout(() => {
          if (isSubagentCid(cid)) return;
          const ann = readSingleAnnotation(cid);
          if (!ann || !ann.viewTimeMs) return;
          const curActive = activeConversationId ? sessions.get(activeConversationId) : null;
          if (!activeConversationId || (cid !== activeConversationId && ann.viewTimeMs >= (curActive?.updatedAt || 0) - 500)) {
            const s = dockToLatestSession(cid, {
              title: ann.title,
              timestampMs: ann.viewTimeMs,
              announceSwitch: true,
            });
            if (s && ann.title) {
              s.title = ann.title;
              if (s.status === 'IDLE' || s.status === 'AWAITING_NEXT') {
                s.badge = `🐳 当前会话: ${shortTitleLabel(ann.title)}`;
              }
              broadcast('state:sync', snapshotState());
            }
          }
        }, 40);
      });
      annotationWatcher.on('error', () => {});
    }
  } catch { /* fallback timer handles it */ }

  refreshCatalog();
  refreshQuotaSummary();
  const brainScanTimer = setInterval(refreshCatalog, 3000);
  brainScanTimer.unref?.();
  const quotaScanTimer = setInterval(refreshQuotaSummary, 25000);
  quotaScanTimer.unref?.();

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[BridgeServer] Port ${port} already in use; attaching to existing bridge.`);
          resolve({ port, reused: true });
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`[BridgeServer] Listening on http://127.0.0.1:${port}`);
        resolve({ port, reused: false });
      });
    });
  }

  function close() {
    clearInterval(brainScanTimer);
    clearInterval(quotaScanTimer);
    try { annotationWatcher?.close(); } catch { /* ignore */ }
    subagentTracker?.dispose();
    watcher.dispose();
    runner.stop();
    wss.close();
    server.close();
  }

  return {
    start,
    close,
    port,
    pushRendererLog: (entry) => { rendererLogs.push(entry); if (rendererLogs.length > 50) rendererLogs.shift(); },
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      if (patch.scheme || patch.outfit) {
        broadcast('pet:scheme', { scheme: settings.scheme, outfit: settings.outfit });
      }
      broadcast('state:sync', snapshotState());
    },
    spawnTestSubagent: (payload) => subagentTracker?.spawnTestSubagent(payload),
    clearSubagents: () => subagentTracker?.clearAll(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c.toString('utf8');
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

if (require.main === module && process.argv.includes('--standalone')) {
  const bridge = createBridgeServer();
  bridge.start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createBridgeServer, DEFAULT_PORT };
