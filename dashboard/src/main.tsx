import React from 'react';
import { createRoot } from 'react-dom/client';
import { HubConnectionBuilder } from '@microsoft/signalr';
import { buildWaterfall, describeQuotaProvenance, findSpanForEvent, isErrorStatus, type Waterfall } from './trace';
import { BenchmarksPage } from './benchmarks-page';
import { budgetAmountText, budgetMetricLabel, budgetPanelSummary } from './budgets';
import { buildScatterPlot, computeModelHighlights, filterModelsByMinCalls, layoutScatterLabels, type CostAxisMetric, type ModelBreakdownItem, type ValueAxisMetric } from './model-efficiency';
import { classifySessionHierarchy, flattenSessionTree, summarizeDelegation, type ModelRoleItem, type ParentSessionSummary, type RoleBreakdownItem, type SubagentSummary } from './orchestration';
import { formatClock, formatCompact, formatDate, formatMoney, formatNumber, LanguageProvider, statusLabel, translateError, translateSignal, useLanguage, type Language, type Translate, type TranslationKey } from './i18n';
import './style.css';

type Session = { id: string; source: string; project?: string; title?: string; status: string; model?: string; agent?: string | null; parentSessionId?: string | null; subagentCount?: number; startedAt: string; endedAt?: string; spanCount: number; errorCount: number; inputTokens: number | null; outputTokens: number | null };
type Span = { id: string; parentId?: string | null; name: string; kind: string; agent?: string | null; status: string; startedAt: string; durationMs?: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cost?: number | null; quotaCostEstimate?: number | null; quotaCatalogFetchedAt?: string | null; quotaRateSnapshot?: string | null; quotaMissingReason?: string | null; attributesJson: string };
type SessionEvent = { id: number; eventId: string; source: string; sessionId: string; timestamp: string; type: string; status?: string | null; attributesJson: string };
type SessionDetailSession = { id: string; source: string; project?: string | null; title?: string | null; status: string; model?: string | null; agent?: string | null; parentSessionId?: string | null; startedAt: string; endedAt?: string | null; updatedAt: string; rating?: number | null; reviewNote?: string | null; reviewTask?: string | null };
type SessionMetrics = { spanCount: number; errorCount: number; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cost: number | null; quotaCostEstimate: number | null; durationMs: number | null };
type TraceQuality = { status: 'complete' | 'partial'; hasSessionCreated: boolean; orphanToolSpans: number; missingDurationSpans: number; missingTokenSpans: number; unknownModelSpans: number; unrelatedEventCount: number; sourceConflictEvents?: number };
type SessionDetail = { session: SessionDetailSession; parentSession?: ParentSessionSummary | null; subagents?: SubagentSummary[]; roleBreakdown?: RoleBreakdownItem[]; spans: Span[]; events: SessionEvent[]; unrelatedEvents?: SessionEvent[]; quality?: TraceQuality; metrics: SessionMetrics };
type SpanReveal = { spanId: string; nonce: number };
type ErrorFocus = { sessionId: string; nonce: number };
type Budget = { project: string; monthlyLimit: number; metric: 'cost' | 'quota'; spent: number | null; periodStart: string; percentage: number | null; totalSpans?: number; measuredSpans?: number; isPartial?: boolean };
type SystemVersion = { apiVersion: string; protocolVersion: number; schemaVersion: number; latestSchemaVersion: number; benchmarkWorker: string };
type ComparisonRun = { id: string; title?: string; project?: string; model?: string; status: string; rating?: number | null; note?: string; taskLabel: string; updatedAt: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; cost?: number | null; quotaCostEstimate?: number | null; tools: string[] };
type ComparisonGroup = { taskLabel: string; sessions: ComparisonRun[] };
type ToolSession = { sessionId: string; title?: string; project?: string; model?: string };
type ToolMetric = { name: string; callCount: number; errorCount: number; errorRate: number; sessionCount: number; averageDurationMs?: number | null; latestSessions: ToolSession[] };
type ToolAnalytics = { windowDays?: number | null; totalCalls: number; errorCount: number; tools: ToolMetric[] };
type ModelAnalytics = { bucket: 'day' | 'week' | 'month'; availableSources: string[]; availableModels: string[]; totals: { calls: number; totalTokens: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null; cacheEfficiency?: number | null; reportedCost?: number | null; quotaEstimate?: number | null; errorCount: number }; trend: Array<{ period: string; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null }>; agents: Array<{ name: string; calls: number; tokens: number | null; share: number | null }>; models: ModelBreakdownItem[]; roles?: ModelRoleItem[] };
type BehaviorSignal = { kind: string; severity: 'alert' | 'warning'; title: string; explanation: string; evidence: Record<string, unknown> };
type BehaviorSession = { id: string; title?: string; project?: string; model?: string; status: string; startedAt: string; updatedAt: string; signals: BehaviorSignal[] };
type BehaviorReport = { windowDays?: number | null; totals: { sessions: number; flaggedSessions: number; signals: number }; sessions: BehaviorSession[] };
type OverviewTotals = { sessions: number; active: number; completed: number; error: number; interrupted: number; finished: number; successRate: number | null; errorRate: number | null; averageDurationMs: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null; reportedCost: number | null; quotaEstimate: number | null };
type ScopeFilter = 'all' | 'real' | 'benchmarks';
type OverviewTool = { name: string; calls: number; errors: number; errorRate: number; sessions: number };
type OverviewModel = { name: string; calls: number; totalTokens: number | null; reportedCost: number | null; quotaEstimate: number | null; errors: number };
type OverviewSession = { id: string; title?: string; project?: string; model?: string; status: string; startedAt: string; updatedAt: string };
type OverviewReport = { windowDays?: number | null; totals: OverviewTotals; topTools: OverviewTool[]; topModels: OverviewModel[]; recentSessions: OverviewSession[] };
type Listing = { items: Session[]; total: number; page: number; pageSize: number };
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };
/** Error de una carga: la clave que lo explica en el idioma activo y el `code` estable de la API cuando vino. */
type RequestError = { key: TranslationKey; code?: string };
/** Mensaje transitorio de una acción: la clave y sus parámetros, resueltos al renderizar para seguir el idioma. */
type Message = { key: TranslationKey; params?: Record<string, string | number> };
/** El `code` de la API manda; sin code conocido se muestra la clave local, siempre en el idioma activo. */
const errorText = (t: Translate, error: RequestError) => translateError(t, error.code, t(error.key));
const time = (value: string | undefined, language: Language) => value ? formatDate(language, value) : '—';
const duration = (milliseconds: number, t: Translate, language: Language) => milliseconds < 60_000
  ? t('duration.seconds', { value: formatNumber(language, milliseconds / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
  : t('duration.minutesSeconds', {
    minutes: formatNumber(language, Math.floor(milliseconds / 60_000), { maximumFractionDigits: 0 }),
    seconds: formatNumber(language, Math.floor(milliseconds % 60_000 / 1000), { maximumFractionDigits: 0 }),
  });
const money = (value: number | null | undefined, t: Translate, language: Language) => value == null ? t('common.noData') : formatMoney(language, value);
const safeAttributes = (value: string) => { try { return Object.entries(JSON.parse(value) as Record<string, string>); } catch { return []; } };
const compactNumber = (value: number, language: Language) => formatCompact(language, value);
const clock = (value: string | undefined, language: Language) => value ? formatClock(language, value) : '—';
const spanDuration = (value: number | null | undefined, t: Translate, language: Language) => value == null ? t('common.noData') : value < 1000 ? t('duration.milliseconds', { value: formatNumber(language, Math.round(value), { maximumFractionDigits: 0 }) }) : duration(value, t, language);
const kindLabel = (kind: string, t: Translate) => kind === 'inference' ? t('kind.inference') : kind === 'execute_tool' ? t('kind.executeTool') : kind;
const tokenText = (value: number | null | undefined, t: Translate, language: Language) => value == null ? t('common.noData') : formatNumber(language, value);
const tokenCompact = (value: number | null | undefined, t: Translate, language: Language) => value == null ? t('common.noData') : compactNumber(value, language);
const tokenSum = (...values: Array<number | null | undefined>) => values.every(value => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
const qualitySummary = (quality: TraceQuality, t: Translate, language: Language) => {
  const gaps: string[] = [];
  const count = (value: number) => ({ count: value, value: formatNumber(language, value) });
  if (!quality.hasSessionCreated) gaps.push(t('quality.missingStart'));
  if (quality.orphanToolSpans > 0) gaps.push(t('quality.orphanTools', count(quality.orphanToolSpans)));
  if (quality.missingDurationSpans > 0) gaps.push(t('quality.missingDuration', count(quality.missingDurationSpans)));
  if (quality.missingTokenSpans > 0) gaps.push(t('quality.missingTokens', count(quality.missingTokenSpans)));
  if (quality.unknownModelSpans > 0) gaps.push(t('quality.unknownModel', count(quality.unknownModelSpans)));
  if ((quality.sourceConflictEvents ?? 0) > 0) gaps.push(t('quality.sourceConflicts', count(quality.sourceConflictEvents ?? 0)));
  return gaps.join(t('common.listSeparator'));
};

/** Lee el `code` estable del cuerpo de error; sin JSON o sin código queda indefinido. */
async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    // La respuesta no trae JSON; el cliente muestra su propio mensaje.
    return undefined;
  }
}

type SectionIcon = 'overview' | 'monitoring' | 'tools' | 'models' | 'behavior' | 'compare';
function SectionHeader({ icon, eyebrow, title, description, actions }: { icon: SectionIcon; eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="model-analytics-header section-header"><div className="analytics-title"><span className="analytics-icon"><svg viewBox="0 0 24 24" aria-hidden="true">{icon === 'overview' ? <><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></> : icon === 'monitoring' ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></> : icon === 'tools' ? <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z"/> : icon === 'models' ? <><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/><path d="M2 19h21"/></> : icon === 'behavior' ? <path d="M3 12h4l2-7 4 14 2-7h6"/> : <><path d="M4 7h15l-3-3M20 17H5l3 3"/><path d="m16 4 3 3-3 3M8 14l-3 3 3 3"/></>}</svg></span><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div></div>{actions && <div className="section-header-actions">{actions}</div>}</div>;
}

function ScopeSelect({ scope, setScope }: { scope: ScopeFilter; setScope: (value: ScopeFilter) => void }) {
  const { t } = useLanguage();
  return <select className="scope-select" aria-label={t('scope.label')} value={scope} onChange={event => setScope(event.target.value as ScopeFilter)}><option value="all">{t('scope.all')}</option><option value="real">{t('scope.real')}</option><option value="benchmarks">{t('scope.benchmarks')}</option></select>;
}

function ModelAnalyticsPage(props: {
  data: ModelAnalytics | null; error: RequestError | null; bucket: 'day' | 'week' | 'month'; setBucket: (value: 'day' | 'week' | 'month') => void;
  from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void;
  source: string; setSource: (value: string) => void; model: string; setModel: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void; onRefresh: () => void;
}) {
  const { data, error, bucket, setBucket, from, to, setFrom, setTo, source, setSource, model, setModel, scope, setScope, onRefresh } = props;
  const { language, t } = useLanguage();
  const [subView, setSubView] = React.useState<'consumption' | 'efficiency'>('consumption');
  const [costAxis, setCostAxis] = React.useState<CostAxisMetric>('quotaPerCall');
  const [valueAxis, setValueAxis] = React.useState<ValueAxisMetric>('speed');
  const [minCalls, setMinCalls] = React.useState<number>(10);
  const [hoveredModel, setHoveredModel] = React.useState<string | null>(null);
  const scatterColors = ['#72a7ff', '#66d3a4', '#f0b65c', '#bd8cff', '#ff7e82', '#4fd1c5', '#f6ad55', '#fc8181', '#a3bffa', '#9ae6b4'];
  const decimals = (value: number, digits: number) => formatNumber(language, value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pct = (value?: number | null) => value == null ? t('common.noData') : t('models.metric.percent', { value: decimals(value * 100, 1) });
  const speedText = (value?: number | null) => value == null ? t('common.noData') : t('models.metric.tokensPerSecond', { value: decimals(value, 1) });
  const max = Math.max(1, ...(data?.trend.map(point => point.totalTokens ?? 0) ?? []));
  const points = (select: (point: ModelAnalytics['trend'][number]) => number | null) => (data?.trend ?? []).map((point, index) => {
    const x = 42 + index * (716 / Math.max(1, (data?.trend.length ?? 1) - 1));
    const y = 194 - (select(point) ?? 0) / max * 164;
    return `${x},${y}`;
  }).join(' ');
  const agentColors = ['#72a7ff', '#66d3a4', '#f0b65c', '#bd8cff', '#ff7e82'];
  let offset = 0;
  const slices = (data?.agents ?? []).map((agent, index) => {
    const start = offset; offset += (agent.share ?? 0) * 100;
    return `${agentColors[index % agentColors.length]} ${start}% ${offset}%`;
  });
  const donutStyle = { background: slices.length ? `conic-gradient(${slices.join(', ')})` : '#252b33' };
  const toggle = (current: string, next: string, set: (value: string) => void) => set(current === next ? '' : next);
  const efficiencyModels = React.useMemo(() => filterModelsByMinCalls(data?.models ?? [], minCalls), [data, minCalls]);
  const hiddenByMinCalls = (data?.models.length ?? 0) - efficiencyModels.length;
  const highlights = React.useMemo(() => computeModelHighlights(efficiencyModels, t, language), [efficiencyModels, t, language]);
  const scatter = React.useMemo(() => buildScatterPlot(efficiencyModels, costAxis, valueAxis), [efficiencyModels, costAxis, valueAxis]);
  const scatterLabels = React.useMemo(() => layoutScatterLabels(scatter.points), [scatter]);
  const formatXValue = (value: number) => costAxis === 'tokensPerCall' ? t('models.axis.tokens', { value: formatNumber(language, Math.round(value)) }) : costAxis === 'quotaPer1M' ? t('models.metric.usd', { value: decimals(value, 2) }) : t('models.metric.usd', { value: decimals(value, 4) });
  const formatYValue = (value: number) => valueAxis === 'speed' ? t('models.metric.tokensPerSecond', { value: decimals(value, 1) }) : valueAxis === 'latency' ? t('models.metric.seconds', { value: decimals(value, 1) }) : valueAxis === 'benchmarkJudge' ? t('models.metric.judgeScale', { value: decimals(value, 1) }) : t('models.metric.percent', { value: decimals(value, 0) });
  const bucketPeriod = t(bucket === 'day' ? 'models.bucket.daily' : bucket === 'week' ? 'models.bucket.weekly' : 'models.bucket.monthly');
  return <section className="model-analytics-page">
    <SectionHeader icon="models" eyebrow={t('models.eyebrow')} title={t('models.title')} description={t('models.description')} actions={<><div className="subview-switch" role="tablist" aria-label={t('models.subview.label')}><button type="button" role="tab" aria-selected={subView === 'consumption'} className={subView === 'consumption' ? 'active' : ''} onClick={() => setSubView('consumption')}>{t('models.subview.consumption')}</button><button type="button" role="tab" aria-selected={subView === 'efficiency'} className={subView === 'efficiency' ? 'active' : ''} onClick={() => setSubView('efficiency')}>{t('models.subview.efficiency')}</button></div><button className="rates-label" title={t('models.rates.title')}>{t('models.rates.label')}</button></>} />
    <div className="model-filter-bar"><label className="date-control">{t('models.filter.from')}<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="date-control">{t('models.filter.to')}<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><ScopeSelect scope={scope} setScope={setScope} /><button className="refresh-analytics" onClick={onRefresh}>{t('common.refresh')}</button></div>
    {data && <><div className="chip-filter-row"><span>{t('models.filter.sources')}</span><button className={!source ? 'selected' : ''} onClick={() => setSource('')}>{t('common.all')}</button>{data.availableSources.map((item, index) => <button className={source === item ? 'selected' : ''} key={item} onClick={() => toggle(source, item, setSource)}>{item}<i style={{ background: agentColors[index % agentColors.length] }} /></button>)}</div><div className="chip-filter-row models-filter"><span>{t('models.filter.models')}</span><button className={!model ? 'selected' : ''} onClick={() => setModel('')}>{t('common.all')}</button>{data.availableModels.map(item => <button className={model === item ? 'selected' : ''} key={item} title={item} onClick={() => toggle(model, item, setModel)}>{item}</button>)}</div></>}
    {error && <div className="api-error">{errorText(t, error)}</div>}
    {!data ? <div className="empty comparison-empty">{t('models.loading')}</div> : subView === 'consumption' ? <>
      <div className="analytics-section-label">{t('models.totals.label')}</div><div className="model-total-grid"><article className="model-total-card total-primary"><span>{t('models.totals.tokens')}</span><b>{tokenText(data.totals.totalTokens, t, language)}</b><small>{t('models.totals.calls', { count: data.totals.calls, value: formatNumber(language, data.totals.calls) })}</small></article><article className="model-total-card"><span>{t('models.totals.input')}</span><b>{tokenCompact(data.totals.inputTokens, t, language)}</b><small>{data.totals.totalTokens && data.totals.inputTokens != null ? t('models.totals.inputNote', { percent: decimals(data.totals.inputTokens / data.totals.totalTokens * 100, 1) }) : t('models.totals.inputEmpty')}</small></article><article className="model-total-card total-output"><span>{t('models.totals.output')}</span><b>{tokenCompact(data.totals.outputTokens, t, language)}</b><small>{data.totals.totalTokens && data.totals.outputTokens != null ? t('models.totals.outputNote', { percent: decimals(data.totals.outputTokens / data.totals.totalTokens * 100, 1), reasoning: tokenText(data.totals.reasoningTokens, t, language) }) : t('models.totals.outputNoteNoPercent', { reasoning: tokenText(data.totals.reasoningTokens, t, language) })}</small></article><article className="model-total-card total-cache"><span>{t('models.totals.cache')}</span><b>{data.totals.cacheEfficiency == null ? t('common.noData') : t('models.metric.percent', { value: decimals(data.totals.cacheEfficiency * 100, 1) })}</b><small>{t('models.totals.cacheNote', { read: tokenCompact(data.totals.cacheReadTokens, t, language), write: tokenCompact(data.totals.cacheWriteTokens, t, language) })}</small></article></div>
      <div className="model-cost-row"><span>{t('models.totals.reportedCost')} <b>{money(data.totals.reportedCost, t, language)}</b></span><span>{t('models.totals.quota')} <b>{money(data.totals.quotaEstimate, t, language)}</b></span><span>{t('models.totals.errors')} <b>{formatNumber(language, data.totals.errorCount)}</b></span></div>
      <div className="model-analytics-grid"><article className="model-chart-card"><div className="model-card-heading"><div><h3>{t('models.chart.title', { period: bucketPeriod })}</h3><p>{t('models.chart.subtitle', { tokens: tokenCompact(data.totals.totalTokens, t, language) })}</p></div><div className="chart-heading-actions"><div className="bucket-control compact" role="group" aria-label={t('models.filter.group')}>{(['day', 'week', 'month'] as const).map(value => <button key={value} className={bucket === value ? 'active' : ''} onClick={() => setBucket(value)}>{t(value === 'day' ? 'models.bucket.day' : value === 'week' ? 'models.bucket.week' : 'models.bucket.month')}</button>)}</div><div className="chart-legend"><span><i className="legend-total"/>{t('models.chart.total')}</span><span><i className="legend-input"/>{t('models.chart.input')}</span><span><i className="legend-output"/>{t('models.chart.output')}</span></div></div></div>{data.trend.length ? <div className="model-chart-wrap"><svg viewBox="0 0 780 230" role="img" aria-label={t('models.chart.aria')}><line x1="42" y1="30" x2="758" y2="30"/><line x1="42" y1="84" x2="758" y2="84"/><line x1="42" y1="139" x2="758" y2="139"/><line x1="42" y1="194" x2="758" y2="194"/><text x="4" y="34">{compactNumber(max, language)}</text><text x="4" y="88">{compactNumber(max * .67, language)}</text><text x="4" y="143">{compactNumber(max * .33, language)}</text><text x="20" y="198">0</text><polyline className="series-total" points={points(point => point.totalTokens)}/><polyline className="series-input" points={points(point => point.inputTokens)}/><polyline className="series-output" points={points(point => point.outputTokens)}/>{data.trend.map((point, index) => <circle key={`${point.period}-${index}`} cx={42 + index * (716 / Math.max(1, data.trend.length - 1))} cy={194 - (point.totalTokens ?? 0) / max * 164} r="3"><title>{t('models.chart.tooltip', { time: time(point.period, language), tokens: tokenText(point.totalTokens, t, language) })}</title></circle>)}</svg><div className="chart-period-labels"><span>{time(data.trend[0].period, language).split(',')[0]}</span><span>{data.trend.length > 2 ? time(data.trend[Math.floor(data.trend.length / 2)].period, language).split(',')[0] : ''}</span><span>{time(data.trend[data.trend.length - 1].period, language).split(',')[0]}</span></div></div> : <div className="empty compact">{t('models.chart.empty')}</div>}</article>
        <article className="agent-share-card"><div className="model-card-heading"><div><h3>{t('models.agents.title')}</h3><p>{t('models.agents.count', { count: data.agents.length, value: formatNumber(language, data.agents.length) })}</p></div></div><div className="agent-share-content"><div className="agent-donut" style={donutStyle}><div><b>{tokenCompact(data.totals.totalTokens, t, language)}</b><small>{t('models.agents.tokens')}</small></div></div><div className="agent-share-legend">{data.agents.map((agent, index) => <div key={agent.name}><i style={{ background: agentColors[index % agentColors.length] }}/><span>{agent.name}</span><b>{agent.share == null ? t('common.noData') : t('models.metric.percent', { value: decimals(agent.share * 100, 1) })}</b></div>)}</div></div></article></div>
      <article className="model-breakdown-card"><div className="model-card-heading"><div><h3>{t('models.breakdown.title')}</h3><p>{t('models.breakdown.subtitle')}</p></div></div>{data.models.length ? <div className="table-wrap"><table className="model-breakdown-table"><thead><tr><th>{t('models.column.model')}</th><th>{t('models.column.calls')}</th><th>{t('models.column.tokens')}</th><th>{t('models.column.latency')}</th><th>{t('models.column.throughput')}</th><th>{t('models.column.cache')}</th><th>{t('models.column.errors')}</th><th>{t('models.column.reportedCost')}</th><th>{t('models.column.quota')}</th><th>{t('models.column.quotaPerCall')}</th></tr></thead><tbody>{data.models.map(item => <tr key={item.name}><td><b title={item.name}>{item.name}</b><small>{item.share == null ? t('common.noData') : t('models.breakdown.share', { percent: decimals(item.share * 100, 1) })}</small></td><td>{formatNumber(language, item.calls)}</td><td>{tokenText(item.tokens, t, language)}</td><td>{spanDuration(item.averageDurationMs, t, language)}</td><td>{speedText(item.outputTokensPerSec)}</td><td>{pct(item.cacheEfficiency)}</td><td>{formatNumber(language, item.errorCount)}</td><td>{money(item.reportedCost, t, language)}</td><td>{money(item.quotaEstimate, t, language)}</td><td>{money(item.quotaPerCall, t, language)}</td></tr>)}</tbody></table></div> : <div className="empty compact">{t('models.breakdown.empty')}</div>}</article>
      <p className="analytics-footnote">{t('models.footnote.consumption')}</p>
    </> : <>
      <div className="efficiency-toolbar">
        <div className="analytics-section-label">{t('models.efficiency.highlights')}</div>
        <div className="efficiency-min-calls">
          {hiddenByMinCalls > 0 && <span className="min-calls-note">{t('models.efficiency.hidden', { count: hiddenByMinCalls, value: formatNumber(language, hiddenByMinCalls), min: minCalls })} <button type="button" className="text-button" onClick={() => setMinCalls(1)}>{t('models.efficiency.showAll')}</button></span>}
          <label>{t('models.efficiency.minCalls')}
            <select value={minCalls} onChange={e => setMinCalls(Number(e.target.value))}>
              <option value={1}>{t('models.efficiency.minCallsAll')}</option>
              {[5, 10, 25, 50, 100, 500].map(value => <option key={value} value={value}>{t('models.efficiency.minCallsAt', { value: formatNumber(language, value) })}</option>)}
            </select>
          </label>
        </div>
      </div>
      {highlights.length ? <div className="efficiency-highlights">{highlights.map(item => <article className="efficiency-highlight-card" key={item.id}><span>{item.label}</span><b title={item.model}>{item.model}</b><strong>{item.metricText}</strong><small>{item.sampleNote}</small></article>)}</div> : <div className="empty compact">{t('models.efficiency.empty')}</div>}
      <article className="model-chart-card scatter-card">
        <div className="model-card-heading">
          <div><h3>{t('models.scatter.title')}</h3><p>{valueAxis === 'latency' ? t('models.scatter.hintLatency') : t('models.scatter.hint')}</p></div>
          <div className="scatter-controls">
            <label>{t('models.scatter.axisX')}<select value={costAxis} onChange={e => setCostAxis(e.target.value as CostAxisMetric)}><option value="quotaPerCall">{t('models.scatter.x.quotaPerCall')}</option><option value="quotaPer1M">{t('models.scatter.x.quotaPer1M')}</option><option value="tokensPerCall">{t('models.scatter.x.tokensPerCall')}</option></select></label>
            <label>{t('models.scatter.axisY')}<select value={valueAxis} onChange={e => setValueAxis(e.target.value as ValueAxisMetric)}><option value="speed">{t('models.scatter.y.speed')}</option><option value="latency">{t('models.scatter.y.latency')}</option><option value="cache">{t('models.scatter.y.cache')}</option><option value="benchmarkPass">{t('models.scatter.y.benchmarkPass')}</option><option value="benchmarkJudge">{t('models.scatter.y.benchmarkJudge')}</option></select></label>
          </div>
        </div>
        {scatter.points.length ? <div className="model-chart-wrap scatter-wrap">
          <div className="scatter-stage">
            <svg className="scatter-svg" viewBox="0 0 920 380" role="img" aria-label={t('models.scatter.aria')}>
              <line x1="84" y1="28" x2="876" y2="28"/><line x1="84" y1="125" x2="876" y2="125"/><line x1="84" y1="222" x2="876" y2="222"/><line x1="84" y1="318" x2="876" y2="318"/>
              <line x1="84" y1="28" x2="84" y2="318"/><line x1="348" y1="28" x2="348" y2="318"/><line x1="612" y1="28" x2="612" y2="318"/><line x1="876" y1="28" x2="876" y2="318"/>
              <text x="10" y="33">{formatYValue(scatter.yMax)}</text><text x="10" y="130">{formatYValue(scatter.yMax * 0.67)}</text><text x="10" y="227">{formatYValue(scatter.yMax * 0.33)}</text><text x="10" y="322">{formatYValue(0)}</text>
              <text x="84" y="346">{formatXValue(0)}</text><text x="328" y="346">{formatXValue(scatter.xMax * 0.33)}</text><text x="592" y="346">{formatXValue(scatter.xMax * 0.67)}</text><text x="820" y="346">{formatXValue(scatter.xMax)}</text>
              {scatterLabels.map((lbl, idx) => {
                const color = scatterColors[idx % scatterColors.length];
                const isHovered = hoveredModel === lbl.name;
                return <g key={lbl.name} opacity={hoveredModel && !isHovered ? 0.25 : 1}>
                  {lbl.needsLeader && <line className="scatter-leader" x1={lbl.cx} y1={lbl.cy} x2={lbl.leaderX} y2={lbl.leaderY} />}
                  <circle
                    cx={lbl.cx} cy={lbl.cy} r={isHovered ? 11 : 8}
                    style={{ fill: color }}
                    tabIndex={0}
                    onMouseEnter={() => setHoveredModel(lbl.name)}
                    onMouseLeave={() => setHoveredModel(null)}
                    onFocus={() => setHoveredModel(lbl.name)}
                    onBlur={() => setHoveredModel(null)}
                  />
                  {!isHovered && <text className="scatter-label" x={lbl.x} y={lbl.y} textAnchor={lbl.anchor}>{lbl.label}</text>}
                </g>;
              })}
            </svg>
            {(() => {
              const pt = scatter.points.find(p => p.name === hoveredModel);
              if (!pt) return null;
              const idx = scatter.points.findIndex(p => p.name === pt.name);
              const color = scatterColors[idx % scatterColors.length];
              const leftPct = (84 + pt.xNorm * 792) / 920 * 100;
              const topPct = (318 - pt.yNorm * 290) / 380 * 100;
              return <div className={`scatter-tooltip ${pt.xNorm > 0.62 ? 'flip-x' : ''} ${pt.yNorm > 0.72 ? 'flip-y' : ''}`} style={{ left: `${leftPct}%`, top: `${topPct}%` }} role="status">
                <div className="scatter-tooltip-title"><i style={{ background: color }} /><b>{pt.name}</b></div>
                <div><span>{formatXValue(pt.x)}</span> · <span>{formatYValue(pt.y)}</span></div>
                <small>{t('models.scatter.calls', { count: pt.calls, value: formatNumber(language, pt.calls) })}{pt.errorCount ? `${t('common.listSeparator')}${t('common.errors', { count: pt.errorCount, value: formatNumber(language, pt.errorCount) })}` : ''}</small>
              </div>;
            })()}
          </div>
          <div className="scatter-legend">{scatter.points.map((pt, idx) => <button type="button" className={`scatter-legend-item ${hoveredModel === pt.name ? 'active' : ''}`} key={pt.name} onMouseEnter={() => setHoveredModel(pt.name)} onMouseLeave={() => setHoveredModel(null)}><i style={{ background: scatterColors[idx % scatterColors.length] }}/><b title={pt.name}>{pt.name}</b><small>{formatXValue(pt.x)} · {formatYValue(pt.y)}</small></button>)}</div>
          {scatter.excludedCount > 0 && <small className="scatter-note">{t('models.scatter.excluded', { count: scatter.excludedCount, value: formatNumber(language, scatter.excludedCount) })}</small>}
        </div> : <div className="empty compact">{t('models.scatter.empty')}</div>}
      </article>
      <article className="model-breakdown-card"><div className="model-card-heading"><div><h3>{t('models.matrix.title')}</h3><p>{t('models.matrix.subtitle')}</p></div></div>{efficiencyModels.length ? <div className="table-wrap"><table className="model-breakdown-table efficiency-table"><thead><tr><th>{t('models.column.model')}</th><th>{t('models.column.latency')}</th><th>{t('models.column.throughput')}</th><th>{t('models.column.cache')}</th><th>{t('models.column.tokensPerCall')}</th><th>{t('models.column.quotaPerCall')}</th><th>{t('models.column.quotaPer1M')}</th><th>{t('models.column.reportedCost')}</th><th>{t('models.column.sessionsOk')}</th><th>{t('models.column.benchmarks')}</th></tr></thead><tbody>{efficiencyModels.map(item => <tr key={item.name}><td><b title={item.name}>{item.name}</b><small>{t('models.matrix.usage', { calls: formatNumber(language, item.calls), sessions: formatNumber(language, item.sessionCount ?? 0) })}</small></td><td>{spanDuration(item.averageDurationMs, t, language)}</td><td>{speedText(item.outputTokensPerSec)}</td><td>{pct(item.cacheEfficiency)}</td><td>{item.tokens != null && item.calls > 0 ? formatNumber(language, Math.round(item.tokens / item.calls)) : t('common.noData')}</td><td>{money(item.quotaPerCall, t, language)}</td><td>{item.quotaPer1MTokens == null ? t('common.noData') : t('models.metric.usd', { value: decimals(item.quotaPer1MTokens, 2) })}</td><td>{money(item.reportedCost, t, language)}</td><td>{pct(item.completedSessionRate)}</td><td>{item.benchmarkCases ? (item.benchmarkJudgeAvg != null ? t('models.matrix.benchmarkWithJudge', { pass: pct(item.benchmarkPassRate), cases: item.benchmarkCases, value: decimals(item.benchmarkJudgeAvg, 1) }) : t('models.matrix.benchmark', { pass: pct(item.benchmarkPassRate), cases: item.benchmarkCases })) : t('common.noData')}</td></tr>)}</tbody></table></div> : <div className="empty compact">{t('models.matrix.empty', { value: formatNumber(language, minCalls) })}</div>}</article>
      {(data.roles?.length ?? 0) > 0 && <article className="model-breakdown-card"><div className="model-card-heading"><div><h3>{t('models.roles.title')}</h3><p>{t('models.roles.subtitle')}</p></div></div><div className="table-wrap"><table className="model-breakdown-table"><thead><tr><th>{t('models.column.role')}</th><th>{t('models.column.calls')}</th><th>{t('models.column.sessions')}</th><th>{t('models.column.tokens')}</th><th>{t('models.column.latency')}</th><th>{t('models.column.throughput')}</th><th>{t('models.column.reportedCost')}</th><th>{t('models.column.quota')}</th><th>{t('models.column.errors')}</th></tr></thead><tbody>{data.roles!.map(role => <tr key={role.role}><td><span className="role-chip">{role.role}</span></td><td>{formatNumber(language, role.calls)}</td><td>{formatNumber(language, role.sessionCount)}</td><td>{tokenText(role.tokens, t, language)}</td><td>{spanDuration(role.averageDurationMs, t, language)}</td><td>{speedText(role.outputTokensPerSec)}</td><td>{money(role.reportedCost, t, language)}</td><td>{money(role.quotaEstimate, t, language)}</td><td>{formatNumber(language, role.errorCount)}</td></tr>)}</tbody></table></div></article>}
      <p className="analytics-footnote">{t('models.footnote.efficiency')}</p>
    </>}
  </section>;
}

function BehaviorPage(props: {
  data: BehaviorReport | null; error: RequestError | null; period: string; setPeriod: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void;
  onRefresh: () => void; onOpenSession: (id: string) => void;
}) {
  const { data, error, period, setPeriod, scope, setScope, onRefresh, onOpenSession } = props;
  const { language, t } = useLanguage();
  return <section className="comparison-page behavior-page">
    <SectionHeader icon="behavior" eyebrow={t('behavior.eyebrow')} title={t('behavior.title')} description={t('behavior.description')} actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label={t('behavior.period.label')} value={period} onChange={event => setPeriod(event.target.value)}><option value="1">{t('behavior.period.lastDay')}</option><option value="7">{t('behavior.period.last7')}</option><option value="30">{t('behavior.period.last30')}</option><option value="90">{t('behavior.period.last90')}</option><option value="all">{t('behavior.period.all')}</option></select><button onClick={onRefresh}>{t('common.refresh')}</button></div>} />
    {error && <div className="api-error">{errorText(t, error)}</div>}
    {!data ? <div className="empty comparison-empty">{t('behavior.loading')}</div> : <>
      <div className="analytics-summary"><article><span>{t('behavior.totals.sessions')}</span><b>{formatNumber(language, data.totals.sessions)}</b></article><article><span>{t('behavior.totals.flagged')}</span><b>{formatNumber(language, data.totals.flaggedSessions)}</b></article><article><span>{t('behavior.totals.signals')}</span><b>{formatNumber(language, data.totals.signals)}</b></article></div>
      {data.sessions.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">✓</div><b>{t('behavior.empty.title')}</b><p>{t('behavior.empty.body')}</p></div> : <div className="tool-analytics-list">{data.sessions.map(session => <article className="tool-analytics-card" key={session.id}><div className="tool-analytics-heading"><div><h3>{session.title || t('common.untitledSession')}</h3><p>{[session.project, session.model].filter(Boolean).join(t('common.listSeparator')) || t('behavior.session.metaEmpty')}</p></div><span className={`badge ${session.status}`}>{statusLabel(t, session.status)}</span></div><div className="signal-list">{session.signals.map((signal, index) => { const text = translateSignal(t, signal); return <div className={`signal ${signal.severity}`} key={`${signal.kind}-${index}`}><b>{text.title}</b><span>{text.explanation}</span></div>; })}</div><div className="behavior-actions"><button className="text-button" onClick={() => onOpenSession(session.id)}>{t('common.openSession')}</button></div></article>)}</div>}
    </>}
  </section>;
}

function OverviewPage(props: {
  data: OverviewReport | null; error: RequestError | null; period: string; setPeriod: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void;
  onRefresh: () => void; onOpenSession: (id: string) => void;
}) {
  const { data, error, period, setPeriod, scope, setScope, onRefresh, onOpenSession } = props;
  const { language, t } = useLanguage();
  const number = (value: number) => formatNumber(language, value);
  const percent = (value?: number | null) => value == null ? t('common.noData') : t('common.percent', { value: formatNumber(language, value * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  return <section className="comparison-page overview-page">
    <SectionHeader icon="overview" eyebrow={t('overview.eyebrow')} title={t('overview.title')} description={t('overview.description')} actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label={t('common.period.label')} value={period} onChange={event => setPeriod(event.target.value)}><option value="1">{t('common.period.lastDay')}</option><option value="7">{t('common.period.last7')}</option><option value="30">{t('common.period.last30')}</option><option value="90">{t('common.period.last90')}</option><option value="all">{t('common.period.all')}</option></select><button onClick={onRefresh}>{t('common.refresh')}</button></div>} />
    {error && <div className="api-error">{errorText(t, error)}</div>}
    {!data ? <div className="empty comparison-empty">{t('overview.loading')}</div> : <>
      <div className="overview-kpis"><article><span>{t('overview.kpi.sessions')}</span><b>{number(data.totals.sessions)}</b></article><article><span>{t('overview.kpi.active')}</span><b>{number(data.totals.active)}</b></article><article><span>{t('overview.kpi.completed')}</span><b>{number(data.totals.completed)}</b></article><article><span>{t('overview.kpi.error')}</span><b>{number(data.totals.error)}</b></article><article><span>{t('overview.kpi.interrupted')}</span><b>{number(data.totals.interrupted)}</b></article></div>
      <div className="overview-kpis"><article><span>{t('overview.kpi.successRate')}</span><b>{percent(data.totals.successRate)}</b></article><article><span>{t('overview.kpi.averageDuration')}</span><b>{data.totals.averageDurationMs == null ? t('common.noData') : duration(data.totals.averageDurationMs, t, language)}</b></article><article><span>{t('overview.kpi.totalTokens')}</span><b>{tokenText(data.totals.totalTokens, t, language)}</b></article><article><span>{t('overview.kpi.reportedCost')}</span><b>{money(data.totals.reportedCost, t, language)}</b></article><article><span>{t('overview.kpi.quota')}</span><b>{money(data.totals.quotaEstimate, t, language)}</b></article></div>
      <div className="overview-grid">
        <article className="overview-card"><h3>{t('overview.tools.title')}</h3>{data.topTools.length === 0 ? <div className="empty compact">{t('overview.tools.empty')}</div> : <div className="table-wrap"><table><thead><tr><th>{t('overview.tools.name')}</th><th>{t('overview.tools.calls')}</th><th>{t('overview.tools.errorRate')}</th><th>{t('overview.tools.sessions')}</th></tr></thead><tbody>{data.topTools.map(tool => <tr key={tool.name}><td><b>{tool.name}</b></td><td>{number(tool.calls)}</td><td>{percent(tool.errorRate)}<small>{t('common.errors', { count: tool.errors, value: number(tool.errors) })}</small></td><td>{number(tool.sessions)}</td></tr>)}</tbody></table></div>}</article>
        <article className="overview-card"><h3>{t('overview.models.title')}</h3>{data.topModels.length === 0 ? <div className="empty compact">{t('overview.models.empty')}</div> : <div className="table-wrap"><table><thead><tr><th>{t('overview.models.name')}</th><th>{t('overview.models.calls')}</th><th>{t('overview.models.tokens')}</th><th>{t('overview.models.reportedCost')}</th><th>{t('overview.models.quota')}</th></tr></thead><tbody>{data.topModels.map(model => <tr key={model.name}><td><b>{model.name}</b></td><td>{number(model.calls)}</td><td>{tokenText(model.totalTokens, t, language)}</td><td>{money(model.reportedCost, t, language)}</td><td>{money(model.quotaEstimate, t, language)}</td></tr>)}</tbody></table></div>}</article>
      </div>
      <article className="overview-card overview-list"><h3>{t('overview.sessions.title')}</h3>{data.recentSessions.length === 0 ? <div className="empty compact">{t('overview.sessions.empty')}</div> : <div className="table-wrap"><table><thead><tr><th>{t('overview.sessions.session')}</th><th>{t('overview.sessions.project')}</th><th>{t('overview.sessions.model')}</th><th>{t('overview.sessions.status')}</th><th>{t('overview.sessions.updated')}</th><th></th></tr></thead><tbody>{data.recentSessions.map(session => <tr key={session.id} onClick={() => onOpenSession(session.id)}><td><b title={session.title || t('common.untitledSession')}>{session.title || t('common.untitledSession')}</b></td><td>{session.project || '—'}</td><td>{session.model || '—'}</td><td><span className={`badge ${session.status}`}>{statusLabel(t, session.status)}</span></td><td>{time(session.updatedAt, language)}</td><td><button className="text-button overview-open" onClick={event => { event.stopPropagation(); onOpenSession(session.id); }}>{t('common.openSession')}</button></td></tr>)}</tbody></table></div>}</article>
    </>}
  </section>;
}

function TraceWaterfall(props: {
  waterfall: Waterfall;
  selectedId: string | null;
  highlightedId: string | null;
  onSelect: (id: string) => void;
  registerRow: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const { waterfall, selectedId, highlightedId, onSelect, registerRow } = props;
  const { language, t } = useLanguage();
  return <>
    <div className="waterfall-axis">
      <span>{t('trace.column.span')}</span>
      <span className="waterfall-scale" aria-hidden="true"><span>0</span><span>{duration(waterfall.totalMs / 2, t, language)}</span><span>{duration(waterfall.totalMs, t, language)}</span></span>
      <span>{t('trace.column.duration')}</span>
    </div>
    {!waterfall.hasAnyDuration && <p className="waterfall-note">{t('trace.noDurations')}</p>}
    {waterfall.rows.map((row) => {
      const rowDuration = row.hasDuration ? spanDuration(row.span.durationMs, t, language) : t('trace.noDuration');
      return (
      <button
        type="button"
        key={row.span.id}
        className={['waterfall-row', selectedId === row.span.id ? 'selected' : '', highlightedId === row.span.id ? 'revealed' : ''].filter(Boolean).join(' ')}
        aria-pressed={selectedId === row.span.id}
        aria-label={t('trace.rowAria', { name: row.span.name, kind: kindLabel(row.span.kind, t), status: statusLabel(t, row.span.status), duration: rowDuration })}
        data-span-id={row.span.id}
        title={t('trace.rowTitle', { name: row.span.name, duration: rowDuration })}
        ref={(element) => { registerRow(row.span.id, element); }}
        onClick={() => onSelect(row.span.id)}
      >
        <span className="waterfall-label" style={{ paddingLeft: `${row.depth * 14}px` }}>
          <span className="waterfall-name">
            <span className={isErrorStatus(row.span.status) ? 'waterfall-status bad' : 'waterfall-status'} aria-hidden="true" />
            <b>{row.span.name}</b>
          </span>
          <small className="waterfall-meta">{kindLabel(row.span.kind, t)} · {clock(row.span.startedAt, language)}</small>
        </span>
        <span className="waterfall-track" aria-hidden="true">
          <i
            className={['waterfall-bar', row.span.kind, isErrorStatus(row.span.status) ? 'error' : '', row.hasDuration ? '' : 'unknown'].filter(Boolean).join(' ')}
            style={{ left: `${row.startPercent}%`, width: `${row.widthPercent}%` }}
          />
        </span>
        <span className="waterfall-duration">{rowDuration}</span>
      </button>
      );
    })}
  </>;
}

function SpanInspector({ span, parent }: { span: Span | null; parent: Span | null }) {
  const { language, t } = useLanguage();
  if (!span) {
    return <aside className="span-inspector"><p className="muted">{t('trace.inspector.empty')}</p></aside>;
  }
  const attributes = safeAttributes(span.attributesJson);
  const errorCode = attributes.find(([key]) => key === 'error_code')?.[1];
  const model = span.kind === 'inference' ? span.name : parent?.kind === 'inference' ? parent.name : t('common.noData');
  const start = Date.parse(span.startedAt);
  const end = span.durationMs != null && Number.isFinite(start) ? time(new Date(start + span.durationMs).toISOString(), language) : t('common.noData');
  const hasTokens = span.kind === 'inference' || [span.inputTokens, span.outputTokens, span.reasoningTokens, span.cacheReadTokens, span.cacheWriteTokens].some(value => value != null);
  const quotaProvenance = describeQuotaProvenance(span, t, language);
  const totalTokens = tokenSum(span.inputTokens, span.outputTokens, span.cacheReadTokens, span.cacheWriteTokens);
  return <aside className="span-inspector">
    <div className="span-inspector-head">
      <div><span className="eyebrow">{kindLabel(span.kind, t)}</span><h4>{span.name}</h4></div>
      <span className={`badge ${span.status}`}>{statusLabel(t, span.status)}</span>
    </div>
    {errorCode && <p className="span-error">{t('trace.inspector.errorCode', { code: errorCode })}</p>}
    <dl className="span-facts">
      <div><dt>{t('trace.fact.kind')}</dt><dd>{kindLabel(span.kind, t)}</dd></div>
      {span.agent && <div><dt>{t('detail.inspector.agent')}</dt><dd><span className="role-chip">{span.agent}</span></dd></div>}
      <div><dt>{t('trace.fact.model')}</dt><dd>{model}</dd></div>
      <div><dt>{t('trace.fact.start')}</dt><dd>{time(span.startedAt, language)}</dd></div>
      <div><dt>{t('trace.fact.end')}</dt><dd>{end}</dd></div>
      <div><dt>{t('trace.fact.duration')}</dt><dd>{spanDuration(span.durationMs, t, language)}</dd></div>
      <div><dt>{t('trace.fact.reportedCost')}</dt><dd>{money(span.cost, t, language)}</dd></div>
      <div><dt>{t('trace.fact.quota')}</dt><dd>{money(span.quotaCostEstimate, t, language)}</dd></div>
      <div><dt>{t('trace.fact.quotaProvenance')}</dt><dd>{quotaProvenance ?? t('common.noData')}</dd></div>
    </dl>
    {hasTokens ? <div className="span-tokens">
      <span className="eyebrow">{t('trace.tokens.label')}</span>
      <div className="span-token-grid">
        <div><span>{t('trace.tokens.input')}</span><b>{tokenText(span.inputTokens, t, language)}</b></div>
        <div><span>{t('trace.tokens.output')}</span><b>{tokenText(span.outputTokens, t, language)}</b></div>
        <div><span>{t('trace.tokens.reasoning')}</span><b>{tokenText(span.reasoningTokens, t, language)}</b></div>
        <div><span>{t('trace.tokens.cacheRead')}</span><b>{tokenText(span.cacheReadTokens, t, language)}</b></div>
        <div><span>{t('trace.tokens.cacheWrite')}</span><b>{tokenText(span.cacheWriteTokens, t, language)}</b></div>
        <div><span>{t('trace.tokens.total')}</span><b>{tokenText(totalTokens, t, language)}</b></div>
      </div>
      <p className="span-note">{t('trace.tokens.note')}</p>
    </div> : <p className="muted">{t('trace.tokens.empty')}</p>}
    {attributes.length > 0 && <div className="span-attributes">
      <span className="eyebrow">{t('trace.attributes.label')}</span>
      {attributes.map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}
    </div>}
  </aside>;
}

function App() {
  const { language, t, setLanguage } = useLanguage();
  const [listing, setListing] = React.useState<Listing>({ items: [], total: 0, page: 1, pageSize: 100 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<SessionDetail | null>(null);
  const [status, setStatus] = React.useState('');
  const [model, setModel] = React.useState('');
  const [projectFilter, setProjectFilter] = React.useState('');
  const [toolFilter, setToolFilter] = React.useState('');
  const [agentFilter, setAgentFilter] = React.useState('');
  const [treeMode, setTreeMode] = React.useState(true);
  const [expandedSessions, setExpandedSessions] = React.useState<Set<string>>(() => new Set());
  const [childrenByParent, setChildrenByParent] = React.useState<Record<string, Session[]>>({});
  const [loadingChildren, setLoadingChildren] = React.useState<Record<string, boolean>>({});
  const expandedRef = React.useRef(expandedSessions);
  expandedRef.current = expandedSessions;
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [online, setOnline] = React.useState(false);
  const [apiError, setApiError] = React.useState<RequestError | null>(null);
  const [installPrompt, setInstallPrompt] = React.useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [installHelpVisible, setInstallHelpVisible] = React.useState(false);
  const [reviewRating, setReviewRating] = React.useState<number | null>(null);
  const [reviewNote, setReviewNote] = React.useState('');
  const [reviewMessage, setReviewMessage] = React.useState<Message | null>(null);
  const [reviewSaving, setReviewSaving] = React.useState(false);
  const [budgets, setBudgets] = React.useState<Budget[]>([]);
  const [budgetProject, setBudgetProject] = React.useState('');
  const [budgetLimit, setBudgetLimit] = React.useState('');
  const [budgetMetric, setBudgetMetric] = React.useState<'cost' | 'quota'>('cost');
  const [budgetMessage, setBudgetMessage] = React.useState<Message | null>(null);
  const [budgetSaving, setBudgetSaving] = React.useState(false);
  const [view, setView] = React.useState<'overview' | 'sessions' | 'compare' | 'tools' | 'models' | 'behavior' | 'benchmarks'>('overview');
  const [benchmarkVersion, setBenchmarkVersion] = React.useState(0);
  const [taskLabel, setTaskLabel] = React.useState('');
  const [comparisonGroups, setComparisonGroups] = React.useState<ComparisonGroup[]>([]);
  const [comparisonTask, setComparisonTask] = React.useState('');
  const [comparisonError, setComparisonError] = React.useState<RequestError | null>(null);
  const [toolAnalytics, setToolAnalytics] = React.useState<ToolAnalytics | null>(null);
  const [toolWindow, setToolWindow] = React.useState('30');
  const [toolError, setToolError] = React.useState<RequestError | null>(null);
  const [modelAnalytics, setModelAnalytics] = React.useState<ModelAnalytics | null>(null);
  const [modelError, setModelError] = React.useState<RequestError | null>(null);
  const [modelBucket, setModelBucket] = React.useState<'day' | 'week' | 'month'>('day');
  const [modelFrom, setModelFrom] = React.useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [modelTo, setModelTo] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [modelSource, setModelSource] = React.useState('');
  const [modelName, setModelName] = React.useState('');
  const [behavior, setBehavior] = React.useState<BehaviorReport | null>(null);
  const [behaviorPeriod, setBehaviorPeriod] = React.useState('30');
  const [behaviorError, setBehaviorError] = React.useState<RequestError | null>(null);
  const [overview, setOverview] = React.useState<OverviewReport | null>(null);
  const [overviewPeriod, setOverviewPeriod] = React.useState('30');
  const [overviewError, setOverviewError] = React.useState<RequestError | null>(null);
  const [scope, setScope] = React.useState<ScopeFilter>('all');
  const [exporting, setExporting] = React.useState(false);
  const [deletingSession, setDeletingSession] = React.useState(false);
  const [systemVersion, setSystemVersion] = React.useState<SystemVersion | null>(null);
  const loadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const selectedRef = React.useRef<string | null>(selected);
  const detailLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const toolLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const modelLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const behaviorLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const overviewLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const viewRef = React.useRef(view);
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(null);
  const [reveal, setReveal] = React.useState<SpanReveal | null>(null);
  const [highlightedSpanId, setHighlightedSpanId] = React.useState<string | null>(null);
  const [errorFocus, setErrorFocus] = React.useState<ErrorFocus | null>(null);
  const spanRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const focusNonce = React.useRef(0);

  const loadChildren = React.useCallback(async (parentId: string) => {
    setLoadingChildren(prev => ({ ...prev, [parentId]: true }));
    try {
      const response = await fetch(`/api/v1/sessions?parentSessionId=${encodeURIComponent(parentId)}&pageSize=100`);
      if (!response.ok) return;
      const data = await response.json() as Listing;
      setChildrenByParent(prev => ({ ...prev, [parentId]: data.items }));
    } catch { /* Se reintentará en el próximo refresco. */ }
    finally { setLoadingChildren(prev => ({ ...prev, [parentId]: false })); }
  }, []);
  const toggleTreeNode = React.useCallback((sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else { next.add(sessionId); void loadChildren(sessionId); }
      return next;
    });
  }, [loadChildren]);

  const load = React.useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '100' });
    if (status) params.set('status', status);
    if (model.trim()) params.set('model', model.trim());
    if (projectFilter.trim()) params.set('project', projectFilter.trim());
    if (toolFilter.trim()) params.set('tool', toolFilter.trim());
    if (agentFilter.trim()) params.set('agent', agentFilter.trim());
    else if (treeMode) params.set('rootOnly', 'true');
    if (errorsOnly) params.set('error', 'true');
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    if (scope !== 'all') params.set('scope', scope);
    try {
      const response = await fetch(`/api/v1/sessions?${params}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      setListing(await response.json()); setApiError(null);
      if (treeMode && !agentFilter.trim() && expandedRef.current.size > 0) {
        for (const parentId of expandedRef.current) void loadChildren(parentId);
      }
    } catch { setApiError({ key: 'sessions.loadFailed' }); }
  }, [status, model, projectFilter, toolFilter, agentFilter, treeMode, from, to, errorsOnly, page, scope, loadChildren]);
  loadRef.current = load;
  selectedRef.current = selected;
  const loadDetail = React.useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      const next = await response.json() as SessionDetail;
      if (selectedRef.current === sessionId) {
        setDetail(next);
        setReviewRating(next.session.rating ?? null);
        setReviewNote(next.session.reviewNote ?? '');
        setTaskLabel(next.session.reviewTask ?? '');
      }
    } catch { /* Preserve current detail if a background refresh fails. */ }
  }, []);
  detailLoadRef.current = async () => { if (selectedRef.current) await loadDetail(selectedRef.current); };
  const openSession = React.useCallback((id: string, focusFirstError = false) => {
    setSelected(id);
    setView('sessions');
    setErrorFocus(focusFirstError ? { sessionId: id, nonce: ++focusNonce.current } : null);
  }, []);
  const registerRow = React.useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) spanRefs.current.set(id, element);
    else spanRefs.current.delete(id);
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  const loadBudgets = React.useCallback(async () => {
    try {
      const response = await fetch('/api/v1/budgets');
      if (response.ok) setBudgets(await response.json());
    } catch { /* Los presupuestos se volverán a cargar cuando la API responda. */ }
  }, []);
  const loadComparisons = React.useCallback(async () => {
    try {
      const response = await fetch('/api/v1/comparisons');
      if (!response.ok) { setComparisonError({ key: 'compare.loadFailed', code: await responseErrorCode(response) }); return; }
      setComparisonGroups(await response.json()); setComparisonError(null);
    } catch { setComparisonError({ key: 'compare.loadFailed' }); }
  }, []);
  const loadToolAnalytics = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (toolWindow !== 'all') params.set('days', toolWindow);
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/analytics/tools?${params}`);
      if (!response.ok) { setToolError({ key: 'tools.loadFailed', code: await responseErrorCode(response) }); return; }
      setToolAnalytics(await response.json()); setToolError(null);
    } catch { setToolError({ key: 'tools.loadFailed' }); }
  }, [toolWindow, scope]);
  const loadModelAnalytics = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ bucket: modelBucket });
      if (modelFrom) params.set('from', new Date(`${modelFrom}T00:00:00`).toISOString());
      if (modelTo) params.set('to', new Date(`${modelTo}T23:59:59.999`).toISOString());
      if (modelSource) params.set('source', modelSource);
      if (modelName) params.set('model', modelName);
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/analytics/models?${params}`);
      if (!response.ok) { setModelError({ key: 'models.loadFailed', code: await responseErrorCode(response) }); return; }
      setModelAnalytics(await response.json()); setModelError(null);
    } catch { setModelError({ key: 'models.loadFailed' }); }
  }, [modelBucket, modelFrom, modelTo, modelSource, modelName, scope]);
  const loadBehavior = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (behaviorPeriod !== 'all') params.set('days', behaviorPeriod);
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/behavior?${params}`);
      if (!response.ok) { setBehaviorError({ key: 'behavior.loadFailed', code: await responseErrorCode(response) }); return; }
      setBehavior(await response.json()); setBehaviorError(null);
    } catch { setBehaviorError({ key: 'behavior.loadFailed' }); }
  }, [behaviorPeriod, scope]);
  const loadOverview = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (overviewPeriod !== 'all') params.set('days', overviewPeriod);
      if (scope !== 'all') params.set('scope', scope);
      const qs = params.toString();
      const response = await fetch(`/api/v1/overview${qs ? `?${qs}` : ''}`);
      if (!response.ok) { setOverviewError({ key: 'overview.loadFailed', code: await responseErrorCode(response) }); return; }
      setOverview(await response.json()); setOverviewError(null);
    } catch { setOverviewError({ key: 'overview.loadFailed' }); }
  }, [overviewPeriod, scope]);
  toolLoadRef.current = loadToolAnalytics;
  modelLoadRef.current = loadModelAnalytics;
  behaviorLoadRef.current = loadBehavior;
  overviewLoadRef.current = loadOverview;
  viewRef.current = view;
  const loadVersion = React.useCallback(async () => {
    try {
      const response = await fetch('/api/v1/version');
      if (response.ok) setSystemVersion(await response.json());
    } catch { /* Se consultará en el siguiente refresco cuando la API esté lista. */ }
  }, []);
  React.useEffect(() => { void loadBudgets(); void loadComparisons(); void loadVersion(); }, [loadBudgets, loadComparisons, loadVersion]);
  React.useEffect(() => { if (view === 'compare') void loadComparisons(); }, [view, loadComparisons]);
  React.useEffect(() => { if (view === 'tools') void loadToolAnalytics(); }, [view, loadToolAnalytics]);
  React.useEffect(() => { if (view === 'models') void loadModelAnalytics(); }, [view, loadModelAnalytics]);
  React.useEffect(() => { if (view === 'behavior') void loadBehavior(); }, [view, loadBehavior]);
  React.useEffect(() => { if (view === 'overview') void loadOverview(); }, [view, loadOverview]);
  React.useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone) setInstalled(true);
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); setInstallHelpVisible(false); };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  React.useEffect(() => {
    const connection = new HubConnectionBuilder().withUrl('/hubs/telemetry').withAutomaticReconnect().build();
    connection.on('telemetry.updated', (event?: { sessionId?: string }) => { setOnline(true); void loadRef.current(); void loadBudgets(); if (viewRef.current === 'overview') void overviewLoadRef.current(); if (viewRef.current === 'tools') void toolLoadRef.current(); if (viewRef.current === 'models') void modelLoadRef.current(); if (viewRef.current === 'behavior') void behaviorLoadRef.current(); if (event?.sessionId === selectedRef.current) void detailLoadRef.current(); });
    connection.on('benchmark.updated', () => setBenchmarkVersion(value => value + 1));
    connection.onreconnected(() => { setOnline(true); void loadRef.current(); });
    connection.onclose(() => setOnline(false));
    connection.start().then(() => setOnline(true)).catch(() => setOnline(false));
    let tick = 0;
    const interval = window.setInterval(() => {
      void loadRef.current();
      void loadBudgets();
      if (++tick % 3 === 0) {
        if (viewRef.current === 'overview') void overviewLoadRef.current();
        if (viewRef.current === 'tools') void toolLoadRef.current();
        if (viewRef.current === 'models') void modelLoadRef.current();
        if (viewRef.current === 'behavior') void behaviorLoadRef.current();
      }
    }, 10000);
    return () => { window.clearInterval(interval); void connection.stop(); };
  }, []);
  React.useEffect(() => {
    setSelectedSpanId(null);
    setReveal(null);
    setHighlightedSpanId(null);
    if (selected) void loadDetail(selected); else setDetail(null);
  }, [selected, loadDetail]);
  React.useEffect(() => {
    if (!detail) { setSelectedSpanId(null); return; }
    if (detail.session.id !== selected) return;
    const list = detail.spans ?? [];
    if (errorFocus?.sessionId === selected) {
      const errorSpan = list.find((span) => isErrorStatus(span.status));
      setErrorFocus(null);
      if (errorSpan) {
        setSelectedSpanId(errorSpan.id);
        setReveal((current) => ({ spanId: errorSpan.id, nonce: (current?.nonce ?? 0) + 1 }));
        return;
      }
    }
    setSelectedSpanId((current) =>
      current && list.some((span) => span.id === current) ? current : list[0]?.id ?? null);
  }, [detail, selected, errorFocus]);
  React.useEffect(() => {
    if (!reveal) return;
    const element = spanRefs.current.get(reveal.spanId);
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
    setHighlightedSpanId(reveal.spanId);
    const timeout = window.setTimeout(() => setHighlightedSpanId(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [reveal]);
  React.useEffect(() => { setPage(1); }, [status, model, projectFilter, toolFilter, agentFilter, treeMode, from, to, errorsOnly, scope]);

  const sessions = listing.items;
  const spans: Span[] = detail?.spans ?? [];
  const toolsUsed = [...new Set(spans.filter(span => span.kind === 'execute_tool').map(span => span.name))];
  const waterfall = React.useMemo(() => buildWaterfall(spans), [spans]);
  const selectedSpan = spans.find(span => span.id === selectedSpanId) ?? null;
  const parentSpan = selectedSpan?.parentId ? spans.find(span => span.id === selectedSpan.parentId) ?? null : null;
  const errorEvents = detail ? detail.events.filter(event => isErrorStatus(event.status)) : [];
  const tokenTotal = sessions.reduce<number | null>((sum, s) => { const pair = tokenSum(s.inputTokens, s.outputTokens); return pair == null ? sum : (sum ?? 0) + pair; }, null);
  const durationTotal = sessions.reduce((sum, s) => sum + (s.endedAt ? Math.max(0, Date.parse(s.endedAt) - Date.parse(s.startedAt)) : 0), 0);
  const installApplication = async () => {
    setInstallHelpVisible(false);
    if (!installPrompt) {
      setInstallHelpVisible(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  };
  const saveReview = async () => {
    if (!selected) return;
    setReviewSaving(true); setReviewMessage(null);
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(selected)}/review`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: reviewRating, note: reviewNote, taskLabel }) });
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) { setReviewMessage({ key: 'detail.review.endpointMissing' }); return; }
        if (response.status >= 500) { setReviewMessage({ key: 'detail.review.serverError', params: { status: response.status } }); return; }
        setReviewMessage({ key: 'detail.review.rejected', params: { status: response.status } }); return;
      }
      setReviewMessage({ key: 'detail.review.saved' }); await loadDetail(selected); await loadComparisons();
    } catch (error) { setReviewMessage({ key: error instanceof TypeError ? 'detail.review.offline' : 'detail.review.saveFailed' }); }
    finally { setReviewSaving(false); }
  };
  const saveBudget = async (event: React.FormEvent) => {
    event.preventDefault(); setBudgetSaving(true); setBudgetMessage(null);
    try {
      const response = await fetch('/api/v1/budgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: budgetProject, monthlyLimit: Number(budgetLimit), metric: budgetMetric }) });
      if (!response.ok) throw new Error();
      setBudgetMessage({ key: 'budgets.form.saved' }); setBudgetLimit(''); await loadBudgets();
    } catch { setBudgetMessage({ key: 'budgets.form.saveFailed' }); }
    finally { setBudgetSaving(false); }
  };
  const deleteBudget = async (project: string) => {
    try {
      const response = await fetch(`/api/v1/budgets?project=${encodeURIComponent(project)}`, { method: 'DELETE' });
      if (response.ok || response.status === 204) await loadBudgets();
    } catch { setBudgetMessage({ key: 'budgets.form.deleteFailed' }); }
  };
  const exportSessions = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/export?${params}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'agentscope-export.jsonl';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setApiError({ key: 'sessions.exportFailed' });
    } finally {
      setExporting(false);
    }
  };
  const deleteSession = async (sessionId: string) => {
    if (!window.confirm(t('detail.deleteConfirm'))) return;
    setDeletingSession(true);
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) throw new Error(`API respondió ${response.status}`);
      setSelected(null);
      setDetail(null);
      await Promise.all([load(), loadBudgets()]);
    } catch {
      setApiError({ key: 'sessions.deleteFailed' });
    } finally {
      setDeletingSession(false);
    }
  };

  return <main>
    <header><div><span className="eyebrow">{t('header.eyebrow')}</span><h1>AgentScope</h1><p>{t('header.tagline')}</p></div><div className="header-actions"><div className="language-switch" role="group" aria-label={t('header.language')}><button type="button" aria-pressed={language === 'es'} className={language === 'es' ? 'active' : ''} onClick={() => setLanguage('es')}>ES</button><button type="button" aria-pressed={language === 'en'} className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div><button className="install-button" disabled={installed} onClick={() => void installApplication()}>{installed ? t('header.installed') : t('header.install')}</button><span className={`live ${online ? 'connected' : ''}`}><i />{online ? t('header.live') : t('header.reconnecting')}</span>{installHelpVisible && <small className="install-help">{t('header.installHelp')}</small>}</div></header>
    <nav className="main-nav" aria-label={t('nav.label')}><button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>{t('nav.overview')}</button><button className={view === 'sessions' ? 'active' : ''} onClick={() => setView('sessions')}>{t('nav.sessions')}</button><button className={view === 'tools' ? 'active' : ''} onClick={() => setView('tools')}>{t('nav.tools')}</button><button className={view === 'behavior' ? 'active' : ''} onClick={() => setView('behavior')}>{t('nav.behavior')}</button><button className={view === 'models' ? 'active' : ''} onClick={() => setView('models')}>{t('nav.models')}</button><button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>{t('nav.compare')}</button><button className={view === 'benchmarks' ? 'active' : ''} onClick={() => setView('benchmarks')}>{t('nav.benchmarks')}</button></nav>
    {systemVersion && systemVersion.protocolVersion !== 1 && <div className="api-error" role="status">{t('header.protocolMismatch', { protocol: systemVersion.protocolVersion })}</div>}
    {view === 'overview' ? <OverviewPage data={overview} error={overviewError} period={overviewPeriod} setPeriod={setOverviewPeriod} scope={scope} setScope={setScope} onRefresh={() => void loadOverview()} onOpenSession={id => openSession(id)} /> : view === 'behavior' ? <BehaviorPage data={behavior} error={behaviorError} period={behaviorPeriod} setPeriod={setBehaviorPeriod} scope={scope} setScope={setScope} onRefresh={() => void loadBehavior()} onOpenSession={id => openSession(id)} /> : view === 'models' ? <ModelAnalyticsPage data={modelAnalytics} error={modelError} bucket={modelBucket} setBucket={setModelBucket} from={modelFrom} to={modelTo} setFrom={setModelFrom} setTo={setModelTo} source={modelSource} setSource={setModelSource} model={modelName} setModel={setModelName} scope={scope} setScope={setScope} onRefresh={() => void loadModelAnalytics()} /> : view === 'tools' ? <section className="comparison-page">
      <SectionHeader icon="tools" eyebrow={t('tools.eyebrow')} title={t('tools.title')} description={t('tools.description')} actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label={t('common.period.label')} value={toolWindow} onChange={event => setToolWindow(event.target.value)}><option value="1">{t('common.period.lastDay')}</option><option value="7">{t('common.period.last7')}</option><option value="30">{t('common.period.last30')}</option><option value="90">{t('common.period.last90')}</option><option value="all">{t('common.period.all')}</option></select><button onClick={() => void loadToolAnalytics()}>{t('common.refresh')}</button></div>} />
      {toolError && <div className="api-error">{errorText(t, toolError)}</div>}
      {toolAnalytics && <>
        <div className="analytics-summary"><article><span>{t('tools.totalCalls')}</span><b>{formatNumber(language, toolAnalytics.totalCalls)}</b></article><article><span>{t('tools.distinct')}</span><b>{formatNumber(language, toolAnalytics.tools.length)}</b></article><article><span>{t('tools.failed')}</span><b>{formatNumber(language, toolAnalytics.errorCount)}</b></article></div>
        {toolAnalytics.tools.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⌁</div><b>{t('tools.empty.title')}</b><p>{t('tools.empty.body')}</p></div> : <div className="tool-analytics-list">{toolAnalytics.tools.map(tool => <article className="tool-analytics-card" key={tool.name}>
          <div className="tool-analytics-heading">
            <div>
              <h3>{tool.name}</h3>
              <p>{[t('tools.card.sessions', { count: tool.sessionCount, value: formatNumber(language, tool.sessionCount) }), t('tools.card.calls', { count: tool.callCount, value: formatNumber(language, tool.callCount) })].join(t('common.listSeparator'))}</p>
            </div>
            <span className={tool.errorCount ? 'tool-error-rate has-errors' : 'tool-error-rate'}>{t('tools.card.failures', { count: tool.errorCount, value: formatNumber(language, tool.errorCount), percent: formatNumber(language, tool.errorRate * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
          </div>
          <div className="tool-analytics-stats">
            <div><span>{t('tools.card.averageDuration')}</span><b>{tool.averageDurationMs == null ? t('common.noData') : duration(tool.averageDurationMs, t, language)}</b></div>
            <div><span>{t('tools.card.successRate')}</span><b>{t('common.percent', { value: formatNumber(language, (1 - tool.errorRate) * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</b></div>
          </div>
          {tool.latestSessions.length > 0 && <div className="tool-session-links"><span>{t('tools.card.recent')}</span>{tool.latestSessions.map(session => <button key={session.sessionId} title={session.title || t('common.untitledSession')} onClick={() => openSession(session.sessionId)}><b>{session.title || t('common.untitledSession')}</b><small>{[session.project, session.model].filter(Boolean).join(t('common.listSeparator')) || t('tools.card.open')}</small></button>)}</div>}
        </article>)}</div>}
      </>}
    </section> : view === 'compare' ? <section className="comparison-page">
      <SectionHeader icon="compare" eyebrow={t('compare.eyebrow')} title={t('compare.title')} description={t('compare.description')} actions={<button onClick={() => void loadComparisons()}>{t('common.refresh')}</button>} />
      {comparisonError && <div className="api-error">{errorText(t, comparisonError)}</div>}
      {comparisonGroups.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⇄</div><b>{t('compare.empty.title')}</b><p>{t('compare.empty.body')}</p><button onClick={() => setView('sessions')}>{t('compare.empty.action')}</button></div> : <>
        <label className="comparison-picker">{t('compare.taskLabel')}<select value={comparisonTask && comparisonGroups.some(group => group.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel} onChange={event => setComparisonTask(event.target.value)}>{comparisonGroups.map(group => <option value={group.taskLabel} key={group.taskLabel}>{group.taskLabel}{t('common.listSeparator')}{t('compare.sessions', { count: group.sessions.length, value: formatNumber(language, group.sessions.length) })}</option>)}</select></label>
        {comparisonGroups.filter(group => group.taskLabel === (comparisonTask && comparisonGroups.some(item => item.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel)).map(group => <article className="comparison-group" key={group.taskLabel}>
          <div className="comparison-group-head">
            <div>
              <h3>{group.taskLabel}</h3>
              <p>{t('compare.group.runs', { count: group.sessions.length, value: formatNumber(language, group.sessions.length) })}</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>{t('compare.column.session')}</th>
                  <th>{t('compare.column.quality')}</th>
                  <th>{t('compare.column.cost')}</th>
                  <th>{t('compare.column.quota')}</th>
                  <th>{t('compare.column.duration')}</th>
                  <th>{t('compare.column.tokens')}</th>
                  <th>{t('compare.column.tools')}</th>
                </tr>
              </thead>
              <tbody>{group.sessions.map(run => <tr key={run.id}>
                <td>
                  <b>{run.title || t('common.untitledSession')}</b>
                  <small>{[run.model || t('detail.unknownModel'), time(run.updatedAt, language), statusLabel(t, run.status)].join(t('common.listSeparator'))}</small>{run.note && <small className="comparison-note">{run.note}</small>}</td>
                <td>{run.rating == null ? t('compare.unrated') : <span className="comparison-rating">{'★'.repeat(run.rating)}<small>{run.rating}/5</small></span>}</td>
                <td>{money(run.cost, t, language)}</td>
                <td>{money(run.quotaCostEstimate, t, language)}</td>
                <td>{duration(run.durationMs, t, language)}</td>
                <td>{tokenText(tokenSum(run.inputTokens, run.outputTokens), t, language)}<small>{t('compare.tokensBreakdown', { input: tokenText(run.inputTokens, t, language), output: tokenText(run.outputTokens, t, language) })}</small>
                </td>
                <td>{run.tools.length ? run.tools.join(', ') : '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </article>)}</>}
    </section> : view === 'benchmarks' ? <BenchmarksPage version={benchmarkVersion} onOpenSession={id => openSession(id)} /> : <><SectionHeader icon="monitoring" eyebrow={t('sessions.eyebrow')} title={t('sessions.title')} description={t('sessions.description')} actions={<div className="section-header-actions"><ScopeSelect scope={scope} setScope={setScope} /><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportSessions()}>{exporting ? t('sessions.exporting') : t('sessions.export')}</button></div>} />
    {apiError && <div className="api-error" role="status">{errorText(t, apiError)}</div>}
    <section className="stats"><article><span>{t('sessions.stat.total')}</span><b>{formatNumber(language, listing.total)}</b></article><article><span>{t('sessions.stat.pageErrors')}</span><b>{formatNumber(language, sessions.reduce((a, s) => a + s.errorCount, 0))}</b></article><article><span>{t('sessions.stat.duration')}</span><b>{duration(durationTotal, t, language)}</b></article><article><span>{t('sessions.stat.spans')}</span><b>{formatNumber(language, sessions.reduce((a, s) => a + s.spanCount, 0))}</b></article><article><span>{t('sessions.stat.tokens')}</span><b>{tokenText(tokenTotal, t, language)}</b></article></section>
    <details className="budgets-panel"><summary>{t('budgets.form.title')} <span>{budgetPanelSummary(budgets, t)}</span></summary><div className="budgets-content"><form className="budget-form" onSubmit={saveBudget}><label>{t('budgets.form.project')}<input list="known-projects" value={budgetProject} onChange={e => setBudgetProject(e.target.value)} placeholder={t('budgets.form.projectPlaceholder')} required maxLength={120}/><datalist id="known-projects">{[...new Set(sessions.map(s => s.project).filter(Boolean))].map(project => <option key={project} value={project}/>)}</datalist></label><label>{t('budgets.form.limit')}<input type="number" min="0.01" max="1000000" step="0.01" value={budgetLimit} onChange={e => setBudgetLimit(e.target.value)} placeholder="25.00" required/></label><label>{t('budgets.form.metric')}<select value={budgetMetric} onChange={e => setBudgetMetric(e.target.value as 'cost' | 'quota')}><option value="cost">{budgetMetricLabel('cost', t)}</option><option value="quota">{budgetMetricLabel('quota', t)}</option></select></label><button disabled={budgetSaving}>{budgetSaving ? t('common.saving') : t('budgets.form.save')}</button></form>{budgetMessage && <p className="form-message" role="status">{t(budgetMessage.key, budgetMessage.params)}</p>}{budgets.length > 0 && <div className="budget-list">{budgets.map(budget => <article className={`budget-item ${(budget.percentage ?? 0) >= 100 ? 'over-budget' : (budget.percentage ?? 0) >= 80 ? 'near-budget' : ''}`} key={budget.project}><div className="budget-heading"><div><b>{budget.project}</b><small>{[budgetMetricLabel(budget.metric, t), t('budgets.item.currentMonth'), budget.totalSpans ? `${t('budgets.item.measured', { measured: formatNumber(language, budget.measuredSpans ?? 0), total: formatNumber(language, budget.totalSpans) })}${budget.isPartial ? ` (${t('budgets.item.partial')})` : ''}` : ''].filter(Boolean).join(t('common.listSeparator'))}</small></div><button className="text-button" onClick={() => void deleteBudget(budget.project)}>{t('common.delete')}</button></div><div className="budget-amount">{budgetAmountText(budget, value => formatMoney(language, value), t)}</div><div className="budget-track"><i style={{ width: `${Math.min(100, budget.percentage ?? 0)}%` }}/></div><small>{budget.percentage == null ? t('budgets.item.usagePending') : [t('budgets.item.usage', { percent: formatNumber(language, budget.percentage, { maximumFractionDigits: 0 }) }), budget.percentage >= 100 ? t('budgets.item.over') : budget.percentage >= 80 ? t('budgets.item.near') : ''].filter(Boolean).join(t('common.listSeparator'))}</small></article>)}</div>}<p className="budget-footnote">{t('budgets.footnote')}</p></div></details>
    <section className="layout"><div className="panel"><div className="panel-head"><div><h2>{t('sessions.panel.title')}</h2><small>{t('sessions.panel.subtitle')}</small></div><div className="panel-head-actions"><div className="subview-switch compact-switch" role="group" aria-label={t('sessions.filter.modeAria')}><button type="button" className={treeMode ? 'active' : ''} title={t('sessions.filter.treeModeTitle')} aria-pressed={treeMode} onClick={() => setTreeMode(true)}>{t('sessions.filter.treeMode')}</button><button type="button" className={!treeMode ? 'active' : ''} title={t('sessions.filter.flatModeTitle')} aria-pressed={!treeMode} onClick={() => setTreeMode(false)}>{t('sessions.filter.flatMode')}</button></div><span className="result-count">{t('sessions.panel.count', { count: listing.total, value: formatNumber(language, listing.total) })}</span></div></div>
      <div className="filters"><label>{t('sessions.filter.status')}<select value={status} onChange={e => setStatus(e.target.value)}><option value="">{t('sessions.filter.allStatuses')}</option><option value="active">{t('status.active')}</option><option value="completed">{t('status.completed')}</option><option value="interrupted">{t('status.interrupted')}</option><option value="error">{t('status.error')}</option></select></label><label>{t('sessions.filter.model')}<input placeholder={t('sessions.filter.anyModel')} value={model} onChange={e => setModel(e.target.value)} /></label><label>{t('sessions.filter.project')}<input list="known-projects" placeholder={t('sessions.filter.anyProject')} value={projectFilter} onChange={e => setProjectFilter(e.target.value)} /></label><label>{t('sessions.filter.tool')}<input placeholder={t('sessions.filter.toolPlaceholder')} value={toolFilter} onChange={e => setToolFilter(e.target.value)} /></label><label>{t('sessions.filter.agent')}<input placeholder={t('sessions.filter.agentPlaceholder')} value={agentFilter} onChange={e => setAgentFilter(e.target.value)} /></label><label>{t('sessions.filter.from')}<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{t('sessions.filter.to')}<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label className="check-filter"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />{t('sessions.filter.errorsOnly')}</label></div>
      {apiError ? <div className="empty"><div className="empty-icon">!</div><b>{t('sessions.empty.apiTitle')}</b><p>{t('sessions.empty.apiBody')}</p><button onClick={() => void load()}>{t('common.retry')}</button></div> : sessions.length === 0 ? <div className="empty"><div className="empty-icon">⌁</div><b>{t('sessions.empty.title')}</b><p>{t('sessions.empty.body')}</p></div> : <><div className="table-wrap sessions-table" role="region" aria-label={t('sessions.table.label')} tabIndex={0}><table><thead><tr><th>{t('sessions.table.session')}</th><th>{t('sessions.table.status')}</th><th>{t('sessions.table.model')}</th><th>{t('sessions.table.spans')}</th><th>{t('sessions.table.started')}</th></tr></thead><tbody>{(treeMode && !agentFilter.trim() ? flattenSessionTree(sessions, childrenByParent, expandedSessions) : sessions.map(session => ({ session, depth: 0, expandable: false, expanded: false }))).map(row => { const s = row.session; const hierarchy = classifySessionHierarchy(s); return <React.Fragment key={s.id}><tr onClick={() => openSession(s.id)} className={[selected === s.id ? 'selected' : '', row.depth > 0 ? 'subagent-row' : ''].filter(Boolean).join(' ')}><td style={row.depth > 0 ? { paddingLeft: `${12 + row.depth * 20}px` } : undefined}><div className="session-title-cell">{row.expandable && <button type="button" className="tree-toggle" aria-expanded={row.expanded} aria-label={row.expanded ? t('sessions.tree.collapse') : t('sessions.tree.expand')} onClick={e => { e.stopPropagation(); toggleTreeNode(s.id); }}>{row.expanded ? '▾' : '▸'}</button>}<div className="session-title-body"><b title={s.title || t('common.untitledSession')}>{s.title || t('common.untitledSession')}</b>{(s.agent || hierarchy !== 'standalone') && <span className="session-role-row">{s.agent && <span className="role-chip">{s.agent}</span>}{hierarchy === 'orchestrator' && <span className="role-chip orchestrator">{t('sessions.badge.subagents', { count: s.subagentCount ?? 0, value: formatNumber(language, s.subagentCount ?? 0) })}</span>}{hierarchy === 'subagent' && <span className="role-chip subagent">{t('sessions.badge.subagent')}</span>}</span>}</div></div></td><td><span className={`badge ${s.status}`}>{statusLabel(t, s.status)}</span>{s.errorCount > 0 && (
  <button
    type="button"
    className="error-count"
    title={t('sessions.errorCount.title')}
    aria-label={t('sessions.errorCount.label', { errors: t('common.errors', { count: s.errorCount, value: formatNumber(language, s.errorCount) }) })}
    onClick={(event) => { event.stopPropagation(); openSession(s.id, true); }}
  >
    {t('common.errors', { count: s.errorCount, value: formatNumber(language, s.errorCount) })}
  </button>
)}</td><td>{s.model || '—'}</td><td>{formatNumber(language, s.spanCount)}</td><td>{time(s.startedAt, language)}</td></tr>{row.expanded && loadingChildren[s.id] && !childrenByParent[s.id] && <tr className="subagent-loading-row"><td colSpan={5} style={{ paddingLeft: `${32 + row.depth * 20}px` }}>{t('sessions.tree.loading')}</td></tr>}</React.Fragment>; })}</tbody></table></div><div className="pagination"><span>{t('sessions.pagination.page', { page: formatNumber(language, listing.page), total: formatNumber(language, Math.max(1, Math.ceil(listing.total / listing.pageSize))) })}</span><div><button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>{t('sessions.pagination.previous')}</button><button disabled={page * listing.pageSize >= listing.total} onClick={() => setPage(p => p + 1)}>{t('sessions.pagination.next')}</button></div></div></>}
    </div><div className="panel detail"><div className="panel-head"><div><h2>{detail?.session?.title || (detail ? t('common.untitledSession') : t('detail.panel.trace'))}</h2><small>{detail ? t('detail.panel.trace') : t('detail.panel.select')}</small></div><div className="detail-actions"><button onClick={() => { void load(); if (selected) void loadDetail(selected); }}>{t('common.refresh')}</button>{detail && <button type="button" className="danger-button" disabled={deletingSession} onClick={() => void deleteSession(detail.session.id)}>{deletingSession ? t('detail.deleting') : t('common.delete')}</button>}</div></div>{detail ? <>
      {detail.parentSession && <button type="button" className="parent-session-link" onClick={() => openSession(detail.parentSession!.id)}>{t('detail.parentLink', { title: detail.parentSession.title || t('common.untitledSession') })}{detail.parentSession.agent ? ` · ${detail.parentSession.agent}` : ''}</button>}
      <div className="session-meta"><span className={`badge ${detail.session.status}`}>{statusLabel(t, detail.session.status)}</span>{detail.session.agent && <span className="role-chip">{detail.session.agent}</span>}<span>{detail.session.source}</span><span>{detail.session.model || t('detail.unknownModel')}</span>{detail.quality && <span className={`badge ${detail.quality.status === 'complete' ? 'completed' : 'interrupted'}`} title={detail.quality.status === 'complete' ? t('detail.quality.completeTitle') : qualitySummary(detail.quality, t, language)}>{detail.quality.status === 'complete' ? t('detail.quality.complete') : t('detail.quality.partial', { summary: qualitySummary(detail.quality, t, language) })}</span>}</div>
      {((detail.subagents?.length ?? 0) > 0 || (detail.roleBreakdown?.length ?? 0) > 1) && (() => {
        const delegated = summarizeDelegation(detail.subagents ?? []);
        return <section className="orchestration-box">
          <div className="orchestration-head">
            <h3>{t('detail.orchestration.title')}</h3>
            {delegated.count > 0 && <small>{t('detail.orchestration.summary', { count: delegated.count, value: formatNumber(language, delegated.count) })}{delegated.totalQuota != null ? `${t('common.listSeparator')}${money(delegated.totalQuota, t, language)}` : ''}</small>}
          </div>
          {(detail.subagents?.length ?? 0) > 0 && <div className="subagent-list">{detail.subagents!.map(sub => <button type="button" className="subagent-card" key={sub.id} onClick={() => openSession(sub.id)}>
            <div className="subagent-card-top">
              <div>{sub.agent && <span className="role-chip">{sub.agent}</span>}<b>{sub.title || t('common.untitledSession')}</b></div>
              <span className={`badge ${sub.status}`}>{statusLabel(t, sub.status)}</span>
            </div>
            <div className="subagent-card-meta">
              <span>{sub.model || t('detail.unknownModel')}</span>
              <span>{sub.durationMs == null ? t('detail.metric.running') : duration(sub.durationMs, t, language)}</span>
              <span>{tokenText(tokenSum(sub.inputTokens, sub.outputTokens), t, language)} tok</span>
              {sub.quotaCostEstimate != null && <span>{money(sub.quotaCostEstimate, t, language)}</span>}
              {sub.childCount > 0 && <span className="role-chip orchestrator">{t('detail.orchestration.children', { count: sub.childCount, value: formatNumber(language, sub.childCount) })}</span>}
            </div>
          </button>)}</div>}
          {(detail.roleBreakdown?.length ?? 0) > 0 && <div className="role-breakdown-wrap"><h4>{t('detail.orchestration.rolesTitle')}</h4><div className="table-wrap"><table className="role-breakdown-table"><thead><tr><th>{t('models.column.role')}</th><th>{t('models.column.sessions')}</th><th>{t('models.column.calls')}</th><th>{t('models.column.latency')}</th><th>{t('models.column.tokens')}</th><th>{t('models.column.quota')}</th></tr></thead><tbody>{detail.roleBreakdown!.map(rb => <tr key={rb.role}><td><span className="role-chip">{rb.role}</span></td><td>{formatNumber(language, rb.sessionCount)}</td><td>{formatNumber(language, rb.calls)}</td><td>{spanDuration(rb.durationMs, t, language)}</td><td>{tokenText(rb.tokens, t, language)}</td><td>{money(rb.quotaEstimate, t, language)}</td></tr>)}</tbody></table></div></div>}
        </section>;
      })()}
      <section className="review-box"><div><h3>{t('detail.review.title')}</h3><p>{t('detail.review.description')}</p></div><div className="rating-input" role="group" aria-label={t('detail.review.ratingLabel')}>{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} aria-label={t('detail.review.ratingValue', { value: formatNumber(language, value) })} aria-pressed={reviewRating === value} className={reviewRating != null && value <= reviewRating ? 'rated' : ''} onClick={() => setReviewRating(value)}>★</button>)}<button type="button" className="clear-rating" onClick={() => setReviewRating(null)}>{t('detail.review.clear')}</button></div><label className="review-note-label">{t('detail.review.taskLabel')}<div className="task-label-row"><input list="known-tasks" maxLength={120} value={taskLabel} onChange={e => setTaskLabel(e.target.value)} placeholder={t('detail.review.taskPlaceholder')}/>{detail.session.title && <button type="button" className="secondary-button task-title-btn" onClick={() => setTaskLabel(detail.session.title ?? '')}>{t('detail.review.useTitle')}</button>}</div><datalist id="known-tasks">{comparisonGroups.map(group => <option key={group.taskLabel} value={group.taskLabel}/>)}</datalist></label><label className="review-note-label">{t('detail.review.note')}<textarea maxLength={2000} rows={3} value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder={t('detail.review.notePlaceholder')}/></label><div className="review-actions"><small>{reviewMessage ? t(reviewMessage.key, reviewMessage.params) : t('detail.review.localOnly')}</small><button onClick={() => void saveReview()} disabled={reviewSaving}>{reviewSaving ? t('common.saving') : t('detail.review.save')}</button></div></section>
      <div className="metrics"><div><span>{t('detail.metric.duration')}</span><b>{detail.metrics.durationMs == null ? t('detail.metric.running') : t('duration.seconds', { value: formatNumber(language, detail.metrics.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</b></div><div><span>{t('detail.metric.input')}</span><b>{tokenText(detail.metrics.inputTokens, t, language)}</b></div><div><span>{t('detail.metric.output')}</span><b>{tokenText(detail.metrics.outputTokens, t, language)}</b></div><div><span>{t('detail.metric.reasoning')}</span><b>{tokenText(detail.metrics.reasoningTokens, t, language)}</b></div><div><span>{t('detail.metric.cacheRead')}</span><b>{tokenText(detail.metrics.cacheReadTokens, t, language)}</b></div><div><span>{t('detail.metric.cacheWrite')}</span><b>{tokenText(detail.metrics.cacheWriteTokens, t, language)}</b></div><div><span>{t('detail.metric.reportedCost')}</span><b>{money(detail.metrics.cost, t, language)}</b></div><div><span>{t('detail.metric.quota')}</span><b>{detail.metrics.quotaCostEstimate == null ? t('common.rateUnavailable') : money(detail.metrics.quotaCostEstimate, t, language)}</b></div></div>
      {toolsUsed.length > 0 && <><h3>{t('detail.tools.title')}</h3><div className="tool-list">{toolsUsed.map(tool => <span className="tool-chip" key={tool}>{tool}</span>)}</div></>}
      <h3>{t('detail.spans.title')}</h3>{spans.length === 0 ? <p className="muted detail-note">{t('detail.spans.empty', { count: detail.events.length, value: formatNumber(language, detail.events.length) })}</p> : <div className="trace-layout"><div className="timeline waterfall" role="region" aria-label={t('detail.spans.title')} tabIndex={0}><TraceWaterfall waterfall={waterfall} selectedId={selectedSpanId} highlightedId={highlightedSpanId} onSelect={(id) => setSelectedSpanId(id)} registerRow={registerRow} /></div><SpanInspector span={selectedSpan} parent={parentSpan} /></div>}
      {errorEvents.length > 0 && <>
        <h3>{t('detail.errors.title')}</h3>
        <div className="timeline error-events">
          {errorEvents.map((event) => {
            const linked = findSpanForEvent(spans, event);
            return (
              <div className="span" key={event.id}>
                <div className="dot bad" />
                <div>
                  <b>{event.type}</b>
                  <small>{time(event.timestamp, language)}</small>
                  {safeAttributes(event.attributesJson).map(([key, value]) => (
                    <small className="attributes" key={key}>{key}: {value}</small>
                  ))}
                  {linked ? (
                    <button type="button" className="trace-link" onClick={() => {
                      setSelectedSpanId(linked.id);
                      setReveal((current) => ({ spanId: linked.id, nonce: (current?.nonce ?? 0) + 1 }));
                    }}>{t('detail.errors.openTrace')}</button>
                  ) : (
                    <small className="trace-link-missing">{t('detail.errors.noSpan')}</small>
                  )}
                </div>
                <span className="badge error">{statusLabel(t, 'error')}</span>
              </div>
            );
          })}
        </div>
      </>}
      {(detail.unrelatedEvents?.length ?? 0) > 0 && <details className="unrelated-events"><summary>{t('detail.errors.unrelated', { value: formatNumber(language, detail.unrelatedEvents!.length) })}</summary><div className="timeline">{detail.unrelatedEvents!.map(event => <div className="span" key={event.id}><div className={isErrorStatus(event.status) ? 'dot bad' : 'dot'} /><div><b>{event.type}</b><small>{time(event.timestamp, language)}</small>{safeAttributes(event.attributesJson).map(([key, value]) => <small className="attributes" key={key}>{key}: {value}</small>)}</div><span className={`badge ${event.status ?? 'ok'}`}>{statusLabel(t, event.status ?? 'ok')}</span></div>)}</div></details>}
    </> : <div className="empty compact"><div className="empty-icon">◷</div><b>{t('detail.empty.title')}</b><p>{t('detail.empty.body')}</p></div>}</div></section>
    <footer>{t('footer.text')}{systemVersion ? ` · ${t('footer.version', { protocol: systemVersion.protocolVersion, schema: systemVersion.schemaVersion })}` : ''}</footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<LanguageProvider><App /></LanguageProvider>);
