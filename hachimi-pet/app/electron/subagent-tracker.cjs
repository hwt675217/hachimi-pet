const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findTranscriptPath } = require('./antigravity-catalog.cjs');
const { normalizeToolArgs } = require('./transcript-watcher.cjs');

const SCHEME_LIST = ['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian'];
const OUTFIT_LIST = ['maid'];

const LEGACY_SCHEME_MAP = {
  gemini: 'astral',
  deepseek: 'azure',
  claude: 'amber',
  minimax: 'sakura',
  qwen: 'astral',
  kimi: 'emerald',
  chatgpt: 'arctic',
  harness: 'obsidian',
};

function normalizeSchemeId(id) {
  const k = String(id || '').toLowerCase();
  if (SCHEME_LIST.includes(k)) return k;
  return LEGACY_SCHEME_MAP[k] || 'astral';
}

const BRAIN_ROOTS = [
  path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
];

function shortPathLabel(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-1)[0] || parts.slice(-2).join('/');
}

function friendlyRoleForType(typeName, rawRole) {
  const t = String(typeName || '').toLowerCase();
  if (rawRole && String(rawRole).trim()) return String(rawRole).trim();
  if (t === 'research') return '🔍 调研探查员';
  if (t === 'browser') return '🌐 浏览器特工';
  if (t === 'image-generator') return '🎨 视觉画师';
  if (t === 'self') return '🤖 镜像分身';
  if (t === 'teamwork') return '👑 团队哨兵';
  if (t === 'teamwork_interviewer') return '🎤 需求访谈官';
  if (t === 'teamwork_orchestrator') return '🧭 主调度官';
  if (t === 'teamwork_explorer') return '🔭 代码勘探员';
  if (t === 'teamwork_worker') return '🛠️ 核心工程师';
  if (t === 'teamwork_reviewer') return '📐 代码审查员';
  if (t === 'teamwork_challenger') return '⚔️ 红队挑战者';
  if (t === 'teamwork_auditor') return '⚖️ 终审审计官';
  return typeName ? `🧩 ${typeName}` : '🐳 协作子代理';
}

/**
 * Extract clean identity (`name`, `role`, `source`, `teamworkFolder`, `teamworkDir`) from `invoke_subagent` args.
 */
