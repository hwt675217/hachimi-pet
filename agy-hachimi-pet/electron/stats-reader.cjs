const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSingleAnnotation } = require('./antigravity-catalog.cjs');

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

/**
 * Incremental per-conversation parse cache keyed by conversationId.
 * Re-parses a `transcript.jsonl` only when `mtimeMs` or `size` changes.
 * @type {Map<string, { mtimeMs: number, size: number, title: string, isSubagent: boolean, events: Array<any> }>}
 */
const fileParseCache = new Map();

const KNOWN_MODEL_NAMES = {
  'gemini-4-carbon-medium': 'Gemini 4 Carbon (Medium)',
  'gemini-4-carbon-high': 'Gemini 4 Carbon (High)',
  'gemini-4-carbon-low': 'Gemini 4 Carbon (Low)',
  'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
  'gemini-4-argon-high': 'Gemini 4 Argon (High)',
  'gemini-4-argon-low': 'Gemini 4 Argon (Low)',
  'gemini-4-hydrogen-high': 'Gemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh': 'Gemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium': 'Gemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low': 'Gemini 4 Hydrogen (Low)',
  'gemini-4-hydrogen-tiered-high': 'Gemini 4 Hydrogen Tiered (High)',
  'gemini-4-neon-xhigh': 'Gemini 4 Neon (XHigh)',
  'gemini-4-neon-high': 'Gemini 4 Neon (High)',
  'gemini-4-neon-medium': 'Gemini 4 Neon (Medium)',
  'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
  'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
  'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  'claude-sonnet-5-5-low': 'Claude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};

function formatModelLabel(rawModel) {
  const m = String(rawModel || '').trim();
  if (!m || m === 'unknown') return '未标注模型 (早期会话)';
  const lower = m.toLowerCase();
  if (KNOWN_MODEL_NAMES[lower]) return KNOWN_MODEL_NAMES[lower];
  return m
    .split('-')
    .map((p) => (/^\d+(\.\d+)?$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

function detectModelFamily(rawModel) {
  const s = String(rawModel || '').toLowerCase();
  if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
  if (s.includes('claude')) return 'claude';
  if (s.includes('gpt') || s.includes('openai')) return 'gpt';
  return 'other';
}

function parseTranscriptEvents(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  let isSubagent = false;
  let checkedFirst = false;
  let firstUserTitle = '';
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }

    const type = String(obj.type || '').toUpperCase();
    if (!checkedFirst) {
      checkedFirst = true;
      isSubagent = type.includes('SYSTEM_MESSAGE');
    }

    if (!firstUserTitle && type.includes('USER_INPUT') && typeof obj.content === 'string') {
      const clean = obj.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean && !clean.startsWith('/')) {
        firstUserTitle = clean.slice(0, 48);
      }
    }

    if (!type.includes('PLANNER_RESPONSE')) continue;

    const inTok = Math.max(0, Number(obj.input_tokens || 0));
    const cacheTok = Math.max(0, Number(obj.cache_read_tokens || 0));
    const outTok = Math.max(0, Number(obj.output_tokens || 0));
    const tsMs = Date.parse(obj.created_at || '') || 0;
    const model = String(obj.model || '').trim() || 'unknown';
    const tools = Array.isArray(obj.tool_calls)
      ? obj.tool_calls.map((tc) => String(tc?.name || tc?.tool_name || '').trim()).filter(Boolean)
      : [];

    if (inTok === 0 && cacheTok === 0 && outTok === 0 && tools.length === 0) continue;

    events.push({
      tsMs,
      model,
      inTok,
      cacheTok,
      outTok,
      tools,
    });
  }

  return { isSubagent, firstUserTitle, events };
}

