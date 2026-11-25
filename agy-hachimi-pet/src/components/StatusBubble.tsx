import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PetExecutionStatus, QuotaBucket, QuotaSummary, SessionTelemetry } from '../types';

interface StatusBubbleProps {
  anchor: { x: number; y: number };
  status: PetExecutionStatus;
  badge: string;
  thinkingText: string;
  speechText: string;
  telemetry?: SessionTelemetry | null;
  quota?: QuotaSummary | null;
  onClickBadge?: () => void;
  onOpenStats?: () => void;
  opacity?: number;
  hudScale: number;
  hudGap: number;
}

const STATUS_DOT_CLASS: Record<PetExecutionStatus, string> = {
  IDLE: 'dot-idle',
  THINKING: 'dot-thinking',
  READING: 'dot-working',
  CODING: 'dot-working',
  RUNNING_CMD: 'dot-cmd',
  WAITING_USER: 'dot-warn',
  AWAITING_NEXT: 'dot-ready',
  ERROR: 'dot-error',
};

function getContextRingColor(pct: number): string {
  if (pct >= 85) return '#fb7185'; // High / near compaction
  if (pct >= 62) return '#f59e0b'; // Warm amber (matches Antigravity's 70-85% ring)
  return '#34d399';                // Healthy emerald
}

function getQuotaColor(remainingPct: number): string {
  if (remainingPct < 20) return '#fb7185';
  if (remainingPct < 50) return '#f59e0b';
  return '#34d399';
}

function formatCompactPct(pct: number): string {
  if (pct > 0 && pct < 10) return pct.toFixed(1);
  return String(Math.round(pct));
}

