const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { cleanUserContent } = require('./transcript-watcher.cjs');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.gemini', 'config', 'projects');
const ANNOTATIONS_DIR = path.join(HOME, '.gemini', 'antigravity', 'annotations');
const CLI_ANNOTATIONS_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'annotations');
const SUMMARIES_DB = path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
const APP_STORAGE_JSON = path.join(HOME, 'AppData', 'Roaming', 'Antigravity', 'app_storage.json');

const IGNORED_PROJECT_IDS = new Set([
  'default-cli-project',
  'f0c5f612-c2d4-4280-9da7-cc7249dfb2fd', // internal sidecar project
]);

const IGNORED_PROJECT_NAMES = new Set([
  'CLI Project',
  'agy-whale-pet/whale-pet',
]);

function decodeFileUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  try {
    const stripped = uri.replace(/^file:\/\/\//i, '');
    return decodeURIComponent(stripped).replace(/\\/g, '/');
  } catch {
    return uri;
  }
}

function formatRelativeTime(tsMs) {
  if (!tsMs || tsMs <= 0) return '';
  const diffSec = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function parseAnnotationPbtxt(raw, fallbackMtimeMs = 0) {
  const entry = {};
  const text = String(raw || '');
  const titleMatch = text.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
  if (titleMatch && titleMatch[1]) {
    try { entry.title = JSON.parse(`"${titleMatch[1]}"`); } catch { entry.title = titleMatch[1]; }
  }
  const viewMatch = text.match(/last_user_view_time:\s*\{[^}]*seconds:\s*(\d+)(?:[^}]*nanos:\s*(\d+))?/);
  const secMatch = viewMatch || text.match(/seconds:\s*(\d+)/);
  const nanosRaw = viewMatch ? viewMatch[2] : text.match(/nanos:\s*(\d+)/)?.[1];
  if (secMatch && secMatch[1]) {
    const secMs = Number(secMatch[1]) * 1000;
    const nanoMs = nanosRaw ? Math.floor(Number(nanosRaw) / 1e6) : 0;
    entry.viewTimeMs = secMs + nanoMs;
  } else if (fallbackMtimeMs > 0) {
    entry.viewTimeMs = Math.floor(fallbackMtimeMs);
  }
  return entry;
}

function readSingleAnnotation(cid) {
  if (!cid) return null;
  for (const dir of [ANNOTATIONS_DIR, CLI_ANNOTATIONS_DIR]) {
    const fp = path.join(dir, `${cid}.pbtxt`);
    if (!fs.existsSync(fp)) continue;
    try {
      const st = fs.statSync(fp);
      const raw = fs.readFileSync(fp, 'utf8');
      return parseAnnotationPbtxt(raw, st.mtimeMs);
    } catch { /* ignore */ }
  }
  return null;
}

function readAnnotationsMap() {
  /** @type {Map<string, { title?: string, viewTimeMs?: number }>} */
  const map = new Map();
  for (const dir of [ANNOTATIONS_DIR, CLI_ANNOTATIONS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.pbtxt')) continue;
      const cid = file.slice(0, -6);
      try {
        const fp = path.join(dir, file);
        const st = fs.statSync(fp);
        const raw = fs.readFileSync(fp, 'utf8');
        const parsed = parseAnnotationPbtxt(raw, st.mtimeMs);
        const existing = map.get(cid) || {};
        map.set(cid, {
          title: parsed.title || existing.title,
          viewTimeMs: Math.max(parsed.viewTimeMs || 0, existing.viewTimeMs || 0),
        });
      } catch {
        // Ignore malformed annotation file
      }
    }
  }
  return map;
}