async function scanAllTranscripts() {
  if (!fs.existsSync(BRAIN_DIR)) return [];
  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  const results = [];
  let parsedThisRun = 0;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const cid = ent.name;
    const tp = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(tp)) continue;

    let st;
    try {
      st = fs.statSync(tp);
    } catch {
      continue;
    }

    const cached = fileParseCache.get(cid);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      results.push({ cid, ...cached });
      continue;
    }

    try {
      const parsed = parseTranscriptEvents(tp);
      const item = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        title: parsed.firstUserTitle,
        isSubagent: parsed.isSubagent,
        events: parsed.events,
      };
      fileParseCache.set(cid, item);
      results.push({ cid, ...item });
      parsedThisRun += 1;
      // Yield back to the Node event loop periodically on cold scan so UI/WS never stutters
      if (parsedThisRun % 12 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    } catch { /* skip unreadable file */ }
  }

  return results;
}

function formatLocalDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateBoundary(dateStr, endOfDay = false) {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return endOfDay
    ? new Date(y, mo, d, 23, 59, 59, 999).getTime()
    : new Date(y, mo, d, 0, 0, 0, 0).getTime();
}

function resolveTimeWindow({ preset = '7d', start = '', end = '' } = {}) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const nowMs = Date.now();
  const p = String(preset || '7d').toLowerCase();

  if (p === 'today') {
    return {
      preset: 'today',
      startMs: todayStart,
      endMs: nowMs,
      startDate: formatLocalDate(todayStart),
      endDate: formatLocalDate(nowMs),
    };
  }
  if (p === '7d') {
    const s = todayStart - 6 * 86400000;
    return {
      preset: '7d',
      startMs: s,
      endMs: nowMs,
      startDate: formatLocalDate(s),
      endDate: formatLocalDate(nowMs),
    };
  }
  if (p === '30d') {
    const s = todayStart - 29 * 86400000;
    return {
      preset: '30d',
      startMs: s,
      endMs: nowMs,
      startDate: formatLocalDate(s),
      endDate: formatLocalDate(nowMs),
    };
  }
  if (p === 'custom') {
    const parsedStart = parseDateBoundary(start, false);
    const parsedEnd = parseDateBoundary(end, true);
    const s = Number.isFinite(parsedStart) ? parsedStart : todayStart - 6 * 86400000;
    const e = Number.isFinite(parsedEnd) ? Math.max(s, parsedEnd) : nowMs;
    return {
      preset: 'custom',
      startMs: s,
      endMs: e,
      startDate: formatLocalDate(s),
      endDate: formatLocalDate(e),
    };
  }
  return {
    preset: 'all',
    startMs: 0,
    endMs: nowMs,
    startDate: '',
    endDate: formatLocalDate(nowMs),
  };
}

/**
 * Aggregate token consumption, cache hit ratio, per-model breakdown, hourly/daily trend,
 * top tools, and top conversations across the requested time range.
 */
