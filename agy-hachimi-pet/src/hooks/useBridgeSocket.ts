import { useEffect, useRef, useState, useCallback } from 'react';
import type { BridgeSnapshot, PetReactionEvent, PetSettings } from '../types';

const DEFAULT_SETTINGS: PetSettings = {
  mode: 'companion',
  scheme: 'deepseek',
  outfit: 'maid',
  autoSchemeByModel: false,
  roam: 'free',
  scale: 0.95,
  soundOn: true,
  safetyGateEnabled: false,
  interceptRiskyOnly: true,
  interceptAllCommands: false,
  defaultWorkspace: '',
  savedProjects: [],
  selectedProject: '',
  selectedProjectId: '',
};

const EMPTY_SNAPSHOT: BridgeSnapshot = {
  settings: DEFAULT_SETTINGS,
  activeConversationId: null,
  agyRunning: false,
  projects: [],
  sessions: [],
  pendingApprovals: [],
  pendingMcpWaits: [],
  queuedCounts: {},
  subagents: [],
  quota: null,
};

export function useBridgeSocket(
  onReaction?: (ev: PetReactionEvent) => void,
  onCommand?: (cmd: { type: string; [key: string]: unknown }) => void
) {
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<BridgeSnapshot>(EMPTY_SNAPSHOT);
  const [liveThinking, setLiveThinking] = useState('');
  const [streamingReply, setStreamingReply] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onReactionRef = useRef(onReaction);
  onReactionRef.current = onReaction;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    const port = window.petHost?.bridgePort || 17890;
    let disposed = false;
    let reconnectTimer: number | undefined;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const { type, payload } = msg;
          if (type === 'state:sync' && payload) {
            setSnapshot(payload);
            if (!payload.agyRunning) {
              setStreamingReply(null);
            }
          } else if (type === 'pet:Reaction' && payload) {
            onReactionRef.current?.(payload);
          } else if (type === 'pet:command' && payload) {
            onCommandRef.current?.(payload);
          } else if (type === 'pet:thinking' && payload?.text) {
            setLiveThinking(payload.text);
          } else if (type === 'pet:stream_delta' && payload?.fullText) {
            setStreamingReply(payload.fullText);
          } else if (type === 'pet:assistant' && payload?.text) {
            setLiveThinking('');
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const sendAction = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  const sendCommand = useCallback(
    (text: string, opts?: { conversationId?: string | null; mode?: string; cwd?: string }) => {
      sendAction('ui:send_command', {
        text,
        conversationId: opts?.conversationId ?? snapshot.activeConversationId,
        mode: opts?.mode ?? snapshot.settings.mode,
        cwd: opts?.cwd,
      });
    },
    [sendAction, snapshot.activeConversationId, snapshot.settings.mode]
  );

  const selectProject = useCallback(
    (projectId: string) => {
      sendAction('ui:select_project', { projectId });
    },
    [sendAction]
  );

  const startNewProjectChat = useCallback(
    (projectId: string) => {
      sendAction('ui:new_project_chat', { projectId });
    },
    [sendAction]
  );

  const resolveApproval = useCallback(
    (id: string, decision: 'allow' | 'deny') => {
      sendAction('ui:resolve_approval', { id, decision });
    },
    [sendAction]
  );

  const cancelMcpWait = useCallback(
    (id: string) => {
      sendAction('ui:cancel_mcp_wait', { id });
    },
    [sendAction]
  );

  const stopAgy = useCallback(() => {
    sendAction('ui:stop_agy');
  }, [sendAction]);

  const selectSession = useCallback(
    (conversationId: string) => {
      sendAction('ui:select_session', { conversationId });
    },
    [sendAction]
  );

  const updateSettings = useCallback(
    (patch: Partial<PetSettings>) => {
      setSnapshot((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
      sendAction('ui:update_settings', patch as Record<string, unknown>);
    },
    [sendAction]
  );

  const reportDiag = useCallback(
    (diag: Record<string, unknown>) => {
      sendAction('ui:whale_diag', diag);
    },
    [sendAction]
  );

  const testSpawnSubagent = useCallback(
    (custom?: { name?: string; role?: string }) => {
      sendAction('ui:test_spawn_subagent', custom || {});
    },
    [sendAction]
  );

  const clearSubagents = useCallback(() => {
    sendAction('ui:clear_subagents', {});
  }, [sendAction]);

  const removeSubagent = useCallback((id: string) => {
    sendAction('ui:remove_subagent', { id });
  }, [sendAction]);

  return {
    connected,
    snapshot,
    liveThinking,
    streamingReply,
    sendCommand,
    selectProject,
    startNewProjectChat,
    resolveApproval,
    cancelMcpWait,
    stopAgy,
    selectSession,
    updateSettings,
    reportDiag,
    testSpawnSubagent,
    clearSubagents,
    removeSubagent,
  };
}