function readProjectsOrder() {
  try {
    if (fs.existsSync(APP_STORAGE_JSON)) {
      const data = JSON.parse(fs.readFileSync(APP_STORAGE_JSON, 'utf8'));
      if (typeof data.projectsOrder === 'string') {
        const parsed = JSON.parse(data.projectsOrder);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch { /* ignore */ }
  return [];
}

function readProjectsMap() {
  /** @type {Map<string, any>} */
  const projects = new Map();
  if (!fs.existsSync(PROJECTS_DIR)) return projects;

  let files = [];
  try { files = fs.readdirSync(PROJECTS_DIR); } catch { return projects; }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(PROJECTS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const id = data.id;
      const name = data.name;
      if (!id || !name) continue;
      if (IGNORED_PROJECT_IDS.has(id) || IGNORED_PROJECT_NAMES.has(name)) continue;

      const resources = data?.projectResources?.resources || [];
      const workspacePaths = [];
      for (const r of resources) {
        const rawUri = r?.folderUri || r?.gitFolder?.folderUri || '';
        const decoded = decodeFileUri(rawUri);
        if (decoded) workspacePaths.push(decoded);
      }

      const st = fs.statSync(fullPath);
      projects.set(id, {
        id,
        name,
        workspacePath: workspacePaths[0] || '',
        workspacePaths,
        isRemote: false,
        updatedAt: Math.floor(st.mtimeMs),
        conversations: [],
      });
    } catch {
      // Ignore invalid project file
    }
  }
  return projects;
}

let cachedSummariesSig = '';
let cachedSummariesRows = null;

function querySummariesDb() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SUMMARIES_DB)) {
      resolve([]);
      return;
    }
    let nextSig = '';
    try {
      const st = fs.statSync(SUMMARIES_DB);
      const walPath = `${SUMMARIES_DB}-wal`;
      const walSt = fs.existsSync(walPath) ? fs.statSync(walPath) : null;
      nextSig = `${st.mtimeMs}:${st.size}:${walSt?.mtimeMs || 0}:${walSt?.size || 0}`;
      if (nextSig === cachedSummariesSig && cachedSummariesRows) {
        resolve(cachedSummariesRows);
        return;
      }
    } catch { /* ignore */ }
    const pyScript = [
      'import sqlite3, json, sys',
      'conn = sqlite3.connect("file:" + sys.argv[1].replace("\\\\", "/") + "?mode=ro", uri=True)',
      'rows = conn.execute("SELECT conversation_id, title, project_id, workspace_uris, source, status, last_user_input_time, last_modified_time, parent_conversation_id, nesting_depth, agent_name FROM conversation_summaries ORDER BY last_modified_time DESC").fetchall()',
      'sys.stdout.buffer.write(json.dumps(rows, ensure_ascii=False).encode("utf-8"))',
    ].join('; ');

    const pyCandidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
    const tryExec = (idx) => {
      if (idx >= pyCandidates.length) {
        resolve([]);
        return;
      }
      execFile(
        pyCandidates[idx],
        ['-c', pyScript, SUMMARIES_DB],
        { windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            tryExec(idx + 1);
            return;
          }
          try {
            const rows = JSON.parse(stdout);
            if (nextSig) cachedSummariesSig = nextSig;
            cachedSummariesRows = rows;
            resolve(rows);
          } catch {
            resolve([]);
          }
        }
      );
    };
    tryExec(0);
  });
}