async function readUsageStats({ preset = '7d', start = '', end = '', titleLookup = null } = {}) {
  const win = resolveTimeWindow({ preset, start, end });
  const records = await scanAllTranscripts();

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalTurns = 0;
  let rootTurns = 0;
  let subagentTurns = 0;
  let rootTokens = 0;
  let subagentTokens = 0;
  let totalToolCalls = 0;

  let minTs = Infinity;
  let maxTs = 0;

  /** @type {Map<string, any>} */
  const modelMap = new Map();
  /** @type {Map<string, any>} */
  const trendMap = new Map();
  /** @type {Map<string, number>} */
  const toolMap = new Map();
  const convoSummaries = [];

  const isSingleDay =
    win.preset === 'today' ||
    (win.preset === 'custom' && win.startDate && win.startDate === win.endDate);

  if (isSingleDay) {
    for (let h = 0; h < 24; h++) {
      const k = String(h).padStart(2, '0');
      trendMap.set(k, {
        key: k,
        label: `${k}:00`,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0,
      });
    }
  } else if (win.preset === '7d' || win.preset === '30d' || (win.preset === 'custom' && win.endMs - win.startMs <= 45 * 86400000)) {
    const cursor = new Date(win.startMs);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= win.endMs) {
      const dStr = formatLocalDate(cursor.getTime());
      trendMap.set(dStr, {
        key: dStr,
        label: dStr.slice(5),
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const rec of records) {
    let convInput = 0;
    let convCache = 0;
    let convOutput = 0;
    let convTurns = 0;
    let convLatestTs = 0;
    const convModelTokens = new Map();

    for (const ev of rec.events) {
      const ts = ev.tsMs || rec.mtimeMs;
      if (win.preset !== 'all') {
        if (ts < win.startMs || ts > win.endMs) continue;
      }

      if (ts > 0 && ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;

      const stepTotal = ev.inTok + ev.cacheTok + ev.outTok;
      totalInput += ev.inTok;
      totalCacheRead += ev.cacheTok;
      totalOutput += ev.outTok;
      totalTurns += 1;
      totalToolCalls += ev.tools.length;

      if (rec.isSubagent) {
        subagentTurns += 1;
        subagentTokens += stepTotal;
      } else {
        rootTurns += 1;
        rootTokens += stepTotal;
      }

      convInput += ev.inTok;
      convCache += ev.cacheTok;
      convOutput += ev.outTok;
      convTurns += 1;
      if (ts > convLatestTs) convLatestTs = ts;
      convModelTokens.set(ev.model, (convModelTokens.get(ev.model) || 0) + stepTotal);

      let mEntry = modelMap.get(ev.model);
      if (!mEntry) {
        mEntry = {
          model: ev.model,
          label: formatModelLabel(ev.model),
          family: detectModelFamily(ev.model),
          turns: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolCalls: 0,
        };
        modelMap.set(ev.model, mEntry);
      }
      mEntry.turns += 1;
      mEntry.inputTokens += ev.inTok;
      mEntry.cacheReadTokens += ev.cacheTok;
      mEntry.outputTokens += ev.outTok;
      mEntry.totalTokens += stepTotal;
      mEntry.toolCalls += ev.tools.length;

      for (const toolName of ev.tools) {
        toolMap.set(toolName, (toolMap.get(toolName) || 0) + 1);
      }

      if (ts > 0) {
        const key = isSingleDay
          ? String(new Date(ts).getHours()).padStart(2, '0')
          : formatLocalDate(ts);
        let b = trendMap.get(key);
        if (!b) {
          b = {
            key,
            label: isSingleDay ? `${key}:00` : key.slice(5),
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            turns: 0,
          };
          trendMap.set(key, b);
        }
        b.inputTokens += ev.inTok;
        b.cacheReadTokens += ev.cacheTok;
        b.outputTokens += ev.outTok;
        b.totalTokens += stepTotal;
        b.turns += 1;
      }
    }

    if (convTurns > 0) {
      const convPrompt = convInput + convCache;
      let primaryModel = 'unknown';
      let primaryMax = -1;
      for (const [m, tok] of convModelTokens.entries()) {
        if (tok > primaryMax) {
          primaryMax = tok;
          primaryModel = m;
        }
      }
      let title = (titleLookup && titleLookup.get(rec.cid)) || '';
      if (!title && !rec.isSubagent) {
        title = readSingleAnnotation(rec.cid)?.title || rec.title || '';
      }
      if (!title) {
        title = rec.isSubagent ? `子代理任务 (${rec.cid.slice(0, 8)})` : (rec.title || `会话 ${rec.cid.slice(0, 8)}`);
      }
      convoSummaries.push({
        conversationId: rec.cid,
        title,
        isSubagent: rec.isSubagent,
        turns: convTurns,
        inputTokens: convInput,
        cacheReadTokens: convCache,
        outputTokens: convOutput,
        totalTokens: convInput + convCache + convOutput,
        cacheHitRate: convPrompt > 0 ? Number(((convCache / convPrompt) * 100).toFixed(1)) : 0,
        primaryModel: formatModelLabel(primaryModel),
        primaryFamily: detectModelFamily(primaryModel),
        updatedAt: convLatestTs,
      });
    }
  }

  const totalTokens = totalInput + totalCacheRead + totalOutput;
  const totalPromptTokens = totalInput + totalCacheRead;
  const cacheHitRate = totalPromptTokens > 0 ? Number(((totalCacheRead / totalPromptTokens) * 100).toFixed(1)) : 0;

  const byModel = Array.from(modelMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m) => {
      const mPrompt = m.inputTokens + m.cacheReadTokens;
      return {
        ...m,
        cacheHitRate: mPrompt > 0 ? Number(((m.cacheReadTokens / mPrompt) * 100).toFixed(1)) : 0,
        sharePercent: totalTokens > 0 ? Number(((m.totalTokens / totalTokens) * 100).toFixed(1)) : 0,
      };
    });

  const trendBuckets = Array.from(trendMap.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => {
      const bp = b.inputTokens + b.cacheReadTokens;
      return {
        ...b,
        cacheHitRate: bp > 0 ? Number(((b.cacheReadTokens / bp) * 100).toFixed(1)) : 0,
      };
    });

  // For 'all' range with many days, keep the most recent 30 active days so chart stays readable
  const displayTrend =
    win.preset === 'all' && trendBuckets.length > 30
      ? trendBuckets.slice(-30)
      : trendBuckets;

  const topTools = Array.from(toolMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name,
      count,
      sharePercent: totalToolCalls > 0 ? Number(((count / totalToolCalls) * 100).toFixed(1)) : 0,
    }));

  const topConversations = convoSummaries
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 6);

  return {
    range: {
      preset: win.preset,
      startDate: win.startDate || (Number.isFinite(minTs) ? formatLocalDate(minTs) : formatLocalDate(Date.now())),
      endDate: win.endDate,
    },
    summary: {
      totalTokens,
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      totalPromptTokens,
      cacheHitRate,
      turns: totalTurns,
      rootTurns,
      subagentTurns,
      rootTokens,
      subagentTokens,
      conversations: convoSummaries.length,
      toolCalls: totalToolCalls,
      avgTokensPerTurn: totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0,
    },
    byModel,
    trend: {
      granularity: isSingleDay ? 'hour' : 'day',
      buckets: displayTrend,
    },
    topTools,
    topConversations,
    updatedAt: Date.now(),
  };
}