function formatResetCountdown(resetTime?: string): string {
  if (!resetTime) return '';
  const targetMs = Date.parse(resetTime);
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return '即将刷新';
  const totalMins = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function renderQuotaBucketMeta(bucket: QuotaBucket | null): { pctText: string; usedText: string; color: string; resetText: string } {
  const rem = bucket ? Math.max(0, Math.min(100, bucket.remainingPercent)) : 100;
  const used = bucket?.usedPercent !== undefined
    ? Math.max(0, Math.min(100, bucket.usedPercent))
    : Number((100 - rem).toFixed(1));
  return {
    pctText: `余 ${rem.toFixed(1)}%`,
    usedText: `已用 ${used.toFixed(1)}%`,
    color: getQuotaColor(rem),
    resetText: formatResetCountdown(bucket?.resetTime),
  };
}

export const StatusBubble: React.FC<StatusBubbleProps> = ({
  anchor,
  status,
  badge,
  thinkingText,
  speechText,
  telemetry,
  quota,
  onClickBadge,
  onOpenStats,
  opacity = 1,
  hudScale,
  hudGap,
}) => {
  const [typedSpeech, setTypedSpeech] = useState('');
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubbleSize, setBubbleSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const measure = () => setBubbleSize({ width: bubble.offsetWidth, height: bubble.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!speechText) {
      setTypedSpeech('');
      return;
    }
    let idx = 0;
    setTypedSpeech('');
    const iv = window.setInterval(() => {
      idx++;
      setTypedSpeech(speechText.slice(0, idx));
      if (idx >= speechText.length) {
        clearInterval(iv);
      }
    }, 45);
    const hideTimer = window.setTimeout(() => {
      setTypedSpeech('');
    }, Math.max(4800, speechText.length * 60 + 3000));

    return () => {
      clearInterval(iv);
      clearTimeout(hideTimer);
    };
  }, [speechText]);

  const edgeX = Math.min(window.innerWidth / 2, bubbleSize.width * hudScale / 2 + 4);
  const clampedX = Math.max(edgeX, Math.min(window.innerWidth - edgeX, anchor.x));
  const clampedY = Math.min(window.innerHeight, Math.max(bubbleSize.height * hudScale + 4, anchor.y - hudGap));

  const showThinking = (status === 'THINKING' || status === 'READING' || status === 'CODING') && !!thinkingText;

  const hasContext = Boolean(telemetry && telemetry.contextLimit > 0 && (telemetry.contextUsed > 0 || telemetry.compacted));
  const ctxPct = hasContext ? Math.min(100, Math.max(0, Number(telemetry?.contextPercent || 0))) : 0;
  const ctxRingColor = getContextRingColor(ctxPct);
  const radius = 5.8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ctxPct / 100);

  const ctxTooltip = hasContext
    ? `${telemetry!.compacted ? '已压缩 · ' : ''}${Number(telemetry!.contextUsed || 0).toLocaleString('en-US')} / ${Number(telemetry!.contextLimit || 0).toLocaleString('en-US')} (${ctxPct.toFixed(1)}%)`
    : '暂无上下文统计';

  const overallTok = Number(telemetry?.overallTokPerSec || 0);
  const streamTok = Number(telemetry?.streamTokPerSec || 0);
  const ttftSec = Number(telemetry?.ttftSec || 0);
  const outTok = Number(telemetry?.outputTokens || 0);
  const hasTok = Boolean(telemetry && (overallTok > 0 || outTok > 0));
  const tokSpeedLabel = hasTok && overallTok > 0 ? overallTok.toFixed(1) : '--';
  const tokTooltip = hasTok
    ? [
        `综合 ${overallTok.toFixed(1)} tok/s`,
        streamTok > 0 ? `流式 ${streamTok.toFixed(1)}` : null,
        ttftSec > 0 ? `TTFT ${ttftSec.toFixed(2)}s` : null,
        outTok > 0 ? `${outTok.toLocaleString('en-US')} tok` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '等待本轮生成统计…';

  return (
    <div
      ref={bubbleRef}
      className="status-bubble-wrap dynamic-head-wrap"
      style={{ left: `${clampedX}px`, top: `${clampedY}px`, opacity }}
    >
      {/* Transient Speech / Live Thinking Island */}
      {typedSpeech ? (
        <div
          className="dynamic-speech-cloud"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className="speech-avatar">🐳</span>
          <span className="speech-text">{typedSpeech}</span>
        </div>
      ) : showThinking ? (
        <div
          className="dynamic-thinking-island"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className="thinking-icon">💭</span>
          <span className="thinking-marquee">{thinkingText}</span>
        </div>
      ) : null}

      {/* Main Agent Status Feedback Pill */}
      <button
        type="button"
        className={`status-pill status-${status.toLowerCase()}`}
        data-pet-interactive="true"
        onClick={onClickBadge}
      >
        <span className={`status-dot ${STATUS_DOT_CLASS[status]}`} />
        <span className="status-badge-text">{badge || '待机伴随中～'}</span>
      </button>

      {/* Antigravity Native-Style Context Window & Token Throughput Telemetry Bar */}
      {(hasContext || hasTok) && (
        <div className="telemetry-bar">
          {hasContext && (
            <div className="telemetry-chip context-chip" data-pet-interactive="true">
              <svg className="ctx-ring-svg" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <circle
                  className="ctx-ring-track"
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  strokeWidth="2.1"
                />
                <circle
                  className="ctx-ring-fill"
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke={ctxRingColor}
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 8 8)"
                />
              </svg>
              <span className="ctx-pct-text" style={{ color: ctxPct >= 85 ? '#fda4af' : '#d5dff7' }}>
                {ctxPct.toFixed(1)}%
              </span>
              <div className="telemetry-tooltip">{ctxTooltip}</div>
            </div>
          )}

          {hasTok && (
            <div className="telemetry-chip tok-chip" data-pet-interactive="true">
              <span className="tok-val">{tokSpeedLabel}</span>
              <span className="tok-unit">tok/s</span>
              <div className="telemetry-tooltip">{tokTooltip}</div>
            </div>
          )}
        </div>
      )}

      {/* Model Quota Bar (Default Gemini 5h & Weekly; hover to inspect all model groups) + Stats Trigger */}
      {(() => {
        const groups = quota?.groups || [];
        const defIdx = Math.min(Math.max(0, groups.length - 1), Math.max(0, quota?.defaultGroupIndex ?? 0));
        const defGroup = groups[defIdx];
        const hasQuota = Boolean(defGroup && (defGroup.fiveHour || defGroup.weekly));
        if (!hasQuota && !onOpenStats) return null;
        const p5 = defGroup?.fiveHour ? defGroup.fiveHour.remainingPercent : 100;
        const pw = defGroup?.weekly ? defGroup.weekly.remainingPercent : 100;
        return (
          <div className="quota-bar">
            {hasQuota && defGroup && (
              <div className="telemetry-chip quota-chip" data-pet-interactive="true">
                <span className="quota-prefix">{defGroup.shortName}</span>
                {defGroup.fiveHour && (
                  <span className="quota-seg">
                    <span className="quota-dot" style={{ backgroundColor: getQuotaColor(p5) }} />
                    <span className="quota-win">5h</span>
                    <span className="quota-val">{formatCompactPct(p5)}%</span>
                  </span>
                )}
                {defGroup.fiveHour && defGroup.weekly && <span className="quota-sep">·</span>}
                {defGroup.weekly && (
                  <span className="quota-seg">
                    <span className="quota-dot" style={{ backgroundColor: getQuotaColor(pw) }} />
                    <span className="quota-win">周</span>
                    <span className="quota-val">{formatCompactPct(pw)}%</span>
                  </span>
                )}

                <div className="telemetry-tooltip quota-popover">
                  <div className="quota-pop-header">Antigravity 模型剩余额度</div>
                  <div className="quota-pop-list">
                    {groups.map((g) => {
                      const m5 = renderQuotaBucketMeta(g.fiveHour);
                      const mw = renderQuotaBucketMeta(g.weekly);
                      return (
                        <div key={g.id} className="quota-pop-group">
                          <div className="quota-pop-title">{g.displayName}</div>
                          {g.modelsSummary && <div className="quota-pop-models">{g.modelsSummary}</div>}
                          {g.fiveHour && (
                            <div className="quota-pop-row">
                              <span className="quota-pop-lbl">5h</span>
                              <div className="quota-pop-track">
                                <div
                                  className="quota-pop-fill"
                                  style={{ width: `${Math.max(0, Math.min(100, g.fiveHour.remainingPercent))}%`, backgroundColor: m5.color }}
                                />
                              </div>
                              <span className="quota-pop-pct" title={m5.usedText}>{m5.pctText}</span>
                              {m5.resetText && <span className="quota-pop-reset">{m5.resetText}</span>}
                            </div>
                          )}
                          {g.weekly && (
                            <div className="quota-pop-row">
                              <span className="quota-pop-lbl">周</span>
                              <div className="quota-pop-track">
                                <div
                                  className="quota-pop-fill"
                                  style={{ width: `${Math.max(0, Math.min(100, g.weekly.remainingPercent))}%`, backgroundColor: mw.color }}
                                />
                              </div>
                              <span className="quota-pop-pct" title={mw.usedText}>{mw.pctText}</span>
                              {mw.resetText && <span className="quota-pop-reset">{mw.resetText}</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {onOpenStats && (
              <button
                type="button"
                className="telemetry-chip stats-trigger-chip"
                data-pet-interactive="true"
                onClick={onOpenStats}
                aria-label="打开模型消耗统计面板"
              >
                <span>📊</span>
                <div className="telemetry-tooltip">模型消耗 &amp; 缓存统计面板</div>
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
};
