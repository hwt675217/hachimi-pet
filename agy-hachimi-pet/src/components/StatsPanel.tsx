import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BarChart3, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import type {
  ModelConvoDetailItem,
  ModelDetailStatsResponse,
  ModelTurnDetailItem,
  QuotaGroup,
  QuotaSummary,
  UsageStatsResponse,
} from '../types';

interface StatsPanelProps {
  open: boolean;
  bridgePort: number;
  quota?: QuotaSummary | null;
  onClose: () => void;
}

type RangePreset = 'today' | '7d' | '30d' | 'all' | 'custom';
type DetailTab = 'turns' | 'conversations';

const PRESET_TABS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: '今日' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: 'all', label: '全部' },
  { id: 'custom', label: '自定义' },
];

const FAMILY_COLORS: Record<string, string> = {
  gemini: '#60a5fa',
  claude: '#f59e0b',
  gpt: '#34d399',
  other: '#94a3b8',
};

function formatCompactTokens(n: number): string {
  const v = Number(n || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function getTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDaysAgoIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatResetShort(resetTime?: string): string {
  if (!resetTime) return '';
  const targetMs = Date.parse(resetTime);
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return '即将重置';
  const totalMins = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h 后重置`;
  if (hours > 0) return `${hours}h ${mins}m 后重置`;
  return `${mins}m 后重置`;
}

function formatDateTime(tsMs: number): string {
  if (!tsMs) return '--';
  const d = new Date(tsMs);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}:${ss}`;
}

function getUsedColor(usedPct: number): string {
  if (usedPct >= 80) return '#fb7185';
  if (usedPct >= 50) return '#f59e0b';
  return '#34d399';
}

function resolveGroupForFamily(family: string, quota?: QuotaSummary | null): QuotaGroup | null {
  const groups = quota?.groups || [];
  if (groups.length === 0) return null;
  if (family === 'gemini') {
    return groups.find((g) => /gemini/i.test(g.displayName)) || null;
  }
  if (family === 'claude' || family === 'gpt') {
    return groups.find((g) => /claude|gpt/i.test(g.displayName)) || null;
  }
  return null;
}

function calcUsedPct(remPct?: number, explicitUsed?: number): number {
  if (typeof explicitUsed === 'number' && Number.isFinite(explicitUsed)) {
    return Math.max(0, Math.min(100, explicitUsed));
  }
  if (typeof remPct === 'number' && Number.isFinite(remPct)) {
    return Math.max(0, Math.min(100, Number((100 - remPct).toFixed(1))));
  }
  return 0;
}

export const StatsPanel: React.FC<StatsPanelProps> = ({ open, bridgePort, quota, onClose }) => {
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [startDate, setStartDate] = useState(() => getDaysAgoIso(6));
  const [endDate, setEndDate] = useState(() => getTodayIso());

  const [stats, setStats] = useState<UsageStatsResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('turns');
  const [detailPage, setDetailPage] = useState(1);
  const [modelDetail, setModelDetail] = useState<ModelDetailStatsResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const loadOverview = useCallback(
    async (nextPreset: RangePreset, sDate: string, eDate: string) => {
      setLoading(true);
      setError('');
      try {
        const qs = new URLSearchParams({ preset: nextPreset });
        if (nextPreset === 'custom') {
          if (sDate) qs.set('start', sDate);
          if (eDate) qs.set('end', eDate);
        }
        const res = await fetch(`http://127.0.0.1:${bridgePort}/api/stats?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as UsageStatsResponse;
        setStats(data);
        setHoverIdx(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取统计失败');
      } finally {
        setLoading(false);
      }
    },
    [bridgePort]
  );

  const loadModelDetail = useCallback(
    async (modelId: string, nextPreset: RangePreset, sDate: string, eDate: string, tab: DetailTab, page: number) => {
      setLoading(true);
      setError('');
      try {
        const qs = new URLSearchParams({
          model: modelId,
          preset: nextPreset,
          tab,
          page: String(page),
          pageSize: '10',
        });
        if (nextPreset === 'custom') {
          if (sDate) qs.set('start', sDate);
          if (eDate) qs.set('end', eDate);
        }
        const res = await fetch(`http://127.0.0.1:${bridgePort}/api/stats/model?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ModelDetailStatsResponse;
        setModelDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取模型详情失败');
      } finally {
        setLoading(false);
      }
    },
    [bridgePort]
  );

  useEffect(() => {
    if (!open) return;
    if (selectedModel) {
      loadModelDetail(selectedModel, preset, startDate, endDate, detailTab, detailPage);
    } else {
      loadOverview(preset, startDate, endDate);
    }
  }, [open, selectedModel, preset, startDate, endDate, detailTab, detailPage, loadOverview, loadModelDetail]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        if (selectedModel) {
          setSelectedModel(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selectedModel, onClose]);

  if (!open) return null;

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    setDetailTab('turns');
    setDetailPage(1);
  };

  const handleRefresh = () => {
    if (selectedModel) {
      loadModelDetail(selectedModel, preset, startDate, endDate, detailTab, detailPage);
    } else {
      loadOverview(preset, startDate, endDate);
    }
  };

  const summary = stats?.summary;
  const buckets = stats?.trend?.buckets || [];
  const maxBucketTok = Math.max(1, ...buckets.map((b) => b.totalTokens));
  const hoveredBucket = hoverIdx !== null && buckets[hoverIdx] ? buckets[hoverIdx] : null;
  const rootPct =
    summary && summary.totalTokens > 0
      ? Math.round((summary.rootTokens / summary.totalTokens) * 100)
      : 100;

  const activeRangeLabel = selectedModel ? modelDetail?.range : stats?.range;
  const detailQuotaGroup = modelDetail ? resolveGroupForFamily(modelDetail.family, quota) : null;

  return (
    <div
      className="stats-panel"
      data-pet-interactive="true"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="stats-header">
        <div className="stats-title-wrap">
          {selectedModel ? (
            <button
              type="button"
              className="stats-back-btn"
              onClick={() => setSelectedModel(null)}
              title="返回统计总览"
            >
              <ArrowLeft size={13} />
              <span>返回总览</span>
            </button>
          ) : (
            <BarChart3 size={16} className="stats-title-icon" />
          )}
          <span className="stats-title">
            {selectedModel ? (modelDetail?.label || selectedModel) : '模型消耗与缓存统计看板'}
          </span>
          {activeRangeLabel?.startDate && (
            <span className="stats-date-span">
              {activeRangeLabel.startDate} ~ {activeRangeLabel.endDate}
            </span>
          )}
        </div>
        <div className="stats-header-actions">
          <button type="button" className="stats-icon-btn" title="刷新数据" onClick={handleRefresh}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" className="stats-icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Time Range Bar */}
      <div className="stats-toolbar">
        <div className="stats-preset-group">
          {PRESET_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`stats-preset-btn ${preset === tab.id ? 'active' : ''}`}
              onClick={() => {
                setPreset(tab.id);
                setDetailPage(1);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="stats-custom-dates">
            <input
              type="date"
              className="stats-date-input"
              value={startDate}
              max={endDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setDetailPage(1);
              }}
            />
            <span className="stats-date-sep">至</span>
            <input
              type="date"
              className="stats-date-input"
              value={endDate}
              min={startDate}
              max={getTodayIso()}
              onChange={(e) => {
                setEndDate(e.target.value);
                setDetailPage(1);
              }}
            />
          </div>
        )}
      </div>

      {error && <div className="stats-error">读取失败：{error}</div>}

      <div className="stats-scroll-body">
        {selectedModel ? (
          /* ================= SINGLE MODEL PAGINATED DETAIL VIEW ================= */
          <>
            {detailQuotaGroup && (
              <div className="stats-weekly-strip">
                <div className="stats-weekly-strip-left">
                  <span
                    className="stats-model-dot"
                    style={{ background: FAMILY_COLORS[modelDetail?.family || 'other'] }}
                  />
                  <span>所属额度池：{detailQuotaGroup.displayName}</span>
                </div>
                <div className="stats-weekly-strip-right">
                  {detailQuotaGroup.fiveHour && (
                    <span>
                      5h 已消耗{' '}
                      <strong style={{ color: getUsedColor(calcUsedPct(detailQuotaGroup.fiveHour.remainingPercent, detailQuotaGroup.fiveHour.usedPercent)) }}>
                        {calcUsedPct(detailQuotaGroup.fiveHour.remainingPercent, detailQuotaGroup.fiveHour.usedPercent).toFixed(1)}%
                      </strong>{' '}
                      (余 {Number(detailQuotaGroup.fiveHour.remainingPercent ?? 100).toFixed(1)}%)
                    </span>
                  )}
                  {detailQuotaGroup.weekly && (
                    <span>
                      周额度已消耗{' '}
                      <strong style={{ color: getUsedColor(calcUsedPct(detailQuotaGroup.weekly.remainingPercent, detailQuotaGroup.weekly.usedPercent)) }}>
                        {calcUsedPct(detailQuotaGroup.weekly.remainingPercent, detailQuotaGroup.weekly.usedPercent).toFixed(1)}%
                      </strong>{' '}
                      (余 {Number(detailQuotaGroup.weekly.remainingPercent ?? 100).toFixed(1)}% ·{' '}
                      {formatResetShort(detailQuotaGroup.weekly.resetTime)})
                    </span>
                  )}
                </div>
              </div>
            )}

            {modelDetail && (
              <div className="stats-kpi-grid">
                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">模型总消耗</div>
                  <div className="stats-kpi-val" title={modelDetail.summary.totalTokens.toLocaleString('en-US')}>
                    {formatCompactTokens(modelDetail.summary.totalTokens)}
                  </div>
                  <div className="stats-kpi-sub">
                    均轮 {formatCompactTokens(modelDetail.summary.avgTokensPerTurn)}
                  </div>
                </div>
                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">缓存命中率</div>
                  <div
                    className="stats-kpi-val"
                    style={{
                      color:
                        modelDetail.summary.cacheHitRate >= 70
                          ? '#34d399'
                          : modelDetail.summary.cacheHitRate >= 40
                          ? '#f59e0b'
                          : '#fda4af',
                    }}
                  >
                    {modelDetail.summary.cacheHitRate.toFixed(1)}%
                  </div>
                  <div className="stats-kpi-sub">
                    命中 {formatCompactTokens(modelDetail.summary.cacheReadTokens)}
                  </div>
                </div>
                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">新输入 / 输出</div>
                  <div className="stats-kpi-val stats-kpi-split">
                    <span>{formatCompactTokens(modelDetail.summary.inputTokens)}</span>
                    <span className="stats-split-slash">/</span>
                    <span>{formatCompactTokens(modelDetail.summary.outputTokens)}</span>
                  </div>
                  <div className="stats-kpi-sub">
                    主 {modelDetail.summary.rootTurns} 轮 · 子代理 {modelDetail.summary.subagentTurns} 轮
                  </div>
                </div>
                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">关联会话与工具</div>
                  <div className="stats-kpi-val">{modelDetail.summary.conversations} 会话</div>
                  <div className="stats-kpi-sub">
                    {modelDetail.summary.turns} 轮 · {modelDetail.summary.toolCalls} 次工具
                  </div>
                </div>
              </div>
            )}

            {modelDetail && modelDetail.topTools.length > 0 && (
              <div className="stats-model-tools-bar">
                <span className="stats-mt-lbl">高频工具：</span>
                {modelDetail.topTools.map((t) => (
                  <span key={t.name} className="stats-mt-chip">
                    {t.name} <b>{t.count}</b>
                  </span>
                ))}
              </div>
            )}

            {/* Paginated Detail Tabs */}
            {modelDetail && (
              <div className="stats-section">
                <div className="stats-section-head">
                  <div className="stats-detail-tabs">
                    <button
                      type="button"
                      className={`stats-dtab ${detailTab === 'turns' ? 'active' : ''}`}
                      onClick={() => {
                        setDetailTab('turns');
                        setDetailPage(1);
                      }}
                    >
                      调用明细 ({modelDetail.pagination.turnsTotal})
                    </button>
                    <button
                      type="button"
                      className={`stats-dtab ${detailTab === 'conversations' ? 'active' : ''}`}
                      onClick={() => {
                        setDetailTab('conversations');
                        setDetailPage(1);
                      }}
                    >
                      按对话汇总 ({modelDetail.pagination.conversationsTotal})
                    </button>
                  </div>
                  <span className="stats-page-meta">每页 {modelDetail.pagination.pageSize} 条</span>
                </div>

                {modelDetail.items.length === 0 ? (
                  <div className="stats-empty">选定时间范围内该模型暂无明细记录</div>
                ) : detailTab === 'turns' ? (
                  <div className="stats-table-wrap">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>所属对话</th>
                          <th className="num">总消耗</th>
                          <th className="num">缓存率</th>
                          <th className="num">新输入 / 缓存 / 输出</th>
                          <th>工具</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(modelDetail.items as ModelTurnDetailItem[]).map((it, i) => (
                          <tr key={`${it.conversationId}-${it.tsMs}-${i}`}>
                            <td className="muted nowrap">{formatDateTime(it.tsMs)}</td>
                            <td>
                              <span className="stats-det-title" title={it.title}>
                                {it.isSubagent ? '🤖 ' : ''}
                                {it.title}
                              </span>
                            </td>
                            <td className="num strong">{formatCompactTokens(it.totalTokens)}</td>
                            <td
                              className="num"
                              style={{
                                color:
                                  it.cacheHitRate >= 70
                                    ? '#34d399'
                                    : it.cacheHitRate >= 40
                                    ? '#f59e0b'
                                    : '#fda4af',
                              }}
                            >
                              {it.cacheHitRate.toFixed(1)}%
                            </td>
                            <td className="num muted">
                              {formatCompactTokens(it.inputTokens)} / {formatCompactTokens(it.cacheReadTokens)}{' '}
                              / {formatCompactTokens(it.outputTokens)}
                            </td>
                            <td className="muted">
                              <span className="stats-det-tools" title={it.tools.join(', ')}>
                                {it.tools.length > 0 ? it.tools.join(', ') : '—'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="stats-table-wrap">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>对话标题</th>
                          <th className="num">轮次</th>
                          <th className="num">总消耗</th>
                          <th className="num">缓存率</th>
                          <th className="num">新输入 / 缓存 / 输出</th>
                          <th className="num">工具</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(modelDetail.items as ModelConvoDetailItem[]).map((c) => (
                          <tr key={c.conversationId}>
                            <td>
                              <span className="stats-det-title" title={c.title}>
                                {c.isSubagent ? '🤖 ' : ''}
                                {c.title}
                              </span>
                            </td>
                            <td className="num">{c.turns}</td>
                            <td className="num strong">{formatCompactTokens(c.totalTokens)}</td>
                            <td
                              className="num"
                              style={{
                                color:
                                  c.cacheHitRate >= 70
                                    ? '#34d399'
                                    : c.cacheHitRate >= 40
                                    ? '#f59e0b'
                                    : '#fda4af',
                              }}
                            >
                              {c.cacheHitRate.toFixed(1)}%
                            </td>
                            <td className="num muted">
                              {formatCompactTokens(c.inputTokens)} / {formatCompactTokens(c.cacheReadTokens)}{' '}
                              / {formatCompactTokens(c.outputTokens)}
                            </td>
                            <td className="num">{c.toolCalls}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination Controls */}
                <div className="stats-pagination">
                  <span className="stats-page-info">
                    共 {modelDetail.pagination.totalItems} 条 · 第 {modelDetail.pagination.page} /{' '}
                    {modelDetail.pagination.totalPages} 页
                  </span>
                  <div className="stats-page-btns">
                    <button
                      type="button"
                      className="stats-page-btn"
                      disabled={modelDetail.pagination.page <= 1}
                      onClick={() => setDetailPage(1)}
                    >
                      首页
                    </button>
                    <button
                      type="button"
                      className="stats-page-btn"
                      disabled={modelDetail.pagination.page <= 1}
                      onClick={() => setDetailPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft size={12} /> 上一页
                    </button>
                    <button
                      type="button"
                      className="stats-page-btn"
                      disabled={modelDetail.pagination.page >= modelDetail.pagination.totalPages}
                      onClick={() =>
                        setDetailPage((p) => Math.min(modelDetail.pagination.totalPages, p + 1))
                      }
                    >
                      下一页 <ChevronRight size={12} />
                    </button>
                    <button
                      type="button"
                      className="stats-page-btn"
                      disabled={modelDetail.pagination.page >= modelDetail.pagination.totalPages}
                      onClick={() => setDetailPage(modelDetail.pagination.totalPages)}
                    >
                      末页
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          /* ================= OVERVIEW DASHBOARD VIEW ================= */
          <>
            {/* KPI Row */}
            {summary && (
              <div className="stats-kpi-grid">
                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">总 Token 消耗</div>
                  <div className="stats-kpi-val" title={summary.totalTokens.toLocaleString('en-US')}>
                    {formatCompactTokens(summary.totalTokens)}
                  </div>
                  <div className="stats-kpi-sub">
                    均轮 {formatCompactTokens(summary.avgTokensPerTurn)}
                  </div>
                </div>

                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">缓存命中率</div>
                  <div
                    className="stats-kpi-val"
                    style={{
                      color:
                        summary.cacheHitRate >= 70
                          ? '#34d399'
                          : summary.cacheHitRate >= 40
                          ? '#f59e0b'
                          : '#fda4af',
                    }}
                  >
                    {summary.cacheHitRate.toFixed(1)}%
                  </div>
                  <div className="stats-kpi-sub">
                    命中 {formatCompactTokens(summary.cacheReadTokens)}
                  </div>
                </div>

                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">新输入 / 输出</div>
                  <div className="stats-kpi-val stats-kpi-split">
                    <span>{formatCompactTokens(summary.inputTokens)}</span>
                    <span className="stats-split-slash">/</span>
                    <span>{formatCompactTokens(summary.outputTokens)}</span>
                  </div>
                  <div className="stats-kpi-sub">
                    输出占比{' '}
                    {summary.totalTokens > 0
                      ? ((summary.outputTokens / summary.totalTokens) * 100).toFixed(1)
                      : '0.0'}
                    %
                  </div>
                </div>

                <div className="stats-kpi-card">
                  <div className="stats-kpi-label">调用与对话数</div>
                  <div className="stats-kpi-val">
                    {summary.turns.toLocaleString('en-US')} 轮
                  </div>
                  <div className="stats-kpi-sub">
                    {summary.conversations} 会话 · {summary.toolCalls.toLocaleString('en-US')} 工具
                  </div>
                </div>
              </div>
            )}

            {/* Weekly Quota Consumption Percentage Cards */}
            {quota?.groups && quota.groups.length > 0 && (
              <div className="stats-quota-grid">
                {quota.groups.map((g) => {
                  const weekUsed = calcUsedPct(g.weekly?.remainingPercent, g.weekly?.usedPercent);
                  const weekRem = g.weekly ? Number(g.weekly.remainingPercent ?? 100) : 100;
                  const h5Used = calcUsedPct(g.fiveHour?.remainingPercent, g.fiveHour?.usedPercent);
                  const usedClr = getUsedColor(weekUsed);
                  return (
                    <div key={g.id} className="stats-quota-card">
                      <div className="stats-quota-card-top">
                        <span className="stats-quota-card-title">{g.displayName}</span>
                        <span className="stats-quota-card-used" style={{ color: usedClr }}>
                          周已消耗 {weekUsed.toFixed(1)}%
                        </span>
                      </div>
                      <div className="stats-quota-bar-track">
                        <div
                          className="stats-quota-bar-fill"
                          style={{ width: `${Math.max(2, weekUsed)}%`, background: usedClr }}
                        />
                      </div>
                      <div className="stats-quota-card-foot">
                        <span>
                          周余 {weekRem.toFixed(1)}% · 5h 已耗 {h5Used.toFixed(1)}%
                        </span>
                        <span>{formatResetShort(g.weekly?.resetTime)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Root vs Subagent Ratio Strip */}
            {summary && summary.totalTokens > 0 && (
              <div className="stats-ratio-card">
                <div className="stats-ratio-head">
                  <span>
                    主对话 {rootPct}% ({formatCompactTokens(summary.rootTokens)}) · 子代理 / Swarm{' '}
                    {100 - rootPct}% ({formatCompactTokens(summary.subagentTokens)})
                  </span>
                </div>
                <div className="stats-ratio-bar">
                  <div className="stats-ratio-root" style={{ width: `${rootPct}%` }} />
                  <div className="stats-ratio-sub" style={{ width: `${100 - rootPct}%` }} />
                </div>
              </div>
            )}

            {/* Stacked Trend Chart */}
            <div className="stats-section">
              <div className="stats-section-head">
                <span>
                  {stats?.trend.granularity === 'hour' ? '24 小时消耗趋势' : '每日 Token 消耗趋势'}
                </span>
                <span className="stats-legend">
                  <i style={{ background: '#34d399' }} /> 缓存命中
                  <i style={{ background: '#60a5fa' }} /> 新输入
                  <i style={{ background: '#a78bfa' }} /> 输出
                  {hoveredBucket && (
                    <span className="stats-hover-readout">
                      {hoveredBucket.label} · {formatCompactTokens(hoveredBucket.totalTokens)} (缓存{' '}
                      {hoveredBucket.cacheHitRate}%)
                    </span>
                  )}
                </span>
              </div>
              {buckets.length === 0 ? (
                <div className="stats-empty">选定时间范围内暂无 Token 消耗记录</div>
              ) : (
                <div className="stats-chart">
                  {buckets.map((b, idx) => {
                    const hTotalPct = (b.totalTokens / maxBucketTok) * 100;
                    const cachePct = b.totalTokens > 0 ? (b.cacheReadTokens / b.totalTokens) * 100 : 0;
                    const inPct = b.totalTokens > 0 ? (b.inputTokens / b.totalTokens) * 100 : 0;
                    const outPct = Math.max(0, 100 - cachePct - inPct);
                    const showTick =
                      buckets.length <= 12 ||
                      idx === 0 ||
                      idx === buckets.length - 1 ||
                      idx % Math.ceil(buckets.length / 7) === 0;
                    return (
                      <div
                        key={b.key}
                        className={`stats-bar-col ${hoverIdx === idx ? 'hovered' : ''}`}
                        onMouseEnter={() => setHoverIdx(idx)}
                        onMouseLeave={() => setHoverIdx(null)}
                        title={`${b.label}: 总 ${b.totalTokens.toLocaleString('en-US')} (缓存 ${b.cacheHitRate}% · ${b.turns} 轮)`}
                      >
                        <div className="stats-bar-slot">
                          {b.totalTokens > 0 && (
                            <div
                              className="stats-bar-stack"
                              style={{ height: `${Math.max(4, hTotalPct)}%` }}
                            >
                              <div className="seg-out" style={{ height: `${outPct}%` }} />
                              <div className="seg-in" style={{ height: `${inPct}%` }} />
                              <div className="seg-cache" style={{ height: `${cachePct}%` }} />
                            </div>
                          )}
                        </div>
                        <div className="stats-bar-lbl">{showTick ? b.label.slice(0, 5) : ''}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Model Breakdown Table (Clickable for Paginated Detail View) */}
            <div className="stats-section">
              <div className="stats-section-head">
                <span>各模型消耗与缓存率明细 ({stats?.byModel.length || 0})</span>
                <span className="stats-hint-muted">点击任意模型查看分页明细 ›</span>
              </div>
              {!stats || stats.byModel.length === 0 ? (
                <div className="stats-empty">暂无模型分项记录</div>
              ) : (
                <div className="stats-table-wrap">
                  <table className="stats-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th className="num">轮次</th>
                        <th className="num">总消耗</th>
                        <th className="num">缓存率</th>
                        <th className="num">组周额度消耗</th>
                        <th className="num">新输入 / 缓存 / 输出</th>
                        <th className="num"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byModel.map((m) => {
                        const grp = resolveGroupForFamily(m.family, quota);
                        const weekUsed = grp?.weekly
                          ? calcUsedPct(grp.weekly.remainingPercent, grp.weekly.usedPercent)
                          : null;
                        return (
                          <tr
                            key={m.model}
                            className="stats-clickable-row"
                            onClick={() => handleSelectModel(m.model)}
                            title={`点击查看 ${m.label} 分页调用明细`}
                          >
                            <td>
                              <div className="stats-model-cell">
                                <span
                                  className="stats-model-dot"
                                  style={{ background: FAMILY_COLORS[m.family] || '#94a3b8' }}
                                />
                                <span className="stats-model-name" title={m.model}>
                                  {m.label}
                                </span>
                                <span className="stats-model-share">{m.sharePercent}%</span>
                              </div>
                              <div className="stats-model-bar">
                                <div
                                  style={{
                                    width: `${Math.max(2, m.sharePercent)}%`,
                                    background: FAMILY_COLORS[m.family] || '#94a3b8',
                                  }}
                                />
                              </div>
                            </td>
                            <td className="num">{m.turns.toLocaleString('en-US')}</td>
                            <td className="num strong">{formatCompactTokens(m.totalTokens)}</td>
                            <td
                              className="num"
                              style={{
                                color:
                                  m.cacheHitRate >= 70
                                    ? '#34d399'
                                    : m.cacheHitRate >= 40
                                    ? '#f59e0b'
                                    : '#fda4af',
                              }}
                            >
                              {m.cacheHitRate.toFixed(1)}%
                            </td>
                            <td className="num">
                              {weekUsed !== null ? (
                                <span
                                  className="stats-week-badge"
                                  style={{ color: getUsedColor(weekUsed) }}
                                  title={`${grp?.displayName} 周额度已消耗 ${weekUsed.toFixed(1)}%`}
                                >
                                  已耗 {weekUsed.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td className="num muted">
                              {formatCompactTokens(m.inputTokens)} /{' '}
                              {formatCompactTokens(m.cacheReadTokens)} /{' '}
                              {formatCompactTokens(m.outputTokens)}
                            </td>
                            <td className="num stats-row-arrow">
                              <ChevronRight size={13} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Bottom 2-Column Insights: Top Tools & Top Conversations */}
            {stats && (stats.topTools.length > 0 || stats.topConversations.length > 0) && (
              <div className="stats-bottom-grid">
                <div className="stats-section">
                  <div className="stats-section-head">
                    <span>高频工具 Top {stats.topTools.length}</span>
                  </div>
                  <div className="stats-mini-list">
                    {stats.topTools.map((t) => (
                      <div key={t.name} className="stats-tool-row">
                        <span className="stats-tool-name">{t.name}</span>
                        <div className="stats-tool-track">
                          <div style={{ width: `${Math.max(4, t.sharePercent)}%` }} />
                        </div>
                        <span className="stats-tool-cnt">{t.count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="stats-section">
                  <div className="stats-section-head">
                    <span>消耗最高对话 Top {stats.topConversations.length}</span>
                  </div>
                  <div className="stats-mini-list">
                    {stats.topConversations.map((c) => (
                      <div key={c.conversationId} className="stats-convo-row" title={c.title}>
                        <div className="stats-convo-top">
                          <span className="stats-convo-title">
                            {c.isSubagent ? '🤖 ' : ''}
                            {c.title}
                          </span>
                          <span className="stats-convo-tok">{formatCompactTokens(c.totalTokens)}</span>
                        </div>
                        <div className="stats-convo-sub">
                          <span>{c.primaryModel}</span>
                          <span>
                            {c.turns} 轮 · 缓存 {c.cacheHitRate}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
