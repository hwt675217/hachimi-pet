const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { fileURLToPath } = require('node:url');

/**
 * Strip XML wrapper tags such as <USER_REQUEST>...</USER_REQUEST> and <CONTEXT_SUMMARY>...</CONTEXT_SUMMARY>
 * from transcript user inputs.
 */
function cleanUserContent(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '').trim();
  const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const body = (match ? match[1] : text).trim();
  if (/^Error:\s*The stream was interrupted/i.test(body)) return '';
  return body;
}

/**
 * Unwrap protojson double-encoded string/array/object args like `"\"path\""` or `"[\"id\"]"`.
 */
function normalizeToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        trimmed === 'true' ||
        trimmed === 'false'
      ) {
        try {
          out[k] = JSON.parse(trimmed);
          continue;
        } catch {
          /* keep raw */
        }
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * Convert a `file:///...` URI to a local filesystem path safely.
 */
function uriToFsPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (!/^file:\/\//i.test(uri)) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\/\/?/i, '')).replace(/\//g, '\\');
  }
}

/**
 * Summarize thinking text into a crisp single-line snippet for the head speech bubble.
 */
function summarizeThinking(thinking) {
  if (!thinking || typeof thinking !== 'string') return '';
  const lines = thinking
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\d.\s`]+/, '').trim())
    .filter((l) => l.length > 4);
  if (!lines.length) return '';
  const tail = lines[lines.length - 1];
  return tail.length > 88 ? tail.slice(0, 86) + '…' : tail;
}

/**
 * Incremental JSONL watcher for Antigravity conversation transcripts (`transcript.jsonl`).
 * Uses both `fs.watch` and a lightweight 650ms stat check so Windows NTFS buffered appends
 * are always picked up promptly without high CPU usage.
 */
class TranscriptWatcher extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { path: string, offset: number, remainder: string, skipPartialFirstLine: boolean, fsWatcher: fs.FSWatcher | null }>} */
    this.targets = new Map();
    this.pollTimer = setInterval(() => this._pollAll(), 650);
    this.pollTimer.unref?.();
  }

  /**
   * Attach or update the transcript path for a conversationId.
   * @param {string} conversationId
   * @param {string} transcriptPath
   * @param {{ maxInitialBytes?: number }} [opts]
   */
  attach(conversationId, transcriptPath, opts = {}) {
    if (!conversationId || !transcriptPath) return;
    const existing = this.targets.get(conversationId);
    if (existing && existing.path === transcriptPath) {
      this._readDelta(conversationId, false);
      return;
    }
    if (existing?.fsWatcher) {
      try { existing.fsWatcher.close(); } catch { /* ignore */ }
    }

    const maxBytes = typeof opts.maxInitialBytes === 'number' ? opts.maxInitialBytes : 131072;
    let initialOffset = 0;
    try {
      if (fs.existsSync(transcriptPath)) {
        const stat = fs.statSync(transcriptPath);
        initialOffset = maxBytes > 0 ? Math.max(0, stat.size - maxBytes) : 0;
      }
    } catch { /* file may not be created yet */ }

    const entry = {
      path: transcriptPath,
      offset: initialOffset,
      remainder: '',
      skipPartialFirstLine: initialOffset > 0,
      fsWatcher: null,
    };
    this.targets.set(conversationId, entry);
    this._bindFsWatch(conversationId, entry);
    this._readDelta(conversationId, true);
  }

  /**
   * Detach a conversation transcript watcher when a child subagent retires.
   * @param {string} conversationId
   */
  detach(conversationId) {
    const existing = this.targets.get(conversationId);
    if (!existing) return;
    if (existing.fsWatcher) {
      try { existing.fsWatcher.close(); } catch { /* ignore */ }
    }
    this.targets.delete(conversationId);
  }

  has(conversationId) {
    return this.targets.has(conversationId);
  }

  _bindFsWatch(conversationId, entry) {
    try {
      if (fs.existsSync(entry.path)) {
        entry.fsWatcher = fs.watch(entry.path, { persistent: false }, () => {
          this._readDelta(conversationId, false);
        });
        entry.fsWatcher.on('error', () => {
          try { entry.fsWatcher?.close(); } catch { /* ignore */ }
          entry.fsWatcher = null;
        });
      }
    } catch { /* fallback poll handles it */ }
  }

  _pollAll() {
    for (const [conversationId, entry] of this.targets.entries()) {
      if (!entry.fsWatcher && fs.existsSync(entry.path)) {
        this._bindFsWatch(conversationId, entry);
      }
      this._readDelta(conversationId, false);
    }
  }

  _readDelta(conversationId, isInitial) {
    const entry = this.targets.get(conversationId);
    if (!entry || !fs.existsSync(entry.path)) return;

    let stat;
    try {
      stat = fs.statSync(entry.path);
    } catch {
      return;
    }

    if (stat.size < entry.offset) {
      entry.offset = 0;
      entry.remainder = '';
    }
    if (stat.size === entry.offset) return;

    const length = stat.size - entry.offset;
    const buf = Buffer.alloc(length);
    let fd = null;
    try {
      fd = fs.openSync(entry.path, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, length, entry.offset);
      entry.offset += bytesRead;
      const chunk = entry.remainder + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      entry.remainder = lines.pop() ?? '';

      for (let i = 0; i < lines.length; i++) {
        if (entry.skipPartialFirstLine) {
          entry.skipPartialFirstLine = false;
          continue;
        }
        const line = lines[i].trim();
        if (!line) continue;
        this._processLine(conversationId, line, isInitial);
      }
    } catch {
      // Ignore transient read locks
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  _processLine(conversationId, line, quietHistorical) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      return;
    }
    const type = String(step.type || '').toUpperCase();
    const stepStatus = String(step.status || '').toUpperCase();
    const createdAt = step.created_at || new Date().toISOString();

    if (stepStatus.includes('CANCEL')) {
      this.emit('step', {
        conversationId,
        kind: 'canceled',
        step,
        createdAt,
        quiet: quietHistorical,
      });
      return;
    }

    if (type.includes('ERROR_MESSAGE')) {
      const errText = typeof step.content === 'string' ? step.content.trim() : '';
      if (errText) {
        this.emit('step', {
          conversationId,
          kind: 'error_step',
          text: errText,
          createdAt,
          quiet: quietHistorical,
        });
      }
      return;
    }

    if (type.includes('USER_INPUT')) {
      const text = cleanUserContent(step.content);
      if (text) {
        this.emit('step', {
          conversationId,
          kind: 'user_input',
          text,
          createdAt,
          quiet: quietHistorical,
        });
      }
      return;
    }

    if (type.includes('SYSTEM_MESSAGE') && typeof step.content === 'string') {
      const senderMatch = step.content.match(/\[Message\][^\n]*\bsender=([^\s]+)/);
      if (senderMatch) {
        this.emit('step', {
          conversationId,
          kind: 'incoming_message',
          sender: senderMatch[1],
          content: step.content,
          createdAt,
          quiet: quietHistorical,
        });
      }
      return;
    }

    if (type === 'GENERIC' && typeof step.content === 'string') {
      const c = step.content;
      // 1. Subagent creation confirmation with child conversationId & transcript URI
      if (c.includes('Created the following subagent:')) {
        const jsonMatch = c.match(/Created the following subagent:\s*(\{[\s\S]*?\})/);
        if (jsonMatch) {
          try {
            const info = JSON.parse(jsonMatch[1]);
            if (info.conversationId) {
              this.emit('step', {
                conversationId,
                kind: 'subagent_created',
                childConversationId: info.conversationId,
                childTranscriptPath: uriToFsPath(info.logAbsoluteUri || ''),
                createdAt,
                quiet: quietHistorical,
              });
            }
          } catch { /* ignore malformed */ }
        }
      } else if (c.includes('You have ') && c.includes('active subagent(s):')) {
        const arrMatch = c.match(/active subagent\(s\):\s*(\[[\s\S]*\])/);
        if (arrMatch) {
          try {
            const list = JSON.parse(arrMatch[1]);
            if (Array.isArray(list)) {
              this.emit('step', {
                conversationId,
                kind: 'subagent_list',
                subagents: list.map((item) => ({
                  ...item,
                  transcriptPath: uriToFsPath(item.transcript || ''),
                })),
                createdAt,
                quiet: quietHistorical,
              });
            }
          } catch { /* ignore */ }
        }
      } else if (/Successfully killed \d+ subagent/i.test(c)) {
        const rolesMatch = c.match(/Killed roles:\s*(.+)/i);
        this.emit('step', {
          conversationId,
          kind: 'subagent_killed_confirm',
          killedRoles: rolesMatch ? rolesMatch[1].trim() : '',
          createdAt,
          quiet: quietHistorical,
        });
      }
      return;
    }

    if (type.includes('CHECKPOINT')) {
      this.emit('step', {
        conversationId,
        kind: 'compacted',
        step,
        createdAt,
        quiet: quietHistorical,
      });
      return;
    }

    if (type.includes('PLANNER_RESPONSE')) {
      if (step.input_tokens || step.cache_read_tokens || step.output_tokens) {
        this.emit('step', {
          conversationId,
          kind: 'usage',
          step,
          createdAt,
          quiet: quietHistorical,
        });
      }

      const thinkingSummary = summarizeThinking(step.thinking);
      if (thinkingSummary) {
        this.emit('step', {
          conversationId,
          kind: 'thinking',
          text: thinkingSummary,
          fullThinking: step.thinking,
          createdAt,
          quiet: quietHistorical,
        });
      }

      const hasTools = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
      if (hasTools) {
        for (const tc of step.tool_calls) {
          const name = tc.name || tc.tool_name || '';
          const args = normalizeToolArgs(tc.args || tc.arguments || {});
          if (name) {
            this.emit('step', {
              conversationId,
              kind: name === 'ask_question' ? 'ask_question' : 'tool_call',
              toolName: name,
              args,
              createdAt,
              quiet: quietHistorical,
            });
          }
        }
      }

      const contentText = typeof step.content === 'string' ? step.content.trim() : '';
      if (contentText) {
        this.emit('step', {
          conversationId,
          kind: 'assistant_reply',
          text: contentText,
          finalTurn: !hasTools,
          createdAt,
          quiet: quietHistorical,
        });
      } else if (!hasTools) {
        this.emit('step', {
          conversationId,
          kind: 'turn_end',
          createdAt,
          quiet: quietHistorical,
        });
      }
    }
  }

  dispose() {
    clearInterval(this.pollTimer);
    for (const entry of this.targets.values()) {
      try { entry.fsWatcher?.close(); } catch { /* ignore */ }
    }
    this.targets.clear();
  }
}

module.exports = { TranscriptWatcher, cleanUserContent, summarizeThinking, normalizeToolArgs, uriToFsPath };