function findTranscriptPath(conversationId) {
  const candidates = [
    path.join(HOME, '.gemini', 'antigravity', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(HOME, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(HOME, '.gemini', 'antigravity-ide', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function extractFirstUserTitle(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(16384);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (String(obj.type || '').toUpperCase().includes('USER_INPUT')) {
          const cleaned = cleanUserContent(obj.content).replace(/\s+/g, ' ').trim();
          if (cleaned) return cleaned.slice(0, 36);
        }
      } catch { /* ignore partial line */ }
    }
  } catch { /* ignore */ } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return '';
}

/**
 * Write or update a human-readable title annotation for a newly created CLI conversation
 * so it displays a proper title in both Antigravity Desktop and the Whale Girl pet.
 */
function saveConversationAnnotationTitle(conversationId, title) {
  if (!conversationId || !title) return;
  const cleanTitle = String(title).replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!cleanTitle) return;
  try {
    fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
    const file = path.join(ANNOTATIONS_DIR, `${conversationId}.pbtxt`);
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8');
      if (/title:\s*"/.test(existing)) return;
    }
    const seconds = Math.floor(Date.now() / 1000);
    const pbtxt = `title:${JSON.stringify(cleanTitle)} last_user_view_time:{seconds:${seconds} nanos:0}`;
    fs.writeFileSync(file, pbtxt, 'utf8');
  } catch { /* ignore */ }
}

/**
 * Load Antigravity Projects and their grouped Conversations in the exact order shown in Antigravity's Projects sidebar.
 */
async function loadAntigravityCatalog() {
  const [projectsMap, annotationsMap, projectsOrder, dbRows] = await Promise.all([
    Promise.resolve(readProjectsMap()),
    Promise.resolve(readAnnotationsMap()),
    Promise.resolve(readProjectsOrder()),
    querySummariesDb(),
  ]);

  const pathToProjectId = new Map();
  for (const proj of projectsMap.values()) {
    for (const wp of proj.workspacePaths) {
      pathToProjectId.set(wp.toLowerCase(), proj.id);
    }
  }

  const childIds = new Set();
  const childParentMap = new Map();

  for (const row of dbRows) {
    const [cid, dbTitle, rawPid, rawWuris, source, status, userInputTime, mtime, parentId, nestingDepth, agentName] = row;
    const cleanParentId = parentId ? String(parentId).trim() : '';
    if (cid && cleanParentId) {
      childParentMap.set(cid, cleanParentId);
    }
    if (parentId || Number(nestingDepth || 0) > 0 || (agentName && String(agentName).trim())) {
      childIds.add(cid);
      continue; // Skip subagent & swarm worker trajectories
    }

    let pid = rawPid;
    let workspacePath = '';
    try {
      const uris = JSON.parse(rawWuris || '[]');
      if (Array.isArray(uris) && uris[0]) {
        workspacePath = decodeFileUri(uris[0]);
      }
    } catch { /* ignore */ }

    if ((!pid || !projectsMap.has(pid)) && workspacePath) {
      const matchedPid = pathToProjectId.get(workspacePath.toLowerCase());
      if (matchedPid) pid = matchedPid;
    }

    // Create synthetic workspace bucket if user opened a conversation in an unregistered folder
    if (!pid || !projectsMap.has(pid)) {
      if (IGNORED_PROJECT_IDS.has(pid)) continue;
      const fallbackId = workspacePath ? `ws:${workspacePath.toLowerCase()}` : 'ws:scratch';
      if (!projectsMap.has(fallbackId)) {
        const folderName = workspacePath ? path.basename(workspacePath) : '默认会话空间';
        if (IGNORED_PROJECT_NAMES.has(folderName)) continue;
        projectsMap.set(fallbackId, {
          id: fallbackId,
          name: folderName,
          workspacePath: workspacePath || '',
          workspacePaths: workspacePath ? [workspacePath] : [],
          isRemote: false,
          updatedAt: 0,
          conversations: [],
        });
      }
      pid = fallbackId;
    }

    const ann = annotationsMap.get(cid);
    const tPath = findTranscriptPath(cid);
    let realTitle = (ann?.title || dbTitle || '').trim();
    if (!realTitle && source !== 'CORTEX_TRAJECTORY_SOURCE_CLI') {
      realTitle = extractFirstUserTitle(tPath);
    }
    // Skip untitled internal CLI sub-runs unless they have an annotation title
    if (!realTitle && source === 'CORTEX_TRAJECTORY_SOURCE_CLI') continue;

    const proj = projectsMap.get(pid);
    const isRunning = String(status || '').includes('RUNNING');
    let activityMs = 0;
    const rawTime = isRunning
      ? (mtime || userInputTime)
      : ((userInputTime && !String(userInputTime).startsWith('0001')) ? userInputTime : mtime);
    if (rawTime && !String(rawTime).startsWith('0001')) {
      const iso = String(rawTime).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
      const parsed = Date.parse(iso);
      if (!Number.isNaN(parsed)) activityMs = parsed;
    }

    let transcriptMtimeMs = 0;
    try {
      if (tPath && fs.existsSync(tPath)) {
        transcriptMtimeMs = Math.floor(fs.statSync(tPath).mtimeMs);
      }
    } catch { /* ignore */ }

    const viewTimeMs = ann?.viewTimeMs || 0;
    const updatedAt = Math.max(activityMs, viewTimeMs, transcriptMtimeMs);

    proj.conversations.push({
      conversationId: cid,
      title: realTitle || `新对话`,
      projectId: pid,
      projectName: proj.name,
      workspacePath: workspacePath || proj.workspacePath,
      transcriptPath: tPath,
      updatedAt,
      viewTimeMs,
      activityMs,
      relativeTime: formatRelativeTime(updatedAt),
      status: isRunning ? 'RUNNING' : 'IDLE',
      source: source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ? 'CLI' : 'DESKTOP',
    });
  }

  for (const proj of projectsMap.values()) {
    proj.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    if (proj.conversations.length > 0) {
      proj.updatedAt = proj.conversations[0].updatedAt;
    }
  }

  const orderIndex = new Map(projectsOrder.map((id, idx) => [id, idx]));
  const unpinned = [];
  const pinned = [];

  for (const proj of projectsMap.values()) {
    if (orderIndex.has(proj.id)) {
      pinned.push(proj);
    } else {
      unpinned.push(proj);
    }
  }

  unpinned.sort((a, b) => b.updatedAt - a.updatedAt);
  pinned.sort((a, b) => (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999));

  const sortedProjects = [...unpinned, ...pinned];
  sortedProjects.childIds = childIds;
  sortedProjects.childParentMap = childParentMap;
  return sortedProjects;
}

/**
 * Inspect the first JSON line of a transcript to check if it is a subagent/swarm worker
 * (subagents start with `SYSTEM_MESSAGE` rather than `USER_INPUT`).
 */
function isTranscriptLikelySubagent(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytes).toString('utf8').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    if (!firstLine) return false;
    const obj = JSON.parse(firstLine);
    const t = String(obj.type || '').toUpperCase();
    return t.includes('SYSTEM_MESSAGE');
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  ANNOTATIONS_DIR,
  loadAntigravityCatalog,
  parseAnnotationPbtxt,
  readSingleAnnotation,
  isTranscriptLikelySubagent,
  findTranscriptPath,
  saveConversationAnnotationTitle,
  formatRelativeTime,
};