function extractSubagentIdentity(rawArgs = {}) {
  const args = normalizeToolArgs(rawArgs);
  const typeName = String(args.TypeName || args.type || '').trim();
  const rawRole = String(args.Role || args.role || '').trim();
  const prompt = String(args.Prompt || args.prompt || '');

  let teamworkDir = '';
  let teamworkFolder = '';
  const twFullMatch = prompt.match(/([a-zA-Z]:[\\/][^\r\n"']*?\.agents[\\/]+teamwork[\\/]+([a-zA-Z0-9_-]+))/i);
  const twRelMatch = prompt.match(/(\.agents[\\/]+teamwork[\\/]+([a-zA-Z0-9_-]+))/i);
  if (twFullMatch) {
    teamworkDir = twFullMatch[1].replace(/\\\\/g, '\\');
    teamworkFolder = twFullMatch[2];
  } else if (twRelMatch) {
    teamworkFolder = twRelMatch[2];
  }

  const isTeamwork =
    typeName.toLowerCase().startsWith('teamwork') ||
    Boolean(teamworkFolder);

  if (isTeamwork) {
    const cleanFolder =
      teamworkFolder && teamworkFolder.toLowerCase() !== 'original_request'
        ? teamworkFolder
        : typeName.replace(/^teamwork_?/i, '') || 'sentinel';
    const name = args.Name || cleanFolder || rawRole || typeName;
    const role = friendlyRoleForType(typeName, rawRole);
    return {
      name: String(name),
      role,
      typeName: typeName || 'teamwork',
      source: 'teamwork',
      teamworkFolder: cleanFolder,
      teamworkDir,
      initialBrief: summarizePromptBrief(prompt, rawRole || cleanFolder),
    };
  }

  const name = String(args.Name || rawRole || typeName || 'subagent').trim();
  const role = friendlyRoleForType(typeName, typeName ? friendlyRoleForType(typeName, '') : rawRole);
  return {
    name,
    role,
    typeName: typeName || 'subagent',
    source: 'subagent',
    teamworkFolder: '',
    teamworkDir: '',
    initialBrief: summarizePromptBrief(prompt, rawRole || name),
  };
}

function summarizePromptBrief(prompt, fallback = '准备执行子任务…') {
  if (!prompt || typeof prompt !== 'string') return fallback;
  const lines = prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
    .filter(
      (l) =>
        l.length > 4 &&
        !/^(Teamwork state folder|Your state folder|Your dispatch|Read the original|Relay to|Parameters:|Working directory:|Integrity mode:|<<<|REQUEST>>>)/i.test(l)
    );
  const pick = lines[0] || fallback;
  return pick.length > 44 ? pick.slice(0, 42) + '…' : pick;
}

function describeChildTool(toolName, rawArgs = {}) {
  const args = normalizeToolArgs(rawArgs);
  const n = String(toolName || '').toLowerCase();
  if (/read_file|view_file/.test(n)) {
    const f = shortPathLabel(args.Path || args.TargetFile || '');
    return `📖 读取 ${f || '文件'}`;
  }
  if (/grep_search|find_by_name|list_dir/.test(n)) {
    const q = String(args.Query || args.Pattern || shortPathLabel(args.SearchPath || args.DirectoryPath || '')).slice(0, 26);
    return `🔎 检索 ${q || '代码库'}`;
  }
  if (/write_file|edit_file|replace/.test(n)) {
    const f = shortPathLabel(args.Path || args.TargetFile || '');
    if (/handoff\.md$/i.test(f)) return '📝 撰写交付报告 handoff.md';
    if (/progress\.md$/i.test(f)) return '📊 同步任务进度表';
    return `✍️ 编写 ${f || '代码'}`;
  }
  if (/run_command/.test(n)) {
    const cmd = String(args.toolSummary || args.CommandLine || args.command || '').trim();
    return `⚡ 执行 ${cmd.slice(0, 30) || '终端命令'}`;
  }
  if (/search_web|read_url/.test(n)) {
    const q = String(args.query || args.Url || '').trim();
    return `🌐 搜索 ${q.slice(0, 28) || '网页资料'}`;
  }
  if (/browser|click|navigate|screenshot|evaluate/.test(n)) {
    return `🌐 操控浏览器页面…`;
  }
  if (/invoke_subagent/.test(n)) {
    return `🐳 派发下级代理: ${args.Role || args.TypeName || '子任务'}`;
  }
  if (/post_message/.test(n)) {
    return `📋 发布蜂群看板动态`;
  }
  if (/swarm_wait/.test(n)) {
    return `💤 看板待命监听中`;
  }
  if (/send_message/.test(n)) {
    return `📨 向上级汇报执行成果`;
  }
  return `🔧 调用 ${toolName}`;
}

/**
 * Inspect the tail of a child transcript on disk to determine whether its active turn has ended or parked.
 */
function inspectTranscriptActivity(transcriptPath, teamworkDir = '') {
  try {
    if (teamworkDir) {
      const handoffPath = path.join(teamworkDir, 'handoff.md');
      if (fs.existsSync(handoffPath)) {
        return {
          exists: true,
          finished: true,
          waitingOnSwarmBoard: false,
          hasRunningBgTask: false,
          activelyWorking: false,
          mtimeMs: fs.statSync(handoffPath).mtimeMs,
        };
      }
    }
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return { exists: false, finished: false, waitingOnSwarmBoard: false, hasRunningBgTask: false, activelyWorking: true, mtimeMs: Date.now() };
    }
    const stat = fs.statSync(transcriptPath);
    const tailLen = Math.min(stat.size, 65536);
    const buf = Buffer.alloc(tailLen);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    let lastPlanner = null;
    let pendingSwarmWait = false;
    let hasSwarmWaitDone = false;
    let wokeSinceLastPlanner = false;
    let serverRestarted = false;
    const runningBgTasks = new Set();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const t = String(obj.type || '').toUpperCase();
        const contentStr = typeof obj.content === 'string' ? obj.content : '';

        if (t.includes('SYSTEM_MESSAGE') && /stopped due to server restart/i.test(contentStr)) {
          serverRestarted = true;
          runningBgTasks.clear();
          continue;
        }

        if (t.includes('USER_INPUT') || t.includes('SYSTEM_MESSAGE')) {
          serverRestarted = false;
          const senderMatch = contentStr.match(/sender=([^\s\r\n>]+)/);
          if (senderMatch) {
            runningBgTasks.delete(senderMatch[1]);
          }
          runningBgTasks.delete('__bg__');
          // A new wake-up prompt/message arrived! Reset turn completion flags until model responds.
          lastPlanner = null;
          pendingSwarmWait = false;
          hasSwarmWaitDone = false;
          wokeSinceLastPlanner = true;
        } else if (t === 'PLANNER_RESPONSE') {
          serverRestarted = false;
          const st = String(obj.status || '').toUpperCase();
          if (st === 'ERROR') {
            // Transient planner stream/model error before automatic retry — do not treat as finished turn.
            continue;
          }
          lastPlanner = obj;
          wokeSinceLastPlanner = false;
          const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
          pendingSwarmWait = calls.some((c) => (c.name || c.tool_name) === 'swarm_wait');
          hasSwarmWaitDone = false;
          for (const c of calls) {
            if ((c.name || c.tool_name) === 'manage_task') {
              const a = normalizeToolArgs(c.args || {});
              if (String(a.Action || '').toLowerCase() === 'kill' && a.TaskId) {
                runningBgTasks.delete(String(a.TaskId));
              }
            }
          }
        } else if (t === 'GENERIC') {
          if (obj.status === 'RUNNING') {
            const taskMatch = contentStr.match(/task id:\s*([^\s\r\n"]+)/i);
            if (!pendingSwarmWait) {
              runningBgTasks.add(taskMatch ? taskMatch[1] : '__bg__');
            }
          }
          if (pendingSwarmWait && (obj.status === 'DONE' || obj.status === 'RUNNING')) {
            hasSwarmWaitDone = true;
          }
        }
      } catch { /* ignore partial line */ }
    }

    const calls = Array.isArray(lastPlanner?.tool_calls) ? lastPlanner.tool_calls : [];
    const hasRunningBgTask = runningBgTasks.size > 0 && Date.now() - stat.mtimeMs < 15 * 60 * 1000;
    const finished = Boolean(
      serverRestarted ||
      (lastPlanner && calls.length === 0 && !wokeSinceLastPlanner && !hasRunningBgTask)
    );
    const waitingOnSwarmBoard = Boolean(!serverRestarted && (pendingSwarmWait || hasSwarmWaitDone) && !wokeSinceLastPlanner);
    const activelyWorking = !finished && !waitingOnSwarmBoard;

    return {
      exists: true,
      finished,
      waitingOnSwarmBoard,
      hasRunningBgTask,
      activelyWorking,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { exists: false, finished: false, waitingOnSwarmBoard: false, hasRunningBgTask: false, activelyWorking: false, mtimeMs: Date.now() };
  }
}

/**
 * Determine whether a Swarm coordinator's board post is a genuine Swarm-wide completion announcement
 * (starts with `[done]` or `@all [done]`), as opposed to a task brief / follow-up mentioning `` `@coordinator [done]` ``.
 */
function isCoordinatorDonePost(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return false;
  return /^(?:@all\s+)?(?:\*\*)?\[done\](?:\*\*)?(?:\s|$|[:：,，.。!！\-—])/i.test(t);
}

/**
 * Inspect `board.jsonl` to check if coordinator's latest wave ended with `[done]` and get latest post per agent.
 */
function inspectSwarmBoard(boardPath) {
  const result = {
    isDone: false,
    doneSeq: 0,
    lastPostSeq: 0,
    lastCoordTaskSeq: 0,
    lastWorkerPostSeq: 0,
    hasWorkerPost: false,
    mtimeMs: 0,
    latestByAgent: new Map(),
  };
  try {
    if (!boardPath || !fs.existsSync(boardPath)) return result;
    const stat = fs.statSync(boardPath);
    result.mtimeMs = stat.mtimeMs;
    const tailLen = Math.min(stat.size, 65536);
    const buf = Buffer.alloc(tailLen);
    const fd = fs.openSync(boardPath, 'r');
    try {
      fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    for (const line of lines) {
      try {
        const post = JSON.parse(line);
        const agent = String(post.agent || post.sender || '').trim();
        const rawText = String(post.text || '');
        const text = rawText.replace(/\s+/g, ' ').trim();
        if (!agent) continue;
        const seq = Number(post.seq || 0);
        if (seq > result.lastPostSeq) result.lastPostSeq = seq;
        result.latestByAgent.set(agent, { seq, text });
        if (agent !== 'coordinator') {
          result.hasWorkerPost = true;
          if (seq > result.lastWorkerPostSeq) result.lastWorkerPostSeq = seq;
        } else if (isCoordinatorDonePost(rawText)) {
          result.isDone = true;
          result.doneSeq = seq;
        } else {
          // Coordinator posted a new brief / follow-up task (starts or resumes a wave after any earlier [done])
          result.isDone = false;
          if (seq > result.lastCoordTaskSeq) result.lastCoordTaskSeq = seq;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return result;
}

/**
 * Universal Multi-Pet Subagent & Swarm Tracker.
 * Immediately removes subagent pets when their task/turn finishes so the UI can play a clean fade-out animation.
 */
class SubagentTracker {
  /**
   * @param {{
   *   watcher: import('./transcript-watcher.cjs').TranscriptWatcher,
   *   getMainSettings: () => { scheme: string, outfit: string, defaultWorkspace?: string },
   *   getWatchedRootIds: () => string[],
   *   getActiveConversationId?: () => string | null,
   *   resolveCanonicalRootId?: (cid: string) => string | null,
   *   getParentConversationId?: (cid: string) => string | null,
   *   onChange: () => void,
   *   onReaction: (ev: any) => void,
   *   brainRoots?: string[],
   * }} deps
   */
  constructor({
    watcher,
    getMainSettings,
    getWatchedRootIds,
    getActiveConversationId,
    resolveCanonicalRootId,
    getParentConversationId,
    onChange,
    onReaction,
    brainRoots,
  }) {
    this.watcher = watcher;
    this.getMainSettings = getMainSettings;
    this.getWatchedRootIds = getWatchedRootIds;
    this.getActiveConversationId = getActiveConversationId;
    this.resolveCanonicalRootId = resolveCanonicalRootId;
    this.getParentConversationId = getParentConversationId;
    this.onChange = onChange;
    this.onReaction = onReaction;
    this.brainRoots = Array.isArray(brainRoots) ? brainRoots : BRAIN_ROOTS;

    /** @type {Map<string, any>} visualId -> SubagentItem & internal metadata */
    this.items = new Map();
    /** @type {Map<string, string>} childConversationId -> visualId */
    this.convToVisualId = new Map();
    /** @type {Map<string, any>} childConversationId -> remembered metadata for waking sleeping swarm/subagents */
    this.knownConvMeta = new Map();
    /** @type {Map<string, string[]>} parentConversationId -> FIFO queue of unbound visualIds */
    this.pendingByParent = new Map();
    /** @type {Set<string>} All conversationIds in the subagent tree */
    this.childConversations = new Set();
    /** @type {Set<string>} Permanently killed subagents & swarm keys */
    this.retiredKeys = new Set();
    /** @type {Map<string, { doneSeq: number, closedAt: number }>} Coordinator conversationIds whose latest Swarm wave posted `[done]` or finished */
    this.closedSwarms = new Map();

    this.seq = 1;
    this.pollTimer = setInterval(() => this._pollSwarmAndTeamworkFiles(), 1200);
    this.pollTimer.unref?.();
  }

  isChildConversation(cid) {
    return this.childConversations.has(cid);
  }

  _canonicalize(cid) {
    return cid ? (this.resolveCanonicalRootId?.(cid) || cid) : null;
  }

  _resolveRootConversationId(cid) {
    if (!cid) return null;
    let cur = this._canonicalize(cid);
    const seen = new Set();
    for (let hop = 0; hop < 10 && cur; hop++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const vid = this.convToVisualId.get(cur);
      const parent =
        this.knownConvMeta.get(cur)?.parentConversationId ||
        (vid ? this.items.get(vid)?.parentConversationId : null) ||
        this.getParentConversationId?.(cur) ||
        null;
      const next = this._canonicalize(parent);
      if (!next || next === cur || seen.has(next)) break;
      cur = next;
    }
    return cur;
  }

  _belongsToRoot(itemOrParentCid, targetRootId) {
    if (itemOrParentCid && typeof itemOrParentCid === 'object' && itemOrParentCid.source === 'test') {
      return true;
    }
    if (!targetRootId) return false;
    const cid =
      typeof itemOrParentCid === 'string'
        ? itemOrParentCid
        : (itemOrParentCid?.parentConversationId || itemOrParentCid?.childConversationId || null);
    if (!cid) return false;
    return this._resolveRootConversationId(cid) === this._canonicalize(targetRootId);
  }

  _isActiveRoot(parentOrItem) {
    const activeId = this.getActiveConversationId?.() || null;
    return this._belongsToRoot(parentOrItem, activeId);
  }

  hasActiveForParent(parentConversationId) {
    if (!parentConversationId) return false;
    for (const it of this.items.values()) {
      if (it.source === 'test') continue;
      if (this._belongsToRoot(it, parentConversationId)) {
        return true;
      }
    }
    const pendingList = this.pendingByParent.get(parentConversationId);
    if (pendingList && pendingList.some((p) => typeof p === 'string' && !p.startsWith('{') && this.items.has(p))) {
      return true;
    }
    return false;
  }

  getPublicList(activeConversationId) {
    const targetRootId =
      activeConversationId !== undefined
        ? activeConversationId
        : (this.getActiveConversationId?.() || null);
    return Array.from(this.items.values())
      .filter((it) => this._belongsToRoot(it, targetRootId))
      .map((it) => ({
        id: it.id,
        name: it.name,
        role: it.role,
        typeName: it.typeName,
        source: it.source,
        parentConversationId: it.parentConversationId || null,
        rootConversationId:
          it.source === 'test'
            ? null
            : this._resolveRootConversationId(it.parentConversationId || it.childConversationId),
        slotIndex: it.slotIndex,
        scheme: it.scheme,
        outfit: it.outfit,
        status: it.status,
        progressText: it.progressText,
        progressPercent: it.progressPercent,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  clearAll(activeConversationId = null) {
    let activeAffected = false;
    for (const it of Array.from(this.items.values())) {
      if (!activeConversationId || this._belongsToRoot(it, activeConversationId)) {
        if (this._isActiveRoot(it)) activeAffected = true;
        this._finishAndRemove(it.id, { permanent: true, silent: true });
      }
    }
    if (activeConversationId) {
      for (const parentCid of Array.from(this.pendingByParent.keys())) {
        if (this._belongsToRoot(parentCid, activeConversationId)) {
          this.pendingByParent.delete(parentCid);
        }
      }
    } else {
      this.pendingByParent.clear();
    }
    if (activeAffected) {
      this.onChange();
    }
  }

  removeById(id) {
    this._finishAndRemove(id, { permanent: true });
  }

  _isCoordinatorType(typeName) {
    const t = String(typeName || '').toLowerCase();
    return t === 'teamwork' || t === 'teamwork_orchestrator';
  }

  /**
   * Directly remove a finished subagent so the frontend immediately fades out & disposes its Whale Girl!
   */
  _finishAndRemove(id, { permanent = false, silent = false } = {}) {
    const it = this.items.get(id);
    if (!it) return;
    const wasActiveVisible = this._isActiveRoot(it);
    if (it.retireTimer) {
      clearTimeout(it.retireTimer);
      it.retireTimer = null;
    }

    if (it.childConversationId) {
      this.convToVisualId.delete(it.childConversationId);
      if (permanent) {
        this.retiredKeys.add(it.childConversationId);
        if (!this._isCoordinatorType(it.typeName)) {
          this.watcher.detach(it.childConversationId);
        }
      } else if (!this._isCoordinatorType(it.typeName) && it.source !== 'swarm' && it.typeName !== 'browser') {
        // One-shot worker subagents (`research`, `explorer`, `worker`, `reviewer`, `challenger`, `auditor`, `interviewer`)
        // never resume after completing their final turn — detach cleanly!
        this.retiredKeys.add(it.childConversationId);
        this.watcher.detach(it.childConversationId);
      }
    }

    if (permanent && it.swarmKey) {
      this.retiredKeys.add(it.swarmKey);
    }

    this.items.delete(id);
    if (!silent && wasActiveVisible) {
      this.onChange();
    }
  }

  _hasActiveDescendants(conversationId) {
    if (!conversationId) return false;
    for (const it of this.items.values()) {
      if (it.source === 'test') continue;
      if (
        it.parentConversationId === conversationId ||
        this._isDescendantOf(it.parentConversationId, conversationId)
      ) {
        return true;
      }
    }
    return false;
  }

  _isSwarmMemberWorkingOnDisk(coordinatorId, memberName, childCid) {
    if (!coordinatorId) return null;
    for (const brainRoot of this.brainRoots) {
      const membersPath = path.join(brainRoot, coordinatorId, '.system_generated', 'swarm', 'members.json');
      if (!fs.existsSync(membersPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
        const members = data?.members || {};
        const m =
          members[memberName] ||
          Object.values(members).find((x) => x && x.conversation_id === childCid);
        if (!m) return null;
        return !m.killed && String(m.phase || '').toUpperCase() === 'RUNNING' && m.wake_mode === 'working';
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Called when Antigravity `Stop` hook fires for a specific subagent conversationId.
   * Only removes the subagent if it has NO active child subagents, NO running background tasks,
   * and is NOT an actively working Swarm member!
   */
  handleSessionStopped(conversationId) {
    if (!conversationId) return;
    if (this._hasActiveDescendants(conversationId)) return;
    const vid = this.convToVisualId.get(conversationId);
    if (!vid) return;
    const item = this.items.get(vid);
    if (!item) return;

    if (item.source === 'swarm') {
      const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
      if (diskWorking !== true && item.status !== 'WAITING') {
        item.status = 'WAITING';
        item.progressText = '💤 休息待命中 · 等待唤醒…';
        item.updatedAt = Date.now();
        if (this._isActiveRoot(item)) {
          this.onChange();
        }
      }
      return;
    }

    if (item.transcriptPath && fs.existsSync(item.transcriptPath)) {
      const act = inspectTranscriptActivity(item.transcriptPath, item.teamworkDir);
      if (act.hasRunningBgTask) return;
    }

    this._finishAndRemove(vid);
  }

  /**
   * Retire non-Swarm subagent catgirls belonging to a parent session that was explicitly canceled.
   * Swarm workers are only retired if they are no longer actively running on disk, because canceling
   * a coordinator turn in Antigravity does not kill running Swarm workers.
   */
  handleParentCanceled(parentConversationId) {
    if (!parentConversationId) return;
    let activeAffected = false;
    for (const it of Array.from(this.items.values())) {
      if (it.source === 'test') continue;
      if (it.parentConversationId === parentConversationId || it.conversationId === parentConversationId) {
        if (it.source === 'swarm') {
          const diskWorking = this._isSwarmMemberWorkingOnDisk(it.parentConversationId, it.name, it.childConversationId);
          if (diskWorking === true) continue;
          // Do not permanently poison retiredKeys for un-killed Swarm workers; they can still wake up
          if (this._isActiveRoot(it)) activeAffected = true;
          this._finishAndRemove(it.id, { permanent: false, silent: true });
          continue;
        }
        if (this._isActiveRoot(it)) activeAffected = true;
        this._finishAndRemove(it.id, { permanent: true, silent: true });
      }
    }
    if (this.pendingByParent.has(parentConversationId)) {
      this.pendingByParent.delete(parentConversationId);
    }
    if (activeAffected) {
      this.onChange();
    }
  }

  /**
   * Called ONLY when a Swarm coordinator explicitly posts a Swarm-wide `[done]` (or fallback completion).
   * Does NOT permanently ban workers in `retiredKeys` so a multi-wave Swarm can resume cleanly on follow-up prompts!
   */
  handleSwarmCompleted(coordinatorId, doneSeq = 0) {
    if (!coordinatorId) return;
    const prev = this.closedSwarms.get(coordinatorId);
    this.closedSwarms.set(coordinatorId, {
      doneSeq: Math.max(prev?.doneSeq || 0, Number(doneSeq) || 0),
      closedAt: Date.now(),
    });

    const toRemove = [];
    let activeAffected = false;
    for (const it of this.items.values()) {
      if (it.source === 'swarm' && it.parentConversationId === coordinatorId) {
        if (this._isActiveRoot(it)) activeAffected = true;
        toRemove.push(it.id);
      }
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        this._finishAndRemove(id, { permanent: false, silent: true });
      }
      if (activeAffected) {
        this.onChange();
      }
    }
  }

  handleRootTurnCompleted(rootConversationId) {
    this.handleSwarmCompleted(rootConversationId);
  }

  _isDescendantOf(cid, ancestorId) {
    if (!cid || !ancestorId) return false;
    const canonicalAncestor = this._canonicalize(ancestorId);
    let cur = cid;
    const seen = new Set();
    for (let hop = 0; hop < 10 && cur; hop++) {
      if (cur === ancestorId || (canonicalAncestor && this._canonicalize(cur) === canonicalAncestor)) {
        return true;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      const vid = this.convToVisualId.get(cur);
      cur =
        this.knownConvMeta.get(cur)?.parentConversationId ||
        (vid ? this.items.get(vid)?.parentConversationId : null) ||
        this.getParentConversationId?.(cur) ||
        null;
    }
    return false;
  }

  _itemsInSameScope(parentCid) {
    if (!parentCid) {
      const activeId = this.getActiveConversationId?.() || null;
      return Array.from(this.items.values()).filter((it) => this._belongsToRoot(it, activeId));
    }
    const targetRootId = this._resolveRootConversationId(parentCid);
    const activeRootId = this._canonicalize(this.getActiveConversationId?.() || null);
    const sameAsActive = Boolean(targetRootId && activeRootId && targetRootId === activeRootId);
    return Array.from(this.items.values()).filter((it) => {
      if (it.source === 'test') return sameAsActive;
      if (!targetRootId) return it.parentConversationId === parentCid;
      return this._resolveRootConversationId(it.parentConversationId || it.childConversationId) === targetRootId;
    });
  }

  _allocateSlotIndex(parentCid = null) {
    const used = new Set();
    for (const it of this._itemsInSameScope(parentCid)) {
      used.add(it.slotIndex);
    }
    let idx = 0;
    while (used.has(idx)) idx++;
    return idx;
  }

  _allocateStyle(seed, parentCid = null) {
    const main = this.getMainSettings?.() || { scheme: 'astral', outfit: 'maid' };
    const mainScheme = normalizeSchemeId(main.scheme);
    const usedCombos = new Set([`${mainScheme}-maid`]);
    const usedSchemes = new Set([mainScheme]);
    for (const it of this._itemsInSameScope(parentCid)) {
      const sNorm = normalizeSchemeId(it.scheme);
      usedCombos.add(`${sNorm}-maid`);
      usedSchemes.add(sNorm);
    }

    const allCombos = [];
    for (const s of SCHEME_LIST) {
      for (const o of OUTFIT_LIST) {
        allCombos.push({ scheme: s, outfit: o, key: `${s}-${o}` });
      }
    }

    let hash = 0;
    const str = String(seed || Math.random());
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33 + str.charCodeAt(i)) >>> 0;
    }

    for (let step = 0; step < allCombos.length; step++) {
      const idx = (hash + step * 7) % allCombos.length;
      const cand = allCombos[idx];
      if (!usedSchemes.has(cand.scheme) && !usedCombos.has(cand.key)) {
        return { scheme: cand.scheme, outfit: cand.outfit };
      }
    }
    for (let step = 0; step < allCombos.length; step++) {
      const idx = (hash + step * 5) % allCombos.length;
      const cand = allCombos[idx];
      if (!usedCombos.has(cand.key)) {
        return { scheme: cand.scheme, outfit: cand.outfit };
      }
    }
    const fallback = allCombos[hash % allCombos.length];
    return { scheme: fallback.scheme, outfit: fallback.outfit };
  }

  /**
   * Spawn a manual/UI test subagent with simulated progress -> automatic smooth fade-out removal on completion!
   */
  spawnTestSubagent(payload = {}) {
    const templates = [
      { name: 'explorer_ui', role: '🔭 代码勘探员', text: '正在扫描界面组件与视觉层级…' },
      { name: 'worker_core', role: '🛠️ 核心工程师', text: '正在重构多智能体同步引擎…' },
      { name: 'swarm_verifier', role: '🐝 Swarm · 验证节点', text: '并行校验构建产物与点击穿透…' },
      { name: 'challenger_qa', role: '⚔️ 红队挑战者', text: '压测并发天降动画与边界状态…' },
      { name: 'browser_agent', role: '🌐 浏览器特工', text: '正在执行端到端可视化回归…' },
    ];
    const tpl = templates[this.items.size % templates.length];
    const id = `whale_test_${Date.now()}_${this.seq++}`;
    const style = this._allocateStyle(id + (payload.name || tpl.name), null);
    const item = {
      id,
      name: payload.name || tpl.name,
      role: payload.role || tpl.role,
      typeName: 'test_subagent',
      source: 'test',
      slotIndex: this._allocateSlotIndex(null),
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: payload.text || tpl.text,
      progressPercent: 25,
      stepCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.items.set(id, item);
    this.onReaction({
      expression: 'excited',
      motion: 'jump',
      speech: `✨ 子代理「${item.name}」天降出击！（完成后将自动淡出退场～）`,
    });
    this.onChange();

    setTimeout(() => {
      const cur = this.items.get(id);
      if (cur) {
        cur.progressPercent = 72;
        cur.progressText = '⚡ 正在推进核心步骤 (2/2)…';
        cur.updatedAt = Date.now();
        this.onChange();
      }
    }, 2400);

    item.retireTimer = setTimeout(() => {
      this._finishAndRemove(id);
    }, 4800);

    return item;
  }

  /**
   * Handle instant tool invocations from Hooks (`PreToolUse`) or CLI (`AgyRunner`).
   */
  handleLiveToolCall(parentConversationId, toolName, rawArgs = {}) {
    const args = normalizeToolArgs(rawArgs);
    if (toolName === 'invoke_subagent') {
      this._enqueueOrSpawnSubagent(parentConversationId, args, { quiet: false, origin: 'hook' });
    } else if (toolName === 'manage_subagents') {
      this._handleManageSubagents(parentConversationId, args);
    } else if (toolName === 'swarm') {
      this.closedSwarms.delete(parentConversationId);
      this._handleSwarmToolCall(parentConversationId, args, { quiet: false });
    } else if (toolName === 'post_message') {
      if (!this.childConversations.has(parentConversationId)) {
        const text = String(args.text || '');
        if (isCoordinatorDonePost(text)) {
          this.handleSwarmCompleted(parentConversationId);
        } else {
          this.closedSwarms.delete(parentConversationId);
        }
      }
    }
  }

  /**
   * Handle every incremental step from `TranscriptWatcher` (both root conversations and child subagent trees).
   */
  handleTranscriptStep(ev) {
    const { conversationId, kind, quiet } = ev;

    const eventTimeMs = Date.parse(ev.createdAt || '') || Date.now();
    const isStaleHistorical = Boolean(quiet && Date.now() - eventTimeMs > 8 * 60 * 1000);

    // 1. Check subagent spawning / management tools in ANY watched conversation
    if (kind === 'tool_call') {
      if (ev.toolName === 'invoke_subagent') {
        if (!isStaleHistorical) {
          this._enqueueOrSpawnSubagent(conversationId, ev.args, { quiet, origin: 'transcript' });
        }
      } else if (ev.toolName === 'manage_subagents') {
        if (!isStaleHistorical) {
          this._handleManageSubagents(conversationId, ev.args);
        }
      } else if (ev.toolName === 'swarm') {
        if (!isStaleHistorical) {
          if (!quiet) this.closedSwarms.delete(conversationId);
          this._handleSwarmToolCall(conversationId, ev.args, { quiet });
        }
      } else if (ev.toolName === 'post_message' && !quiet) {
        if (!this.childConversations.has(conversationId)) {
          const text = String(ev.args?.text || '');
          // If coordinator posts a Swarm-wide `[done]`, immediately close & fade out all swarm workers!
          if (isCoordinatorDonePost(text)) {
            this.handleSwarmCompleted(conversationId);
            return;
          }
          // Otherwise, a new coordinator board post opens/resumes the Swarm wave
          this.closedSwarms.delete(conversationId);
        }
      }
    } else if (kind === 'subagent_created') {
      this._bindCreatedSubagent(conversationId, ev.childConversationId, ev.childTranscriptPath, {
        quiet,
        isStaleHistorical,
      });
    } else if (kind === 'subagent_killed_confirm' && !quiet) {
      this._handleKilledRolesText(conversationId, ev.killedRoles || '');
    } else if (kind === 'subagent_list' && Array.isArray(ev.subagents)) {
      if (!isStaleHistorical) {
        this._reconcileSubagentList(conversationId, ev.subagents, { quiet });
      }
    } else if (kind === 'incoming_message' && !quiet && ev.sender) {
      // If a child subagent just sent its final report back to its parent and has no active children/bg tasks, remove it!
      const senderVid = this.convToVisualId.get(ev.sender);
      if (senderVid && !this._hasActiveDescendants(ev.sender)) {
        const senderItem = this.items.get(senderVid);
        if (senderItem && senderItem.transcriptPath) {
          const act = inspectTranscriptActivity(senderItem.transcriptPath, senderItem.teamworkDir);
          if (act.finished || act.waitingOnSwarmBoard) {
            this._finishAndRemove(senderVid);
          }
        }
      }
    }

    // 2. If `conversationId` is a known sleeping Swarm worker or browser/orchestrator that just woke up with live work, re-spawn it!
    let visualId = this.convToVisualId.get(conversationId);
    if (!visualId && !quiet && this.knownConvMeta.has(conversationId) && !this.retiredKeys.has(conversationId)) {
      const meta = this.knownConvMeta.get(conversationId);
      const isWakeActivity =
        kind === 'thinking' ||
        (kind === 'tool_call' && ev.toolName !== 'swarm_wait' && ev.toolName !== 'read_board');
      if (isWakeActivity && !this.closedSwarms.has(meta.parentConversationId)) {
        if (meta.source === 'swarm') {
          if (meta.name !== 'monitor') {
            const revived = this._ensureSwarmMember(meta.parentConversationId, meta.name, {
              conversationId,
              role: meta.rawRole || 'Swarm Worker',
            });
            visualId = revived?.id;
          }
        } else if (!this._isCoordinatorType(meta.typeName)) {
          const id = `whale_sub_${Date.now()}_${this.seq++}`;
          const style = this._allocateStyle(`${meta.name}_${conversationId}`, meta.parentConversationId);
          const revived = {
            id,
            parentConversationId: meta.parentConversationId,
            childConversationId: conversationId,
            transcriptPath: meta.transcriptPath,
            name: meta.name,
            role: meta.role,
            typeName: meta.typeName,
            source: meta.source,
            teamworkFolder: meta.teamworkFolder,
            teamworkDir: meta.teamworkDir,
            slotIndex: this._allocateSlotIndex(meta.parentConversationId),
            scheme: style.scheme,
            outfit: style.outfit,
            status: 'WORKING',
            progressText: '🚀 恢复执行后续任务…',
            progressPercent: 30,
            stepCount: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.items.set(id, revived);
          this.convToVisualId.set(conversationId, id);
          visualId = id;
          if (this._isActiveRoot(revived)) {
            this.onChange();
          }
        }
      }
    }

    if (!visualId) return;
    const item = this.items.get(visualId);
    if (!item) return;

    if (kind === 'thinking') {
      item.status = 'THINKING';
      item.stepCount = (item.stepCount || 1) + 1;
      item.progressText = `💭 ${ev.text.slice(0, 36)}`;
      if (!item.hasChecklistProgress) {
        item.progressPercent = Math.min(92, (item.progressPercent || 18) + 5);
      }
      item.updatedAt = Date.now();
      if (!quiet && this._isActiveRoot(item)) this.onChange();
      return;
    }

    if (kind === 'tool_call') {
      const tn = String(ev.toolName || '');
      item.stepCount = (item.stepCount || 1) + 1;
      item.lastToolName = tn;

      // In Native Swarm, calling `swarm_wait` puts this worker into resting/sleeping mode (`WAITING` -> Whale sleep animation + Zzz)!
      if (tn === 'swarm_wait') {
        item.status = 'WAITING';
        item.progressText = item.lastBoardSeq ? '💤 已汇报 · 睡眠待命中…' : '💤 休息待命中 · 等待唤醒…';
        item.updatedAt = Date.now();
        if (!quiet && this._isActiveRoot(item)) this.onChange();
        return;
      }

      // Auto-remove pure relay `teamwork` sentinel once it spawns `teamwork_orchestrator`
      if (item.typeName === 'teamwork' && tn === 'invoke_subagent') {
        const childType = String(ev.args?.TypeName || '');
        if (childType === 'teamwork_orchestrator') {
          this._finishAndRemove(item.id);
          return;
        }
      }

      item.status = 'WORKING';
      item.progressText = describeChildTool(tn, ev.args);

      const targetPath = String(ev.args?.Path || ev.args?.TargetFile || '');
      if (/handoff\.md$/i.test(targetPath)) {
        item.wroteHandoff = true;
        item.progressPercent = 96;
      } else if (tn === 'send_message') {
        item.reportedBack = true;
        item.progressPercent = Math.max(item.progressPercent || 80, 96);
      } else if (!item.hasChecklistProgress) {
        item.progressPercent = Math.min(94, (item.progressPercent || 20) + 7);
      }

      item.updatedAt = Date.now();
      if (!quiet && this._isActiveRoot(item)) this.onChange();
      return;
    }

    // Child transcript explicitly canceled
    if (kind === 'canceled' && !quiet) {
      if (item.source === 'swarm') {
        const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
        if (diskWorking !== true && item.status !== 'WAITING') {
          item.status = 'WAITING';
          item.progressText = '💤 已暂停 · 等待唤醒…';
          item.updatedAt = Date.now();
          if (this._isActiveRoot(item)) this.onChange();
        }
      } else if (!this._hasActiveDescendants(conversationId)) {
        this._finishAndRemove(item.id);
      }
      return;
    }

    // Subagent reached `assistant_reply` (`finalTurn`) or `turn_end`:
    // Swarm members transition to sleeping (`WAITING`) until the Swarm itself finishes; other subagents fade out when done!
    if ((kind === 'assistant_reply' && ev.finalTurn) || kind === 'turn_end') {
      if (!quiet && !this._hasActiveDescendants(conversationId)) {
        if (item.source === 'swarm') {
          const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
          if (diskWorking !== true && item.status !== 'WAITING') {
            item.status = 'WAITING';
            item.progressText = item.lastBoardSeq ? '💤 已汇报 · 睡眠待命中…' : '💤 休息待命中 · 等待唤醒…';
            item.updatedAt = Date.now();
            if (this._isActiveRoot(item)) this.onChange();
          }
          return;
        }
        if (item.transcriptPath && fs.existsSync(item.transcriptPath)) {
          const act = inspectTranscriptActivity(item.transcriptPath, item.teamworkDir);
          if (act.hasRunningBgTask) return;
        }
        this._finishAndRemove(item.id);
      }
    }
  }

  _enqueueOrSpawnSubagent(parentConversationId, rawArgs, { quiet = false, origin = 'transcript' } = {}) {
    const ident = extractSubagentIdentity(rawArgs);
    const now = Date.now();

    const pendingList = this.pendingByParent.get(parentConversationId) || [];
    if (!quiet) {
      // Symmetrically deduplicate hook vs transcript arrivals (whichever fires first!)
      for (const pid of pendingList) {
        if (typeof pid !== 'string' || pid.startsWith('{')) continue;
        const existing = this.items.get(pid);
        if (
          existing &&
          existing.spawnOrigin !== origin &&
          !existing.matchedOtherOrigin &&
          !existing.childConversationId &&
          existing.name === ident.name &&
          now - existing.createdAt < 10000
        ) {
          existing.matchedOtherOrigin = true;
          return existing;
        }
      }
    }

    if (quiet) {
      pendingList.push(JSON.stringify({ deferred: true, ident }));
      this.pendingByParent.set(parentConversationId, pendingList);
      return null;
    }

    const id = `whale_sub_${now}_${this.seq++}`;
    const style = this._allocateStyle(`${ident.name}_${id}`, parentConversationId);
    const item = {
      id,
      spawnOrigin: origin,
      matchedOtherOrigin: false,
      parentConversationId,
      childConversationId: null,
      name: ident.name,
      role: ident.role,
      typeName: ident.typeName,
      source: ident.source,
      teamworkFolder: ident.teamworkFolder,
      teamworkDir: ident.teamworkDir,
      slotIndex: this._allocateSlotIndex(parentConversationId),
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: `🚀 ${ident.initialBrief}`,
      progressPercent: 16,
      stepCount: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(id, item);
    pendingList.push(id);
    this.pendingByParent.set(parentConversationId, pendingList);

    if (this._isActiveRoot(parentConversationId)) {
      this.onReaction({
        expression: 'love',
        motion: 'wave',
        speech: `🐳 子代理「${item.name}」天降支援啦！`,
      });
      this.onChange();
    }
    return item;
  }

  _bindCreatedSubagent(parentConversationId, childConversationId, childTranscriptPath, { quiet = false, isStaleHistorical = false } = {}) {
    if (!childConversationId) return;
    const resolvedPath = childTranscriptPath || findTranscriptPath(childConversationId);

    const pendingList = this.pendingByParent.get(parentConversationId) || [];
    let head = null;
    if (!quiet) {
      // Drop stale historical deferred entries before binding a live subagent
      while (pendingList.length > 0 && typeof pendingList[0] === 'string' && pendingList[0].startsWith('{')) {
        pendingList.shift();
      }
      head = pendingList.shift();
    } else {
      head = pendingList.shift();
    }
    if (pendingList.length === 0) {
      this.pendingByParent.delete(parentConversationId);
    }

    if (this.convToVisualId.has(childConversationId)) {
      if (resolvedPath) {
        this.childConversations.add(childConversationId);
        this.watcher.attach(childConversationId, resolvedPath);
      }
      return;
    }

    let deferredIdent = null;
    if (typeof head === 'string' && head.startsWith('{')) {
      try { deferredIdent = JSON.parse(head).ident; } catch { /* ignore */ }
    }

    if (this.retiredKeys.has(childConversationId)) return;

    const activity = inspectTranscriptActivity(resolvedPath, deferredIdent?.teamworkDir || '');

    // Remember lineage metadata so we can trace descendants & wakeups
    const metaIdent = deferredIdent || (typeof head === 'string' ? this.items.get(head) : null);
    if (metaIdent) {
      this.knownConvMeta.set(childConversationId, {
        parentConversationId,
        transcriptPath: resolvedPath,
        name: metaIdent.name,
        role: metaIdent.role,
        typeName: metaIdent.typeName,
        source: metaIdent.source,
        teamworkFolder: metaIdent.teamworkFolder || '',
        teamworkDir: metaIdent.teamworkDir || '',
      });
    }

    // Watch recent Teamwork coordinators in background so we discover any active Explorer/Worker children
    const isRecentCoordinator =
      deferredIdent &&
      this._isCoordinatorType(deferredIdent.typeName) &&
      Date.now() - activity.mtimeMs < 20 * 60 * 1000;

    if (quiet) {
      if (isStaleHistorical && !isRecentCoordinator) return;
      if (!activity.activelyWorking && !isRecentCoordinator) {
        this.retiredKeys.add(childConversationId);
        return;
      }
    }

    let item = typeof head === 'string' && !head.startsWith('{') ? this.items.get(head) : null;
    if (!item && (!quiet || activity.activelyWorking)) {
      const ident = deferredIdent || {
        name: `agent_${childConversationId.slice(0, 6)}`,
        role: '🐳 协作子代理',
        typeName: 'subagent',
        source: 'subagent',
        teamworkFolder: '',
        teamworkDir: '',
        initialBrief: '正在并行处理子任务…',
      };
      if (!(quiet && this._isCoordinatorType(ident.typeName))) {
        const id = `whale_sub_${Date.now()}_${this.seq++}`;
        const style = this._allocateStyle(`${ident.name}_${childConversationId}`, parentConversationId);
        item = {
          id,
          parentConversationId,
          childConversationId,
          transcriptPath: resolvedPath,
          name: ident.name,
          role: ident.role,
          typeName: ident.typeName,
          source: ident.source,
          teamworkFolder: ident.teamworkFolder,
          teamworkDir: ident.teamworkDir,
          slotIndex: this._allocateSlotIndex(parentConversationId),
          scheme: style.scheme,
          outfit: style.outfit,
          status: 'WORKING',
          progressText: `🚀 ${ident.initialBrief}`,
          progressPercent: 20,
          stepCount: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.items.set(id, item);
      }
    }

    if (item) {
      item.childConversationId = childConversationId;
      item.transcriptPath = resolvedPath;
      this.convToVisualId.set(childConversationId, item.id);
      this.knownConvMeta.set(childConversationId, {
        parentConversationId,
        transcriptPath: resolvedPath,
        name: item.name,
        role: item.role,
        typeName: item.typeName,
        source: item.source,
        teamworkFolder: item.teamworkFolder || '',
        teamworkDir: item.teamworkDir || '',
      });
      if (this._isActiveRoot(item)) {
        this.onChange();
      }
    }

    if (resolvedPath) {
      this.childConversations.add(childConversationId);
      this.watcher.attach(childConversationId, resolvedPath, { maxInitialBytes: 262144 });
    }
  }

  _reconcileSubagentList(parentConversationId, list, { quiet = false } = {}) {
    if (quiet) return;
    const aliveIds = new Set();
    for (const entry of list) {
      const cid = entry.conversationId;
      if (!cid) continue;
      aliveIds.add(cid);
      if (entry.state === 'waiting_for_dependents' || entry.state === 'idle') {
        const vid = this.convToVisualId.get(cid);
        if (vid) this._finishAndRemove(vid);
        continue;
      }
      if (this.retiredKeys.has(cid)) continue;
      if (!this.convToVisualId.has(cid)) {
        const ident = extractSubagentIdentity({
          TypeName: entry.type,
          Role: entry.role,
        });
        const id = `whale_sub_${Date.now()}_${this.seq++}`;
        const style = this._allocateStyle(`${ident.name}_${cid}`, parentConversationId);
        const item = {
          id,
          parentConversationId,
          childConversationId: cid,
          transcriptPath: entry.transcriptPath || '',
          name: ident.name,
          role: ident.role,
          typeName: ident.typeName,
          source: ident.source,
          slotIndex: this._allocateSlotIndex(parentConversationId),
          scheme: style.scheme,
          outfit: style.outfit,
          status: 'WORKING',
          progressText: '🚀 正在协同运行中…',
          progressPercent: 35,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.items.set(id, item);
        this.convToVisualId.set(cid, id);
        if (this._isActiveRoot(item)) {
          this.onChange();
        }
      }
      if (entry.transcriptPath) {
        this.childConversations.add(cid);
        this.watcher.attach(cid, entry.transcriptPath, { maxInitialBytes: 262144 });
      }
    }
  }

  _handleKilledRolesText(parentConversationId, killedRoles) {
    if (!killedRoles) return;
    const roles = killedRoles.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
    for (const it of Array.from(this.items.values())) {
      if (it.parentConversationId === parentConversationId) {
        const itemRole = String(it.role || '').toLowerCase();
        const itemName = String(it.name || '').toLowerCase();
        if (roles.some((r) => itemRole.includes(r) || itemName.includes(r))) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    }
  }

  _handleManageSubagents(parentConversationId, rawArgs = {}) {
    const args = normalizeToolArgs(rawArgs);
    const action = String(args.Action || '').toLowerCase();
    if (action === 'kill_all') {
      for (const it of Array.from(this.items.values())) {
        if (!parentConversationId || it.parentConversationId === parentConversationId || this._isDescendantOf(it.parentConversationId, parentConversationId)) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    } else if (action === 'kill') {
      const ids = Array.isArray(args.ConversationIds) ? args.ConversationIds : [];
      for (const cid of ids) {
        this.retiredKeys.add(cid);
        const vid = this.convToVisualId.get(cid);
        if (vid) {
          this._finishAndRemove(vid, { permanent: true });
        }
        for (const it of Array.from(this.items.values())) {
          if (it.parentConversationId === cid || this._isDescendantOf(it.parentConversationId, cid)) {
            this._finishAndRemove(it.id, { permanent: true });
          }
        }
      }
    }
  }

  _handleSwarmToolCall(coordinatorId, rawArgs = {}, { quiet = false } = {}) {
    const args = normalizeToolArgs(rawArgs);
    const action = String(args.action || '').toLowerCase();
    const baseName = String(args.name || '').trim();
    if (!baseName || quiet) return;

    if (action === 'add') {
      const names = [];
      if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        for (let i = 1; i <= args.tasks.length; i++) names.push(`${baseName}-${i}`);
      } else if (typeof args.n === 'number' && args.n > 1) {
        for (let i = 1; i <= args.n; i++) names.push(`${baseName}-${i}`);
      } else {
        names.push(baseName);
      }

      for (const memberName of names) {
        this._ensureSwarmMember(coordinatorId, memberName, {
          role: args.model ? `Swarm · ${args.model}` : 'Swarm Worker',
          brief: summarizePromptBrief(args.brief || '', '已加入蜂群看板，准备开工…'),
        });
      }
    } else if (action === 'kill') {
      const swarmKey = `swarm:${coordinatorId}:${baseName}`;
      this.retiredKeys.add(swarmKey);
      for (const it of Array.from(this.items.values())) {
        if (
          it.swarmKey === swarmKey ||
          (it.source === 'swarm' &&
            it.parentConversationId === coordinatorId &&
            (it.name === baseName || it.name.startsWith(baseName + '-')))
        ) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    }
  }

  _ensureSwarmMember(coordinatorId, memberName, meta = {}) {
    if (!memberName || memberName === 'coordinator') return null;
    if (this.closedSwarms.has(coordinatorId)) return null;
    const swarmKey = `swarm:${coordinatorId}:${memberName}`;
    if (this.retiredKeys.has(swarmKey)) return null;

    for (const existing of this.items.values()) {
      if (existing.swarmKey === swarmKey) {
        if (meta.conversationId && !existing.childConversationId) {
          existing.childConversationId = meta.conversationId;
          const tp = meta.transcriptPath || findTranscriptPath(meta.conversationId);
          existing.transcriptPath = tp;
          this.convToVisualId.set(meta.conversationId, existing.id);
          this.knownConvMeta.set(meta.conversationId, {
            parentConversationId: coordinatorId,
            transcriptPath: tp,
            name: memberName,
            rawRole: meta.role || 'Swarm Worker',
            source: 'swarm',
            typeName: 'swarm_worker',
          });
          if (tp) {
            this.childConversations.add(meta.conversationId);
            this.watcher.attach(meta.conversationId, tp, { maxInitialBytes: 131072 });
          }
        }
        return existing;
      }
    }

    const tp = meta.transcriptPath || (meta.conversationId ? findTranscriptPath(meta.conversationId) : '');
    const id = `whale_swarm_${Date.now()}_${this.seq++}`;
    const style = this._allocateStyle(swarmKey, coordinatorId);
    const item = {
      id,
      swarmKey,
      parentConversationId: coordinatorId,
      childConversationId: meta.conversationId || null,
      transcriptPath: tp,
      name: memberName,
      role: `🐝 ${meta.role || 'Swarm Worker'}`,
      typeName: 'swarm_worker',
      source: 'swarm',
      slotIndex: this._allocateSlotIndex(coordinatorId),
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: `🚀 ${meta.brief || '已接入蜂群消息看板…'}`,
      progressPercent: 24,
      stepCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.items.set(id, item);
    if (meta.conversationId) {
      this.convToVisualId.set(meta.conversationId, id);
      this.knownConvMeta.set(meta.conversationId, {
        parentConversationId: coordinatorId,
        transcriptPath: tp,
        name: memberName,
        rawRole: meta.role || 'Swarm Worker',
        source: 'swarm',
        typeName: 'swarm_worker',
      });
      if (tp) {
        this.childConversations.add(meta.conversationId);
        this.watcher.attach(meta.conversationId, tp, { maxInitialBytes: 131072 });
      }
    }

    if (this._isActiveRoot(coordinatorId)) {
      this.onReaction({
        expression: 'excited',
        motion: 'jump',
        speech: `🐝 蜂群成员「@${memberName}」空降就位！`,
      });
      this.onChange();
    }
    return item;
  }

  /**
   * Periodic liveness, Swarm (`members.json` authoritative `wake_mode === 'working'` + `board.jsonl` `[done]`),
   * and Teamwork (`progress.md`, `handoff.md`) sync!
   */
  _pollSwarmAndTeamworkFiles() {
    let activeDirty = false;
    const now = Date.now();

    // A. Collect candidate root conversation IDs (watched roots + recently active Swarm folders in BRAIN_ROOTS)
    const candidateSwarmIds = new Set(this.getWatchedRootIds?.() || []);
    for (const brainRoot of this.brainRoots) {
      try {
        if (!fs.existsSync(brainRoot)) continue;
        for (const ent of fs.readdirSync(brainRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const membersPath = path.join(brainRoot, ent.name, '.system_generated', 'swarm', 'members.json');
          if (fs.existsSync(membersPath)) {
            const st = fs.statSync(membersPath);
            if (now - st.mtimeMs < 30 * 60 * 1000) {
              candidateSwarmIds.add(ent.name);
            }
          }
        }
      } catch { /* ignore */ }
    }

    for (const cid of candidateSwarmIds) {
      if (!cid) continue;
      for (const brainRoot of this.brainRoots) {
        const swarmDir = path.join(brainRoot, cid, '.system_generated', 'swarm');
        const membersPath = path.join(swarmDir, 'members.json');
        if (!fs.existsSync(membersPath)) continue;

        try {
          const stat = fs.statSync(membersPath);
          const hasTrackedFromThisSwarm = Array.from(this.items.values()).some((i) => i.parentConversationId === cid && i.source === 'swarm');
          if (!hasTrackedFromThisSwarm && now - stat.mtimeMs > 30 * 60 * 1000) continue;

          // 1. Check `board.jsonl`: only close when coordinator's latest wave ended with a Swarm-wide `[done]` post!
          const boardPath = path.join(swarmDir, 'board.jsonl');
          const boardInfo = inspectSwarmBoard(boardPath);

          const data = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
          const members = data?.members || {};

          const hasAnyWorkingMember = Object.values(members).some(
            (m) => m && !m.killed && String(m.phase || '').toUpperCase() === 'RUNNING' && m.wake_mode === 'working'
          );

          // Handle multi-wave Swarms: if a previously closed Swarm starts a new wave (new coordinator post after doneSeq,
          // or a worker actively wakes up after the close grace period), re-open it cleanly!
          const closedInfo = this.closedSwarms.get(cid);
          if (closedInfo) {
            const hasNewerBoardActivity =
              closedInfo.doneSeq > 0
                ? (!boardInfo.isDone && boardInfo.lastCoordTaskSeq > closedInfo.doneSeq)
                : (!boardInfo.isDone && boardInfo.mtimeMs > closedInfo.closedAt + 1000 && boardInfo.lastCoordTaskSeq > 0);
            const hasActiveAfterClose =
              hasAnyWorkingMember && !boardInfo.isDone && now - closedInfo.closedAt > 3000;
            if (hasNewerBoardActivity || hasActiveAfterClose) {
              this.closedSwarms.delete(cid);
            } else {
              if (boardInfo.isDone && boardInfo.doneSeq > (closedInfo.doneSeq || 0)) {
                closedInfo.doneSeq = boardInfo.doneSeq;
              }
              continue;
            }
          }

          if (boardInfo.isDone) {
            this.handleSwarmCompleted(cid, boardInfo.doneSeq);
            continue;
          }

          // Check whether any non-killed worker currently has a running background command/task on disk
          let hasAnyWorkerBgTask = false;
          const workerBgTasks = new Map();
          for (const [memberName, m] of Object.entries(members)) {
            if (memberName === 'coordinator' || !m || typeof m !== 'object' || m.killed) continue;
            if (String(m.phase || '').toUpperCase() === 'KILLED') continue;
            if (m.conversation_id) {
              const wtp = path.join(brainRoot, m.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
              if (fs.existsSync(wtp)) {
                const wAct = inspectTranscriptActivity(wtp);
                if (wAct.hasRunningBgTask) {
                  hasAnyWorkerBgTask = true;
                  workerBgTasks.set(memberName, true);
                }
              }
            }
          }

          // 2. Fallback completion check (if coordinator finished final reply after worker posts without writing literal `[done]`):
          // Only triggers when EVERY non-killed member is resting (`wake_mode !== 'working'` AND no running background tasks),
          // workers have already posted results AFTER the coordinator's latest task assignment, and coordinator's transcript
          // finished AFTER the last board post!
          if (
            !hasAnyWorkingMember &&
            !hasAnyWorkerBgTask &&
            boardInfo.hasWorkerPost &&
            boardInfo.lastWorkerPostSeq > boardInfo.lastCoordTaskSeq
          ) {
            const coordTranscript = path.join(brainRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
            const coordAct = inspectTranscriptActivity(coordTranscript);
            if (
              coordAct.exists &&
              coordAct.finished &&
              coordAct.mtimeMs > boardInfo.mtimeMs &&
              now - coordAct.mtimeMs > 8000
            ) {
              this.handleSwarmCompleted(cid, boardInfo.lastPostSeq);
              continue;
            }
          }

          // 3. Sync each Swarm member: `wake_mode === 'working'` (or running bg task) -> energetic WORKING; otherwise -> cute SLEEPING (`WAITING`)!
          for (const [memberName, m] of Object.entries(members)) {
            if (memberName === 'coordinator' || !m || typeof m !== 'object') continue;
            const swarmKey = `swarm:${cid}:${memberName}`;
            const existing = Array.from(this.items.values()).find((x) => x.swarmKey === swarmKey);

            if (m.killed || String(m.phase || '').toUpperCase() === 'KILLED') {
              this.retiredKeys.add(swarmKey);
              if (existing) {
                if (this._isActiveRoot(existing)) activeDirty = true;
                this._finishAndRemove(existing.id, { permanent: true, silent: true });
              }
              continue;
            }

            const tp = m.conversation_id
              ? path.join(brainRoot, m.conversation_id, '.system_generated', 'logs', 'transcript.jsonl')
              : '';

            const roleLabel = m.role || (m.model ? String(m.model).split('/').pop() : 'Worker');
            if (m.conversation_id && tp && fs.existsSync(tp)) {
              this.knownConvMeta.set(m.conversation_id, {
                parentConversationId: cid,
                transcriptPath: tp,
                name: memberName,
                rawRole: roleLabel,
                source: 'swarm',
                typeName: 'swarm_worker',
              });
              this.childConversations.add(m.conversation_id);
              if (!this.watcher.has(m.conversation_id)) {
                this.watcher.attach(m.conversation_id, tp, { maxInitialBytes: 65536 });
              }
            }

            const isWorkingOnHost =
              (String(m.phase || '').toUpperCase() === 'RUNNING' && m.wake_mode === 'working') ||
              workerBgTasks.get(memberName) === true;

            const item =
              existing ||
              this._ensureSwarmMember(cid, memberName, {
                conversationId: m.conversation_id,
                transcriptPath: tp,
                role: roleLabel,
              });
            if (!item) continue;

            const latestPost = boardInfo.latestByAgent.get(memberName);
            if (latestPost && item.lastBoardSeq !== latestPost.seq) {
              item.lastBoardSeq = latestPost.seq;
              if (isWorkingOnHost) {
                item.progressText = `📋 #${latestPost.seq}: ${latestPost.text.slice(0, 34)}`;
              }
              item.progressPercent = Math.min(95, Math.max(item.progressPercent || 30, 88));
              item.updatedAt = now;
              if (this._isActiveRoot(item)) activeDirty = true;
            }

            if (isWorkingOnHost) {
              if (item.status === 'WAITING') {
                item.status = 'WORKING';
                item.progressText = workerBgTasks.get(memberName)
                  ? '⚡ 后台任务执行中…'
                  : '🚀 已唤醒 · 正在执行任务…';
                item.updatedAt = now;
                if (this._isActiveRoot(item)) activeDirty = true;
              }
            } else if (now - item.createdAt > 3000) {
              // Member is resting on the board (`mentions` / `anything`) -> enter sleeping state (`WAITING`)!
              if (item.status !== 'WAITING') {
                item.status = 'WAITING';
                item.progressText = latestPost
                  ? '💤 已交付汇报 · 睡眠待命中…'
                  : '💤 休息待命中 · 等待唤醒…';
                if (!latestPost && (item.progressPercent || 0) > 25) {
                  item.progressPercent = 20;
                }
                item.updatedAt = now;
                if (this._isActiveRoot(item)) activeDirty = true;
              }
            }
          }
        } catch { /* ignore transient file lock */ }
      }
    }

    // B. Poll non-Swarm Subagents & Teamwork (`progress.md` / `handoff.md`)
    const defaultWs = this.getMainSettings?.()?.defaultWorkspace || '';

    for (const it of Array.from(this.items.values())) {
      if (it.source === 'test' || it.source === 'swarm') continue;

      // 1. Reap unbound hook items that never materialized into a subagent within 45s
      if (!it.childConversationId && now - it.createdAt > 45000) {
        if (this._isActiveRoot(it)) activeDirty = true;
        this._finishAndRemove(it.id, { silent: true });
        continue;
      }

      // 2. Check transcript completion (NEVER kill mid-generation! Only safety-reap after 20 min of total silence)
      if (it.transcriptPath && fs.existsSync(it.transcriptPath) && now - it.createdAt > 3000) {
        if (!this._hasActiveDescendants(it.childConversationId)) {
          const act = inspectTranscriptActivity(it.transcriptPath, it.teamworkDir);
          if (!act.activelyWorking) {
            if (this._isActiveRoot(it)) activeDirty = true;
            this._finishAndRemove(it.id, { silent: true });
            continue;
          }
          if (now - Math.max(it.updatedAt, act.mtimeMs) > 20 * 60 * 1000) {
            if (this._isActiveRoot(it)) activeDirty = true;
            this._finishAndRemove(it.id, { silent: true });
            continue;
          }
        }
      }

      // 3. Teamwork `handoff.md` completion & `progress.md` checklist percentage sync
      if (it.source === 'teamwork' && it.teamworkFolder) {
        const candidateDirs = [];
        if (it.teamworkDir) candidateDirs.push(it.teamworkDir);
        if (defaultWs) {
          candidateDirs.push(path.join(defaultWs, '.agents', 'teamwork', it.teamworkFolder));
          candidateDirs.push(path.join(path.dirname(defaultWs), '.agents', 'teamwork', it.teamworkFolder));
        }

        for (const dir of candidateDirs) {
          if (!dir || !fs.existsSync(dir)) continue;
          const handoffPath = path.join(dir, 'handoff.md');
          if (fs.existsSync(handoffPath) && !this._hasActiveDescendants(it.childConversationId)) {
            if (this._isActiveRoot(it)) activeDirty = true;
            this._finishAndRemove(it.id, { permanent: true, silent: true });
            break;
          }
          const progressPath = path.join(dir, 'progress.md');
          if (fs.existsSync(progressPath)) {
            try {
              const md = fs.readFileSync(progressPath, 'utf8');
              const checked = md.match(/^\s*-\s*\[x\]\s*(.+)$/gim) || [];
              const unchecked = md.match(/^\s*-\s*\[\s\]\s*(.+)$/gim) || [];
              const total = checked.length + unchecked.length;
              if (total > 0) {
                const pct = Math.max(15, Math.min(95, Math.round((checked.length / total) * 100)));
                if (it.progressPercent !== pct) {
                  it.hasChecklistProgress = true;
                  it.progressPercent = pct;
                  if (this._isActiveRoot(it)) activeDirty = true;
                }
                if (unchecked.length > 0 && !it.lastToolName) {
                  const currentStep = unchecked[0].replace(/^\s*-\s*\[\s\]\s*/, '').trim();
                  it.progressText = `📋 ${currentStep.slice(0, 36)}`;
                  if (this._isActiveRoot(it)) activeDirty = true;
                }
              }
            } catch { /* ignore */ }
          }
          break;
        }
      }
    }

    if (activeDirty) {
      this.onChange();
    }
  }

  dispose() {
    clearInterval(this.pollTimer);
    for (const it of this.items.values()) {
      if (it.retireTimer) clearTimeout(it.retireTimer);
    }
    this.items.clear();
  }
}

module.exports = {
  SubagentTracker,
  extractSubagentIdentity,
  inspectTranscriptActivity,
  inspectSwarmBoard,
  isCoordinatorDonePost,
};
