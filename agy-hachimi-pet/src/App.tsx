import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WhaleStage, type WhaleControllerHandle } from './components/WhaleStage';
import { StatusBubble } from './components/StatusBubble';
import { ApprovalPopover } from './components/ApprovalPopover';
import { StatsPanel } from './components/StatsPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useBridgeSocket } from './hooks/useBridgeSocket';
import type { PetReactionEvent } from './types';

export const App: React.FC = () => {
  const whaleRef = useRef<WhaleControllerHandle | null>(null);
  const [speechText, setSpeechText] = useState('');
  const [statsOpen, setStatsOpen] = useState(false);
  const [anchorPos, setAnchorPos] = useState({
    x: window.innerWidth - 150,
    y: window.innerHeight - 235,
    sideX: window.innerWidth - 150,
    sideY: window.innerHeight - 130,
  });

  const handleReaction = useCallback((ev: PetReactionEvent) => {
    whaleRef.current?.triggerReaction(ev);
    if (ev.speech) {
      setSpeechText(ev.speech);
    }
  }, []);

  const handleHostCommand = useCallback((cmd: { type: string }) => {
    if (cmd?.type === 'resetPosition') {
      whaleRef.current?.resetCornerPosition();
    } else if (cmd?.type === 'openStats') {
      setStatsOpen((v) => !v);
    }
  }, []);

  const {
    connected,
    snapshot,
    liveThinking,
    resolveApproval,
    reportDiag,
  } = useBridgeSocket(handleReaction, handleHostCommand);

  // Listen for native host commands (Electron IPC / WebView2 WebMessage)
  useEffect(() => {
    if (!window.petHost) return;
    return window.petHost.onCommand(handleHostCommand);
  }, [handleHostCommand]);

  const activeSession =
    snapshot.sessions.find((s) => s.conversationId === snapshot.activeConversationId) || snapshot.sessions[0];

  const currentStatus = snapshot.agyRunning
    ? 'THINKING'
    : activeSession?.status || 'IDLE';

  const currentBadge = activeSession?.badge || (connected ? '🐳 已连接 · 待机伴随中' : '🔌 正在连接本地桥接服务…');

  const handlePetCheer = useCallback(() => {
    whaleRef.current?.triggerReaction({ expression: 'happy', motion: 'wave' });
  }, []);

  const handleToggleStats = useCallback(() => {
    setStatsOpen((v) => !v);
  }, []);

  const handleCloseStats = useCallback(() => {
    setStatsOpen(false);
  }, []);

  const bridgePort = window.petHost?.bridgePort || 17890;

  return (
    <ErrorBoundary name="root" bridgePort={bridgePort} autoRecoverMs={1200}>
      <div className="desktop-overlay-root">
        <ErrorBoundary name="whale-stage" bridgePort={bridgePort} autoRecoverMs={1500}>
          <WhaleStage
            ref={whaleRef}
            settings={snapshot.settings}
            subagents={snapshot.subagents}
            onAnchorMove={setAnchorPos}
            onDiag={reportDiag}
          />
        </ErrorBoundary>

        <ErrorBoundary name="status-bubble" bridgePort={bridgePort} autoRecoverMs={1500}>
          <StatusBubble
            anchor={{ x: anchorPos.x, y: anchorPos.y }}
            status={currentStatus}
            badge={currentBadge}
            thinkingText={liveThinking || activeSession?.lastThinking || ''}
            speechText={speechText}
            telemetry={activeSession?.telemetry || null}
            quota={snapshot.quota || null}
            onClickBadge={handlePetCheer}
            onOpenStats={handleToggleStats}
          />
        </ErrorBoundary>

        <ErrorBoundary
          name="stats-panel"
          bridgePort={bridgePort}
          fallback={(reset) =>
            statsOpen ? (
              <div className="stats-panel" data-pet-interactive="true" style={{ padding: 16 }}>
                <div className="stats-header">
                  <span className="stats-title">统计面板异常已隔离</span>
                  <div className="stats-header-actions">
                    <button
                      type="button"
                      className="stats-page-btn"
                      onClick={reset}
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      className="stats-icon-btn"
                      onClick={() => {
                        reset();
                        setStatsOpen(false);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            ) : null
          }
        >
          <StatsPanel
            open={statsOpen}
            bridgePort={bridgePort}
            quota={snapshot.quota || null}
            onClose={handleCloseStats}
          />
        </ErrorBoundary>

        <ErrorBoundary name="approval-popover" bridgePort={bridgePort}>
          <ApprovalPopover
            approval={snapshot.pendingApprovals[0] || null}
            onResolve={resolveApproval}
          />
        </ErrorBoundary>
      </div>
    </ErrorBoundary>
  );
};