function resolveConversationTitle(cid, rec, titleLookup) {
  let title = (titleLookup && titleLookup.get(cid)) || '';
  if (!title && !rec.isSubagent) {
    title = readSingleAnnotation(cid)?.title || rec.title || '';
  }
  if (!title) {
    title = rec.isSubagent ? `子代理任务 (${cid.slice(0, 8)})` : (rec.title || `会话 ${cid.slice(0, 8)}`);
  }
  return title;
}

/**
 * Query paginated detailed turns & per-conversation rollup for a single model inside the time range.
 */
async function readModelDetailStats({
  model = '',
  preset = '7d',
  start = '',
  end = '',
  tab = 'turns',
  page = 1,
  pageSize = 10,
  titleLookup = null,
} = {}) {
  const targetModel = String(model || '').trim() || 'unknown';
  const win = resolveTimeWindow({ preset, start, end });
  const records = await scanAllTranscripts();

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalTurns = 0;
  let rootTurns = 0;
  let subagentTurns = 0;
  let rootTokens = 0;
  let subagentTokens = 0;
  let totalToolCalls = 0;
  let minTs = Infinity;

  const toolMap = new Map();
  const matchedTurns = [];
  const matchedConvos = [];

  for (const rec of records) {
    let convInput = 0;
    let convCache = 0;
    let convOutput = 0;
    let convTurns = 0;
    let convTools = 0;
    let convLatestTs = 0;
    let resolvedTitle = '';

    for (const ev of rec.events) {
      if (ev.model !== targetModel) continue;
      const ts = ev.tsMs || rec.mtimeMs;
      if (win.preset !== 'all' && (ts < win.startMs || ts > win.endMs)) continue;

      if (!resolvedTitle) {
        resolvedTitle = resolveConversationTitle(rec.cid, rec, titleLookup);
      }
      if (ts > 0 && ts < minTs) minTs = ts;

      const stepPrompt = ev.inTok + ev.cacheTok;
      const stepTotal = stepPrompt + ev.outTok;
      totalInput += ev.inTok;
      totalCacheRead += ev.cacheTok;
      totalOutput += ev.outTok;
      totalTurns += 1;
      totalToolCalls += ev.tools.length;

      if (rec.isSubagent) {
        subagentTurns += 1;
        subagentTokens += stepTotal;
      } else {
        rootTurns += 1;
        rootTokens += stepTotal;
      }

      convInput += ev.inTok;
      convCache += ev.cacheTok;
      convOutput += ev.outTok;
      convTurns += 1;
      convTools += ev.tools.length;
      if (ts > convLatestTs) convLatestTs = ts;

      for (const toolName of ev.tools) {
        toolMap.set(toolName, (toolMap.get(toolName) || 0) + 1);
      }

      matchedTurns.push({
        tsMs: ts,
        conversationId: rec.cid,
        title: resolvedTitle,
        isSubagent: rec.isSubagent,
        inputTokens: ev.inTok,
        cacheReadTokens: ev.cacheTok,
        outputTokens: ev.outTok,
        totalTokens: stepTotal,
        cacheHitRate: stepPrompt > 0 ? Number(((ev.cacheTok / stepPrompt) * 100).toFixed(1)) : 0,
        tools: ev.tools,
      });
    }

    if (convTurns > 0) {
      const convPrompt = convInput + convCache;
      matchedConvos.push({
        conversationId: rec.cid,
        title: resolvedTitle,
        isSubagent: rec.isSubagent,
        turns: convTurns,
        inputTokens: convInput,
        cacheReadTokens: convCache,
        outputTokens: convOutput,
        totalTokens: convPrompt + convOutput,
        cacheHitRate: convPrompt > 0 ? Number(((convCache / convPrompt) * 100).toFixed(1)) : 0,
        toolCalls: convTools,
        updatedAt: convLatestTs,
      });
    }
  }

  matchedTurns.sort((a, b) => b.tsMs - a.tsMs);
  matchedConvos.sort((a, b) => b.totalTokens - a.totalTokens);

  const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 10));
  const activeTab = String(tab || 'turns').toLowerCase() === 'conversations' ? 'conversations' : 'turns';
  const sourceList = activeTab === 'conversations' ? matchedConvos : matchedTurns;
  const totalItems = sourceList.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const safePage = Math.max(1, Math.min(totalPages, Number(page) || 1));
  const items = sourceList.slice((safePage - 1) * safeSize, safePage * safeSize);

  const totalTokens = totalInput + totalCacheRead + totalOutput;
  const totalPromptTokens = totalInput + totalCacheRead;
  const cacheHitRate = totalPromptTokens > 0 ? Number(((totalCacheRead / totalPromptTokens) * 100).toFixed(1)) : 0;

  const topTools = Array.from(toolMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({
      name,
      count,
      sharePercent: totalToolCalls > 0 ? Number(((count / totalToolCalls) * 100).toFixed(1)) : 0,
    }));

  return {
    model: targetModel,
    label: formatModelLabel(targetModel),
    family: detectModelFamily(targetModel),
    range: {
      preset: win.preset,
      startDate: win.startDate || (Number.isFinite(minTs) ? formatLocalDate(minTs) : formatLocalDate(Date.now())),
      endDate: win.endDate,
    },
    summary: {
      totalTokens,
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      cacheHitRate,
      turns: totalTurns,
      rootTurns,
      subagentTurns,
      rootTokens,
      subagentTokens,
      conversations: matchedConvos.length,
      toolCalls: totalToolCalls,
      avgTokensPerTurn: totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0,
    },
    topTools,
    tab: activeTab,
    pagination: {
      page: safePage,
      pageSize: safeSize,
      totalItems,
      totalPages,
      turnsTotal: matchedTurns.length,
      conversationsTotal: matchedConvos.length,
    },
    items,
  };
}

module.exports = {
  readUsageStats,
  readModelDetailStats,
  formatModelLabel,
};
