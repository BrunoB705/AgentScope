import React from 'react';
import { createRoot } from 'react-dom/client';
import { HubConnectionBuilder } from '@microsoft/signalr';
import { buildWaterfall, describeQuotaProvenance, findSpanForEvent, isErrorStatus, type Waterfall } from './trace';
import { BenchmarksPage } from './benchmarks-page';
import { budgetAmountText, budgetMetricLabel, budgetPanelSummary } from './budgets';
import { buildScatterPlot, computeModelHighlights, filterModelsByMinCalls, layoutScatterLabels, type CostAxisMetric, type ModelBreakdownItem, type ValueAxisMetric } from './model-efficiency';
import './style.css';

type Session = { id: string; source: string; project?: string; title?: string; status: string; model?: string; startedAt: string; endedAt?: string; spanCount: number; errorCount: number; inputTokens: number | null; outputTokens: number | null };
type Span = { id: string; parentId?: string | null; name: string; kind: string; status: string; startedAt: string; durationMs?: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cost?: number | null; quotaCostEstimate?: number | null; quotaCatalogFetchedAt?: string | null; quotaRateSnapshot?: string | null; quotaMissingReason?: string | null; attributesJson: string };
type SessionEvent = { id: number; eventId: string; source: string; sessionId: string; timestamp: string; type: string; status?: string | null; attributesJson: string };
type SessionDetailSession = { id: string; source: string; project?: string | null; title?: string | null; status: string; model?: string | null; startedAt: string; endedAt?: string | null; updatedAt: string; rating?: number | null; reviewNote?: string | null; reviewTask?: string | null };
type SessionMetrics = { spanCount: number; errorCount: number; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cost: number | null; quotaCostEstimate: number | null; durationMs: number | null };
type TraceQuality = { status: 'complete' | 'partial'; hasSessionCreated: boolean; orphanToolSpans: number; missingDurationSpans: number; missingTokenSpans: number; unknownModelSpans: number; unrelatedEventCount: number; sourceConflictEvents?: number };
type SessionDetail = { session: SessionDetailSession; spans: Span[]; events: SessionEvent[]; unrelatedEvents?: SessionEvent[]; quality?: TraceQuality; metrics: SessionMetrics };
type SpanReveal = { spanId: string; nonce: number };
type ErrorFocus = { sessionId: string; nonce: number };
type Budget = { project: string; monthlyLimit: number; metric: 'cost' | 'quota'; spent: number | null; periodStart: string; percentage: number | null; totalSpans?: number; measuredSpans?: number; isPartial?: boolean };
type SystemVersion = { apiVersion: string; protocolVersion: number; schemaVersion: number; latestSchemaVersion: number; benchmarkWorker: string };
type ComparisonRun = { id: string; title?: string; project?: string; model?: string; status: string; rating?: number | null; note?: string; taskLabel: string; updatedAt: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; cost?: number | null; quotaCostEstimate?: number | null; tools: string[] };
type ComparisonGroup = { taskLabel: string; sessions: ComparisonRun[] };
type ToolSession = { sessionId: string; title?: string; project?: string; model?: string };
type ToolMetric = { name: string; callCount: number; errorCount: number; errorRate: number; sessionCount: number; averageDurationMs?: number | null; latestSessions: ToolSession[] };
type ToolAnalytics = { windowDays?: number | null; totalCalls: number; errorCount: number; tools: ToolMetric[] };
type ModelAnalytics = { bucket: 'day' | 'week' | 'month'; availableSources: string[]; availableModels: string[]; totals: { calls: number; totalTokens: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null; cacheEfficiency?: number | null; reportedCost?: number | null; quotaEstimate?: number | null; errorCount: number }; trend: Array<{ period: string; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null }>; agents: Array<{ name: string; calls: number; tokens: number | null; share: number | null }>; models: ModelBreakdownItem[] };
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
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const duration = (milliseconds: number) => milliseconds < 60_000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.floor(milliseconds / 60_000)} min ${Math.floor(milliseconds % 60_000 / 1000)} s`;
const money = (value?: number | null, missing = 'Sin dato') => value == null ? missing : `US$ ${value.toFixed(8)}`;
const safeAttributes = (value: string) => { try { return Object.entries(JSON.parse(value) as Record<string, string>); } catch { return []; } };
const compactNumber = (value: number) => new Intl.NumberFormat('es-UY', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const clock = (value?: string) => value ? new Date(value).toLocaleTimeString() : '—';
const spanDuration = (value?: number | null) => value == null ? 'Sin dato' : value < 1000 ? `${Math.round(value)} ms` : duration(value);
const kindLabel = (kind: string) => kind === 'inference' ? 'Modelo' : kind === 'execute_tool' ? 'Herramienta' : kind;
const tokenText = (value?: number | null) => value == null ? 'Sin dato' : value.toLocaleString();
const tokenCompact = (value?: number | null) => value == null ? 'Sin dato' : compactNumber(value);
const tokenSum = (...values: Array<number | null | undefined>) => values.every(value => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
const qualitySummary = (quality: TraceQuality) => {
  const gaps: string[] = [];
  if (!quality.hasSessionCreated) gaps.push('sin inicio de sesión');
  if (quality.orphanToolSpans > 0) gaps.push(`${quality.orphanToolSpans} tool(s) sin paso padre`);
  if (quality.missingDurationSpans > 0) gaps.push(`${quality.missingDurationSpans} span(s) sin duración`);
  if (quality.missingTokenSpans > 0) gaps.push(`${quality.missingTokenSpans} paso(s) sin tokens`);
  if (quality.unknownModelSpans > 0) gaps.push(`${quality.unknownModelSpans} paso(s) sin modelo`);
  if ((quality.sourceConflictEvents ?? 0) > 0) gaps.push(`${quality.sourceConflictEvents} evento(s) de otro origen`);
  return gaps.join(' · ');
};

type SectionIcon = 'overview' | 'monitoring' | 'tools' | 'models' | 'behavior' | 'compare';
function SectionHeader({ icon, eyebrow, title, description, actions }: { icon: SectionIcon; eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="model-analytics-header section-header"><div className="analytics-title"><span className="analytics-icon"><svg viewBox="0 0 24 24" aria-hidden="true">{icon === 'overview' ? <><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></> : icon === 'monitoring' ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></> : icon === 'tools' ? <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z"/> : icon === 'models' ? <><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/><path d="M2 19h21"/></> : icon === 'behavior' ? <path d="M3 12h4l2-7 4 14 2-7h6"/> : <><path d="M4 7h15l-3-3M20 17H5l3 3"/><path d="m16 4 3 3-3 3M8 14l-3 3 3 3"/></>}</svg></span><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div></div>{actions && <div className="section-header-actions">{actions}</div>}</div>;
}

function ScopeSelect({ scope, setScope }: { scope: ScopeFilter; setScope: (value: ScopeFilter) => void }) {
  return <select className="scope-select" aria-label="Alcance de sesiones" value={scope} onChange={event => setScope(event.target.value as ScopeFilter)}><option value="all">Todo el tráfico</option><option value="real">Trabajo real</option><option value="benchmarks">Solo pruebas</option></select>;
}

function ModelAnalyticsPage(props: {
  data: ModelAnalytics | null; error: string; bucket: 'day' | 'week' | 'month'; setBucket: (value: 'day' | 'week' | 'month') => void;
  from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void;
  source: string; setSource: (value: string) => void; model: string; setModel: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void; onRefresh: () => void;
}) {
  const { data, error, bucket, setBucket, from, to, setFrom, setTo, source, setSource, model, setModel, scope, setScope, onRefresh } = props;
  const [subView, setSubView] = React.useState<'consumption' | 'efficiency'>('consumption');
  const [costAxis, setCostAxis] = React.useState<CostAxisMetric>('quotaPerCall');
  const [valueAxis, setValueAxis] = React.useState<ValueAxisMetric>('speed');
  const [minCalls, setMinCalls] = React.useState<number>(10);
  const [hoveredModel, setHoveredModel] = React.useState<string | null>(null);
  const scatterColors = ['#72a7ff', '#66d3a4', '#f0b65c', '#bd8cff', '#ff7e82', '#4fd1c5', '#f6ad55', '#fc8181', '#a3bffa', '#9ae6b4'];
  const pct = (value?: number | null) => value == null ? 'Sin dato' : `${(value * 100).toFixed(1)}%`;
  const speedText = (value?: number | null) => value == null ? 'Sin dato' : `${value.toFixed(1)} tok/s`;
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
  const highlights = React.useMemo(() => computeModelHighlights(efficiencyModels), [efficiencyModels]);
  const scatter = React.useMemo(() => buildScatterPlot(efficiencyModels, costAxis, valueAxis), [efficiencyModels, costAxis, valueAxis]);
  const scatterLabels = React.useMemo(() => layoutScatterLabels(scatter.points), [scatter]);
  const formatXValue = (value: number) => costAxis === 'tokensPerCall' ? `${Math.round(value).toLocaleString()} tok` : costAxis === 'quotaPer1M' ? `US$ ${value.toFixed(2)}` : `US$ ${value.toFixed(4)}`;
  const formatYValue = (value: number) => valueAxis === 'speed' ? `${value.toFixed(1)} tok/s` : valueAxis === 'latency' ? `${value.toFixed(1)} s` : valueAxis === 'benchmarkJudge' ? `${value.toFixed(1)}/5` : `${value.toFixed(0)}%`;
  return <section className="model-analytics-page">
    <SectionHeader icon="models" eyebrow="ANALÍTICA" title="Modelos y contexto" description="Análisis de tokens, velocidad, eficiencia y costo observado." actions={<><div className="subview-switch" role="tablist" aria-label="Vista de modelos"><button type="button" role="tab" aria-selected={subView === 'consumption'} className={subView === 'consumption' ? 'active' : ''} onClick={() => setSubView('consumption')}>Consumo y contexto</button><button type="button" role="tab" aria-selected={subView === 'efficiency'} className={subView === 'efficiency' ? 'active' : ''} onClick={() => setSubView('efficiency')}>Eficiencia y valor</button></div><button className="rates-label" title="Se muestran costos devueltos por OpenCode y estimaciones de cuota cuando están disponibles">$ Costos observados</button></>} />
    <div className="model-filter-bar"><div className="bucket-control"><span>AGRUPAR</span>{(['day', 'week', 'month'] as const).map(value => <button key={value} className={bucket === value ? 'active' : ''} onClick={() => setBucket(value)}>{value === 'day' ? 'Día' : value === 'week' ? 'Semana' : 'Mes'}</button>)}</div><label className="date-control">Desde<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="date-control">Hasta<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><ScopeSelect scope={scope} setScope={setScope} /><button className="refresh-analytics" onClick={onRefresh}>Actualizar</button></div>
    {data && <><div className="chip-filter-row"><span>ORÍGENES</span><button className={!source ? 'selected' : ''} onClick={() => setSource('')}>Todos</button>{data.availableSources.map((item, index) => <button className={source === item ? 'selected' : ''} key={item} onClick={() => toggle(source, item, setSource)}>{item}<i style={{ background: agentColors[index % agentColors.length] }} /></button>)}</div><div className="chip-filter-row models-filter"><span>MODELOS</span><button className={!model ? 'selected' : ''} onClick={() => setModel('')}>Todos</button>{data.availableModels.map(item => <button className={model === item ? 'selected' : ''} key={item} title={item} onClick={() => toggle(model, item, setModel)}>{item}</button>)}</div></>}
    {error && <div className="api-error">{error}</div>}
    {!data ? <div className="empty comparison-empty">Cargando analítica de modelos…</div> : subView === 'consumption' ? <>
      <div className="analytics-section-label">TOTALES</div><div className="model-total-grid"><article className="model-total-card total-primary"><span>TOKENS TOTALES</span><b>{tokenText(data.totals.totalTokens)}</b><small>{data.totals.calls.toLocaleString()} llamadas de modelo</small></article><article className="model-total-card"><span>ENTRADA</span><b>{tokenCompact(data.totals.inputTokens)}</b><small>{data.totals.totalTokens && data.totals.inputTokens != null ? `${(data.totals.inputTokens / data.totals.totalTokens * 100).toFixed(1)}% del total · tokens sin caché` : 'Sin datos de entrada'}</small></article><article className="model-total-card total-output"><span>SALIDA</span><b>{tokenCompact(data.totals.outputTokens)}</b><small>{data.totals.totalTokens && data.totals.outputTokens != null ? `${(data.totals.outputTokens / data.totals.totalTokens * 100).toFixed(1)}% del total · ` : ''}{tokenText(data.totals.reasoningTokens)} de razonamiento incluido</small></article><article className="model-total-card total-cache"><span>EFICIENCIA DE CACHÉ</span><b>{data.totals.cacheEfficiency == null ? 'Sin dato' : `${(data.totals.cacheEfficiency * 100).toFixed(1)}%`}</b><small>{tokenCompact(data.totals.cacheReadTokens)} leídos · {tokenCompact(data.totals.cacheWriteTokens)} escritos</small></article></div>
      <div className="model-cost-row"><span>Costo reportado por OpenCode <b>{money(data.totals.reportedCost)}</b></span><span>Cuota Go estimada <b>{money(data.totals.quotaEstimate, 'Sin dato')}</b></span><span>Errores <b>{data.totals.errorCount.toLocaleString()}</b></span></div>
      <div className="model-analytics-grid"><article className="model-chart-card"><div className="model-card-heading"><div><h3>Consumo de tokens ({bucket === 'day' ? 'diario' : bucket === 'week' ? 'semanal' : 'mensual'})</h3><p>{tokenCompact(data.totals.totalTokens)} tokens en el período</p></div><div className="chart-legend"><span><i className="legend-total"/>Total</span><span><i className="legend-input"/>Entrada</span><span><i className="legend-output"/>Salida</span></div></div>{data.trend.length ? <div className="model-chart-wrap"><svg viewBox="0 0 780 230" role="img" aria-label="Tendencia de tokens en el período"><line x1="42" y1="30" x2="758" y2="30"/><line x1="42" y1="84" x2="758" y2="84"/><line x1="42" y1="139" x2="758" y2="139"/><line x1="42" y1="194" x2="758" y2="194"/><text x="4" y="34">{compactNumber(max)}</text><text x="4" y="88">{compactNumber(max * .67)}</text><text x="4" y="143">{compactNumber(max * .33)}</text><text x="20" y="198">0</text><polyline className="series-total" points={points(point => point.totalTokens)}/><polyline className="series-input" points={points(point => point.inputTokens)}/><polyline className="series-output" points={points(point => point.outputTokens)}/>{data.trend.map((point, index) => <circle key={`${point.period}-${index}`} cx={42 + index * (716 / Math.max(1, data.trend.length - 1))} cy={194 - (point.totalTokens ?? 0) / max * 164} r="3"><title>{time(point.period)} · {tokenText(point.totalTokens)} tokens</title></circle>)}</svg><div className="chart-period-labels"><span>{time(data.trend[0].period).split(',')[0]}</span><span>{data.trend.length > 2 ? time(data.trend[Math.floor(data.trend.length / 2)].period).split(',')[0] : ''}</span><span>{time(data.trend[data.trend.length - 1].period).split(',')[0]}</span></div></div> : <div className="empty compact">No hay consumo de modelos en este período.</div>}</article>
        <article className="agent-share-card"><div className="model-card-heading"><div><h3>Distribución por origen</h3><p>{data.agents.length} orígenes</p></div></div><div className="agent-share-content"><div className="agent-donut" style={donutStyle}><div><b>{tokenCompact(data.totals.totalTokens)}</b><small>tokens</small></div></div><div className="agent-share-legend">{data.agents.map((agent, index) => <div key={agent.name}><i style={{ background: agentColors[index % agentColors.length] }}/><span>{agent.name}</span><b>{agent.share == null ? 'Sin dato' : `${(agent.share * 100).toFixed(1)}%`}</b></div>)}</div></div></article></div>
      <article className="model-breakdown-card"><div className="model-card-heading"><div><h3>Uso por modelo</h3><p>Tokens, velocidad, fallos y datos de costo disponibles para cada modelo.</p></div></div>{data.models.length ? <div className="table-wrap"><table className="model-breakdown-table"><thead><tr><th>MODELO</th><th>LLAMADAS</th><th>TOKENS</th><th>LATENCIA</th><th>TOK/S</th><th>CACHÉ</th><th>ERRORES</th><th>COSTO REPORTADO</th><th>CUOTA GO</th><th>CUOTA / LLAMADA</th></tr></thead><tbody>{data.models.map(item => <tr key={item.name}><td><b title={item.name}>{item.name}</b><small>{item.share == null ? 'Sin dato' : `${(item.share * 100).toFixed(1)}% del total`}</small></td><td>{item.calls.toLocaleString()}</td><td>{tokenText(item.tokens)}</td><td>{spanDuration(item.averageDurationMs)}</td><td>{speedText(item.outputTokensPerSec)}</td><td>{pct(item.cacheEfficiency)}</td><td>{item.errorCount.toLocaleString()}</td><td>{money(item.reportedCost)}</td><td>{money(item.quotaEstimate, 'Sin dato')}</td><td>{money(item.quotaPerCall, 'Sin dato')}</td></tr>)}</tbody></table></div> : <div className="empty compact">No hay datos de modelo para mostrar.</div>}</article>
      <p className="analytics-footnote">Los tokens se suman desde spans de inferencia observados. El costo reportado y la cuota Go estimada son métricas distintas; los valores ausentes no se calculan ni se sustituyen por precios hipotéticos.</p>
    </> : <>
      <div className="efficiency-toolbar">
        <div className="analytics-section-label">DESTACADOS AUTOMÁTICOS</div>
        <div className="efficiency-min-calls">
          {hiddenByMinCalls > 0 && <span className="min-calls-note">Ocultos {hiddenByMinCalls} modelo(s) con &lt; {minCalls} llamadas <button type="button" className="text-button" onClick={() => setMinCalls(1)}>Ver todos</button></span>}
          <label>Mín. llamadas
            <select value={minCalls} onChange={e => setMinCalls(Number(e.target.value))}>
              <option value={1}>Todos (1+)</option>
              <option value={5}>≥ 5 llamadas</option>
              <option value={10}>≥ 10 llamadas</option>
              <option value={25}>≥ 25 llamadas</option>
              <option value={50}>≥ 50 llamadas</option>
              <option value={100}>≥ 100 llamadas</option>
              <option value={500}>≥ 500 llamadas</option>
            </select>
          </label>
        </div>
      </div>
      {highlights.length ? <div className="efficiency-highlights">{highlights.map(item => <article className="efficiency-highlight-card" key={item.id}><span>{item.label}</span><b title={item.model}>{item.model}</b><strong>{item.metricText}</strong><small>{item.sampleNote}</small></article>)}</div> : <div className="empty compact">Se necesitan al menos dos modelos con datos comparables en una misma métrica para destacar ganadores.</div>}
      <article className="model-chart-card scatter-card">
        <div className="model-card-heading">
          <div><h3>Costo y consumo vs rendimiento</h3><p>{valueAxis === 'latency' ? 'Abajo a la izquierda: menor espera a menor costo o consumo.' : 'Arriba a la izquierda: mayor rendimiento a menor costo o consumo.'}</p></div>
          <div className="scatter-controls">
            <label>Eje X<select value={costAxis} onChange={e => setCostAxis(e.target.value as CostAxisMetric)}><option value="quotaPerCall">Cuota Go / llamada</option><option value="quotaPer1M">Cuota Go / 1M tokens</option><option value="tokensPerCall">Tokens / llamada</option></select></label>
            <label>Eje Y<select value={valueAxis} onChange={e => setValueAxis(e.target.value as ValueAxisMetric)}><option value="speed">Velocidad (tok/s)</option><option value="latency">Latencia promedio (s)</option><option value="cache">Ahorro de caché (%)</option><option value="benchmarkPass">% aprobado en Pruebas</option><option value="benchmarkJudge">Nota del juez (1–5)</option></select></label>
          </div>
        </div>
        {scatter.points.length ? <div className="model-chart-wrap scatter-wrap">
          <div className="scatter-stage">
            <svg className="scatter-svg" viewBox="0 0 920 380" role="img" aria-label="Dispersión de costo contra rendimiento de modelos">
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
                <small>{pt.calls.toLocaleString()} llamadas{pt.errorCount ? ` · ${pt.errorCount} errores` : ''}</small>
              </div>;
            })()}
          </div>
          <div className="scatter-legend">{scatter.points.map((pt, idx) => <button type="button" className={`scatter-legend-item ${hoveredModel === pt.name ? 'active' : ''}`} key={pt.name} onMouseEnter={() => setHoveredModel(pt.name)} onMouseLeave={() => setHoveredModel(null)}><i style={{ background: scatterColors[idx % scatterColors.length] }}/><b title={pt.name}>{pt.name}</b><small>{formatXValue(pt.x)} · {formatYValue(pt.y)}</small></button>)}</div>
          {scatter.excludedCount > 0 && <small className="scatter-note">Se omitieron {scatter.excludedCount} modelo(s) sin dato en el eje X o Y elegido.</small>}
        </div> : <div className="empty compact">No hay modelos con ambos ejes disponibles para esta combinación.</div>}
      </article>
      <article className="model-breakdown-card"><div className="model-card-heading"><div><h3>Matriz comparativa de eficiencia y calidad automática</h3><p>Velocidad, eficiencia unitaria, estabilidad en sesiones reales y resultados de Pruebas sin puntajes inventados.</p></div></div>{efficiencyModels.length ? <div className="table-wrap"><table className="model-breakdown-table efficiency-table"><thead><tr><th>MODELO</th><th>LATENCIA</th><th>TOK/S</th><th>CACHÉ</th><th>TOKENS / LLAMADA</th><th>CUOTA / LLAMADA</th><th>CUOTA / 1M TOK</th><th>COSTO REPORTADO</th><th>SESIONES OK</th><th>PRUEBAS</th></tr></thead><tbody>{efficiencyModels.map(item => <tr key={item.name}><td><b title={item.name}>{item.name}</b><small>{item.calls.toLocaleString()} llamadas · {item.sessionCount ?? 0} sesiones</small></td><td>{spanDuration(item.averageDurationMs)}</td><td>{speedText(item.outputTokensPerSec)}</td><td>{pct(item.cacheEfficiency)}</td><td>{item.tokens != null && item.calls > 0 ? Math.round(item.tokens / item.calls).toLocaleString() : 'Sin dato'}</td><td>{money(item.quotaPerCall, 'Sin dato')}</td><td>{item.quotaPer1MTokens == null ? 'Sin dato' : `US$ ${item.quotaPer1MTokens.toFixed(2)}`}</td><td>{money(item.reportedCost)}</td><td>{pct(item.completedSessionRate)}</td><td>{item.benchmarkCases ? `${pct(item.benchmarkPassRate)} (${item.benchmarkCases})${item.benchmarkJudgeAvg != null ? ` · Juez ${item.benchmarkJudgeAvg.toFixed(1)}/5` : ''}` : 'Sin dato'}</td></tr>)}</tbody></table></div> : <div className="empty compact">No hay modelos con al menos {minCalls} llamadas en este período.</div>}</article>
      <p className="analytics-footnote">Todas las métricas provienen de spans reales y resultados automáticos de Pruebas. Cada dimensión se muestra por separado; si falta duración, costo, cuota o corridas, se indica “Sin dato”.</p>
    </>}
  </section>;
}

function BehaviorPage(props: {
  data: BehaviorReport | null; error: string; period: string; setPeriod: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void;
  onRefresh: () => void; onOpenSession: (id: string) => void;
}) {
  const { data, error, period, setPeriod, scope, setScope, onRefresh, onOpenSession } = props;
  return <section className="comparison-page behavior-page">
    <SectionHeader icon="behavior" eyebrow="DIAGNÓSTICO" title="Comportamiento" description="Sesiones que merecen una mirada." actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label="Período de análisis" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Último día</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="all">Todo el historial</option></select><button onClick={onRefresh}>Actualizar</button></div>} />
    {error && <div className="api-error">{error}</div>}
    {!data ? <div className="empty comparison-empty">Cargando comportamiento…</div> : <>
      <div className="analytics-summary"><article><span>Sesiones analizadas</span><b>{data.totals.sessions.toLocaleString()}</b></article><article><span>Sesiones marcadas</span><b>{data.totals.flaggedSessions.toLocaleString()}</b></article><article><span>Señales</span><b>{data.totals.signals.toLocaleString()}</b></article></div>
      {data.sessions.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">✓</div><b>Sin señales en este período</b><p>No hay sesiones que coincidan con los patrones detectados.</p></div> : <div className="tool-analytics-list">{data.sessions.map(session => <article className="tool-analytics-card" key={session.id}><div className="tool-analytics-heading"><div><h3>{session.title || 'Sesión sin título'}</h3><p>{[session.project, session.model].filter(Boolean).join(' · ') || 'Sin proyecto ni modelo'}</p></div><span className={`badge ${session.status}`}>{session.status}</span></div><div className="signal-list">{session.signals.map((signal, index) => <div className={`signal ${signal.severity}`} key={`${signal.kind}-${index}`}><b>{signal.title}</b><span>{signal.explanation}</span></div>)}</div><div className="behavior-actions"><button className="text-button" onClick={() => onOpenSession(session.id)}>Ver sesión</button></div></article>)}</div>}
    </>}
  </section>;
}

function OverviewPage(props: {
  data: OverviewReport | null; error: string; period: string; setPeriod: (value: string) => void;
  scope: ScopeFilter; setScope: (value: ScopeFilter) => void;
  onRefresh: () => void; onOpenSession: (id: string) => void;
}) {
  const { data, error, period, setPeriod, scope, setScope, onRefresh, onOpenSession } = props;
  const percent = (value?: number | null) => value == null ? 'Sin dato' : `${(value * 100).toFixed(1)}%`;
  return <section className="comparison-page overview-page">
    <SectionHeader icon="overview" eyebrow="MONITOREO" title="Inicio" description="Estado general de la actividad" actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label="Período del resumen" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Último día</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="all">Todo el historial</option></select><button onClick={onRefresh}>Actualizar</button></div>} />
    {error && <div className="api-error">{error}</div>}
    {!data ? <div className="empty comparison-empty">Cargando resumen…</div> : <>
      <div className="overview-kpis"><article><span>Sesiones</span><b>{data.totals.sessions.toLocaleString()}</b></article><article><span>Activas</span><b>{data.totals.active.toLocaleString()}</b></article><article><span>Completadas</span><b>{data.totals.completed.toLocaleString()}</b></article><article><span>Con error</span><b>{data.totals.error.toLocaleString()}</b></article><article><span>Interrumpidas</span><b>{data.totals.interrupted.toLocaleString()}</b></article></div>
      <div className="overview-kpis"><article><span>Tasa de éxito</span><b>{percent(data.totals.successRate)}</b></article><article><span>Duración promedio</span><b>{data.totals.averageDurationMs == null ? 'Sin dato' : duration(data.totals.averageDurationMs)}</b></article><article><span>Tokens totales</span><b>{tokenText(data.totals.totalTokens)}</b></article><article><span>Costo reportado</span><b>{money(data.totals.reportedCost, 'Sin dato')}</b></article><article><span>Cuota Go estimada</span><b>{money(data.totals.quotaEstimate, 'Sin dato')}</b></article></div>
      <div className="overview-grid">
        <article className="overview-card"><h3>Herramientas más usadas</h3>{data.topTools.length === 0 ? <div className="empty compact">Sin herramientas en este período.</div> : <div className="table-wrap"><table><thead><tr><th>HERRAMIENTA</th><th>LLAMADAS</th><th>TASA DE ERROR</th><th>SESIONES</th></tr></thead><tbody>{data.topTools.map(tool => <tr key={tool.name}><td><b>{tool.name}</b></td><td>{tool.calls.toLocaleString()}</td><td>{percent(tool.errorRate)}<small>{tool.errors.toLocaleString()} errores</small></td><td>{tool.sessions.toLocaleString()}</td></tr>)}</tbody></table></div>}</article>
        <article className="overview-card"><h3>Modelos con más tokens</h3>{data.topModels.length === 0 ? <div className="empty compact">Sin llamadas de modelo en este período.</div> : <div className="table-wrap"><table><thead><tr><th>MODELO</th><th>LLAMADAS</th><th>TOKENS</th><th>COSTO REPORTADO</th><th>CUOTA GO</th></tr></thead><tbody>{data.topModels.map(model => <tr key={model.name}><td><b>{model.name}</b></td><td>{model.calls.toLocaleString()}</td><td>{tokenText(model.totalTokens)}</td><td>{money(model.reportedCost, 'Sin dato')}</td><td>{money(model.quotaEstimate, 'Sin dato')}</td></tr>)}</tbody></table></div>}</article>
      </div>
      <article className="overview-card overview-list"><h3>Últimas sesiones</h3>{data.recentSessions.length === 0 ? <div className="empty compact">Sin sesiones en este período.</div> : <div className="table-wrap"><table><thead><tr><th>SESIÓN</th><th>PROYECTO</th><th>MODELO</th><th>ESTADO</th><th>ACTUALIZADA</th><th></th></tr></thead><tbody>{data.recentSessions.map(session => <tr key={session.id} onClick={() => onOpenSession(session.id)}><td><b title={session.title || 'Sesión sin título'}>{session.title || 'Sesión sin título'}</b></td><td>{session.project || '—'}</td><td>{session.model || '—'}</td><td><span className={`badge ${session.status}`}>{session.status}</span></td><td>{time(session.updatedAt)}</td><td><button className="text-button overview-open" onClick={event => { event.stopPropagation(); onOpenSession(session.id); }}>Ver sesión</button></td></tr>)}</tbody></table></div>}</article>
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
  return <>
    <div className="waterfall-axis">
      <span>SPAN</span>
      <span className="waterfall-scale" aria-hidden="true"><span>0</span><span>{duration(waterfall.totalMs / 2)}</span><span>{duration(waterfall.totalMs)}</span></span>
      <span>DURACIÓN</span>
    </div>
    {!waterfall.hasAnyDuration && <p className="waterfall-note">Ningún span reporta duración; las barras marcan el inicio de cada span.</p>}
    {waterfall.rows.map((row) => (
      <button
        type="button"
        key={row.span.id}
        className={['waterfall-row', selectedId === row.span.id ? 'selected' : '', highlightedId === row.span.id ? 'revealed' : ''].filter(Boolean).join(' ')}
        aria-pressed={selectedId === row.span.id}
        aria-label={`${row.span.name}, ${kindLabel(row.span.kind)}, ${row.span.status}, ${row.hasDuration ? spanDuration(row.span.durationMs) : 'sin duración'}`}
        data-span-id={row.span.id}
        title={`${row.span.name} · ${row.hasDuration ? spanDuration(row.span.durationMs) : 'Sin duración'}`}
        ref={(element) => { registerRow(row.span.id, element); }}
        onClick={() => onSelect(row.span.id)}
      >
        <span className="waterfall-label" style={{ paddingLeft: `${row.depth * 14}px` }}>
          <span className="waterfall-name">
            <span className={isErrorStatus(row.span.status) ? 'waterfall-status bad' : 'waterfall-status'} aria-hidden="true" />
            <b>{row.span.name}</b>
          </span>
          <small className="waterfall-meta">{kindLabel(row.span.kind)} · {clock(row.span.startedAt)}</small>
        </span>
        <span className="waterfall-track" aria-hidden="true">
          <i
            className={['waterfall-bar', row.span.kind, isErrorStatus(row.span.status) ? 'error' : '', row.hasDuration ? '' : 'unknown'].filter(Boolean).join(' ')}
            style={{ left: `${row.startPercent}%`, width: `${row.widthPercent}%` }}
          />
        </span>
        <span className="waterfall-duration">{row.hasDuration ? spanDuration(row.span.durationMs) : 'Sin dato'}</span>
      </button>
    ))}
  </>;
}

function SpanInspector({ span, parent }: { span: Span | null; parent: Span | null }) {
  if (!span) {
    return <aside className="span-inspector"><p className="muted">Selecciona un span del waterfall para ver su detalle.</p></aside>;
  }
  const attributes = safeAttributes(span.attributesJson);
  const errorCode = attributes.find(([key]) => key === 'error_code')?.[1];
  const model = span.kind === 'inference' ? span.name : parent?.kind === 'inference' ? parent.name : 'Sin dato';
  const start = Date.parse(span.startedAt);
  const end = span.durationMs != null && Number.isFinite(start) ? time(new Date(start + span.durationMs).toISOString()) : 'Sin dato';
  const hasTokens = span.kind === 'inference' || [span.inputTokens, span.outputTokens, span.reasoningTokens, span.cacheReadTokens, span.cacheWriteTokens].some(value => value != null);
  const quotaProvenance = describeQuotaProvenance(span);
  const totalTokens = tokenSum(span.inputTokens, span.outputTokens, span.cacheReadTokens, span.cacheWriteTokens);
  return <aside className="span-inspector">
    <div className="span-inspector-head">
      <div><span className="eyebrow">{kindLabel(span.kind)}</span><h4>{span.name}</h4></div>
      <span className={`badge ${span.status}`}>{span.status}</span>
    </div>
    {errorCode && <p className="span-error">Código de error: {errorCode}</p>}
    <dl className="span-facts">
      <div><dt>Tipo</dt><dd>{kindLabel(span.kind)}</dd></div>
      <div><dt>Modelo</dt><dd>{model}</dd></div>
      <div><dt>Inicio</dt><dd>{time(span.startedAt)}</dd></div>
      <div><dt>Fin</dt><dd>{end}</dd></div>
      <div><dt>Duración</dt><dd>{spanDuration(span.durationMs)}</dd></div>
      <div><dt>Costo reportado</dt><dd>{money(span.cost)}</dd></div>
      <div><dt>Cuota Go estimada</dt><dd>{money(span.quotaCostEstimate, 'Sin dato')}</dd></div>
      <div><dt>Procedencia de la cuota</dt><dd>{quotaProvenance ?? 'Sin dato'}</dd></div>
    </dl>
    {hasTokens ? <div className="span-tokens">
      <span className="eyebrow">TOKENS</span>
      <div className="span-token-grid">
        <div><span>Entrada</span><b>{tokenText(span.inputTokens)}</b></div>
        <div><span>Salida</span><b>{tokenText(span.outputTokens)}</b></div>
        <div><span>Razonamiento</span><b>{tokenText(span.reasoningTokens)}</b></div>
        <div><span>Caché leída</span><b>{tokenText(span.cacheReadTokens)}</b></div>
        <div><span>Caché escrita</span><b>{tokenText(span.cacheWriteTokens)}</b></div>
        <div><span>Total</span><b>{tokenText(totalTokens)}</b></div>
      </div>
      <p className="span-note">El razonamiento ya está incluido en salida.</p>
    </div> : <p className="muted">Sin tokens reportados para este span.</p>}
    {attributes.length > 0 && <div className="span-attributes">
      <span className="eyebrow">ATRIBUTOS</span>
      {attributes.map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}
    </div>}
  </aside>;
}

function App() {
  const [listing, setListing] = React.useState<Listing>({ items: [], total: 0, page: 1, pageSize: 100 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<SessionDetail | null>(null);
  const [status, setStatus] = React.useState('');
  const [model, setModel] = React.useState('');
  const [projectFilter, setProjectFilter] = React.useState('');
  const [toolFilter, setToolFilter] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [online, setOnline] = React.useState(false);
  const [apiError, setApiError] = React.useState('');
  const [installPrompt, setInstallPrompt] = React.useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [installHelp, setInstallHelp] = React.useState('');
  const [reviewRating, setReviewRating] = React.useState<number | null>(null);
  const [reviewNote, setReviewNote] = React.useState('');
  const [reviewMessage, setReviewMessage] = React.useState('');
  const [reviewSaving, setReviewSaving] = React.useState(false);
  const [budgets, setBudgets] = React.useState<Budget[]>([]);
  const [budgetProject, setBudgetProject] = React.useState('');
  const [budgetLimit, setBudgetLimit] = React.useState('');
  const [budgetMetric, setBudgetMetric] = React.useState<'cost' | 'quota'>('cost');
  const [budgetMessage, setBudgetMessage] = React.useState('');
  const [budgetSaving, setBudgetSaving] = React.useState(false);
  const [view, setView] = React.useState<'overview' | 'sessions' | 'compare' | 'tools' | 'models' | 'behavior' | 'benchmarks'>('overview');
  const [benchmarkVersion, setBenchmarkVersion] = React.useState(0);
  const [taskLabel, setTaskLabel] = React.useState('');
  const [comparisonGroups, setComparisonGroups] = React.useState<ComparisonGroup[]>([]);
  const [comparisonTask, setComparisonTask] = React.useState('');
  const [comparisonError, setComparisonError] = React.useState('');
  const [toolAnalytics, setToolAnalytics] = React.useState<ToolAnalytics | null>(null);
  const [toolWindow, setToolWindow] = React.useState('30');
  const [toolError, setToolError] = React.useState('');
  const [modelAnalytics, setModelAnalytics] = React.useState<ModelAnalytics | null>(null);
  const [modelError, setModelError] = React.useState('');
  const [modelBucket, setModelBucket] = React.useState<'day' | 'week' | 'month'>('day');
  const [modelFrom, setModelFrom] = React.useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [modelTo, setModelTo] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [modelSource, setModelSource] = React.useState('');
  const [modelName, setModelName] = React.useState('');
  const [behavior, setBehavior] = React.useState<BehaviorReport | null>(null);
  const [behaviorPeriod, setBehaviorPeriod] = React.useState('30');
  const [behaviorError, setBehaviorError] = React.useState('');
  const [overview, setOverview] = React.useState<OverviewReport | null>(null);
  const [overviewPeriod, setOverviewPeriod] = React.useState('30');
  const [overviewError, setOverviewError] = React.useState('');
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

  const load = React.useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '100' });
    if (status) params.set('status', status);
    if (model.trim()) params.set('model', model.trim());
    if (projectFilter.trim()) params.set('project', projectFilter.trim());
    if (toolFilter.trim()) params.set('tool', toolFilter.trim());
    if (errorsOnly) params.set('error', 'true');
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    if (scope !== 'all') params.set('scope', scope);
    try {
      const response = await fetch(`/api/v1/sessions?${params}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      setListing(await response.json()); setApiError('');
    } catch { setApiError('No se pudo conectar con la API. Inicia la plataforma con start.ps1.'); }
  }, [status, model, projectFilter, toolFilter, from, to, errorsOnly, page, scope]);
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setComparisonGroups(await response.json()); setComparisonError('');
    } catch { setComparisonError('No se pudieron cargar las comparaciones. Comprueba que la API esté actualizada.'); }
  }, []);
  const loadToolAnalytics = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (toolWindow !== 'all') params.set('days', toolWindow);
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/analytics/tools?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setToolAnalytics(await response.json()); setToolError('');
    } catch { setToolError('No se pudo cargar la analítica de herramientas. Comprueba que la API esté actualizada.'); }
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setModelAnalytics(await response.json()); setModelError('');
    } catch { setModelError('No se pudo cargar la analítica de modelos. Comprueba que la API esté actualizada.'); }
  }, [modelBucket, modelFrom, modelTo, modelSource, modelName, scope]);
  const loadBehavior = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (behaviorPeriod !== 'all') params.set('days', behaviorPeriod);
      if (scope !== 'all') params.set('scope', scope);
      const response = await fetch(`/api/v1/behavior?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setBehavior(await response.json()); setBehaviorError('');
    } catch { setBehaviorError('No se pudo cargar el comportamiento. Comprueba que la API esté actualizada.'); }
  }, [behaviorPeriod, scope]);
  const loadOverview = React.useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (overviewPeriod !== 'all') params.set('days', overviewPeriod);
      if (scope !== 'all') params.set('scope', scope);
      const qs = params.toString();
      const response = await fetch(`/api/v1/overview${qs ? `?${qs}` : ''}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setOverview(await response.json()); setOverviewError('');
    } catch { setOverviewError('No se pudo cargar el resumen. Comprueba que la API esté actualizada.'); }
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
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); setInstallHelp(''); };
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
  React.useEffect(() => { setPage(1); }, [status, model, projectFilter, toolFilter, from, to, errorsOnly, scope]);

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
    setInstallHelp('');
    if (!installPrompt) {
      setInstallHelp('En Edge: menú ⋯ → Aplicaciones → Instalar AgentScope.');
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  };
  const saveReview = async () => {
    if (!selected) return;
    setReviewSaving(true); setReviewMessage('');
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(selected)}/review`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: reviewRating, note: reviewNote, taskLabel }) });
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) throw new Error('La API activa no tiene la función de evaluación. En PowerShell ejecuta .\\stop.ps1 y luego .\\start.ps1.');
        if (response.status >= 500) throw new Error(`La API devolvió un error ${response.status}. Reinicia AgentScope con .\\stop.ps1 y .\\start.ps1; si persiste, revisa api-error.log.`);
        throw new Error(`La API rechazó la evaluación (HTTP ${response.status}).`);
      }
      setReviewMessage('Evaluación guardada.'); await loadDetail(selected); await loadComparisons();
    } catch (error) { setReviewMessage(error instanceof TypeError ? 'No se pudo conectar con la API. Confirma que AgentScope esté iniciado.' : error instanceof Error ? error.message : 'No se pudo guardar la evaluación.'); }
    finally { setReviewSaving(false); }
  };
  const saveBudget = async (event: React.FormEvent) => {
    event.preventDefault(); setBudgetSaving(true); setBudgetMessage('');
    try {
      const response = await fetch('/api/v1/budgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: budgetProject, monthlyLimit: Number(budgetLimit), metric: budgetMetric }) });
      if (!response.ok) throw new Error();
      setBudgetMessage('Presupuesto guardado.'); setBudgetLimit(''); await loadBudgets();
    } catch { setBudgetMessage('No se pudo guardar. Revisa el proyecto y el límite mensual.'); }
    finally { setBudgetSaving(false); }
  };
  const deleteBudget = async (project: string) => {
    try {
      const response = await fetch(`/api/v1/budgets?project=${encodeURIComponent(project)}`, { method: 'DELETE' });
      if (response.ok || response.status === 204) await loadBudgets();
    } catch { setBudgetMessage('No se pudo eliminar el presupuesto.'); }
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
      setApiError('No se pudo exportar el historial. Comprueba que la API esté activa.');
    } finally {
      setExporting(false);
    }
  };
  const deleteSession = async (sessionId: string) => {
    if (!window.confirm('¿Eliminar esta sesión, sus spans y sus eventos locales?')) return;
    setDeletingSession(true);
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) throw new Error(`API respondió ${response.status}`);
      setSelected(null);
      setDetail(null);
      await Promise.all([load(), loadBudgets()]);
    } catch {
      setApiError('No se pudo eliminar la sesión.');
    } finally {
      setDeletingSession(false);
    }
  };

  return <main>
    <header><div><span className="eyebrow">LOCAL AGENT TELEMETRY</span><h1>AgentScope</h1><p>Sesiones y actividad de OpenCode en tiempo real</p></div><div className="header-actions"><button className="install-button" disabled={installed} onClick={() => void installApplication()}>{installed ? 'Aplicación instalada' : 'Instalar aplicación'}</button><span className={`live ${online ? 'connected' : ''}`}><i />{online ? 'En vivo' : 'Reconectando'}</span>{installHelp && <small className="install-help">{installHelp}</small>}</div></header>
    <nav className="main-nav" aria-label="Secciones de AgentScope"><button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>Inicio</button><button className={view === 'sessions' ? 'active' : ''} onClick={() => setView('sessions')}>Observabilidad</button><button className={view === 'tools' ? 'active' : ''} onClick={() => setView('tools')}>Herramientas</button><button className={view === 'behavior' ? 'active' : ''} onClick={() => setView('behavior')}>Comportamiento</button><button className={view === 'models' ? 'active' : ''} onClick={() => setView('models')}>Modelos</button><button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>Comparar</button><button className={view === 'benchmarks' ? 'active' : ''} onClick={() => setView('benchmarks')}>Pruebas</button></nav>
    {systemVersion && systemVersion.protocolVersion !== 1 && <div className="api-error" role="status">Versión de protocolo incompatible: la API usa v{systemVersion.protocolVersion} y el dashboard espera v1.</div>}
    {view === 'overview' ? <OverviewPage data={overview} error={overviewError} period={overviewPeriod} setPeriod={setOverviewPeriod} scope={scope} setScope={setScope} onRefresh={() => void loadOverview()} onOpenSession={id => openSession(id)} /> : view === 'behavior' ? <BehaviorPage data={behavior} error={behaviorError} period={behaviorPeriod} setPeriod={setBehaviorPeriod} scope={scope} setScope={setScope} onRefresh={() => void loadBehavior()} onOpenSession={id => openSession(id)} /> : view === 'models' ? <ModelAnalyticsPage data={modelAnalytics} error={modelError} bucket={modelBucket} setBucket={setModelBucket} from={modelFrom} to={modelTo} setFrom={setModelFrom} setTo={setModelTo} source={modelSource} setSource={setModelSource} model={modelName} setModel={setModelName} scope={scope} setScope={setScope} onRefresh={() => void loadModelAnalytics()} /> : view === 'tools' ? <section className="comparison-page"><SectionHeader icon="tools" eyebrow="ANALÍTICA DE EJECUCIÓN" title="Analítica de herramientas" description="Uso, duración y fallos de las herramientas observadas en tus sesiones." actions={<div className="analytics-actions"><ScopeSelect scope={scope} setScope={setScope} /><select aria-label="Período de análisis" value={toolWindow} onChange={event => setToolWindow(event.target.value)}><option value="1">Último día</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="all">Todo el historial</option></select><button onClick={() => void loadToolAnalytics()}>Actualizar</button></div>} />{toolError && <div className="api-error">{toolError}</div>}{toolAnalytics && <><div className="analytics-summary"><article><span>Llamadas a herramientas</span><b>{toolAnalytics.totalCalls.toLocaleString()}</b></article><article><span>Herramientas distintas</span><b>{toolAnalytics.tools.length.toLocaleString()}</b></article><article><span>Llamadas fallidas</span><b>{toolAnalytics.errorCount.toLocaleString()}</b></article></div>{toolAnalytics.tools.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⌁</div><b>No hay herramientas en este período</b><p>Cuando OpenCode registre llamadas a herramientas, aparecerán aquí.</p></div> : <div className="tool-analytics-list">{toolAnalytics.tools.map(tool => <article className="tool-analytics-card" key={tool.name}><div className="tool-analytics-heading"><div><h3>{tool.name}</h3><p>{tool.sessionCount} sesiones · {tool.callCount} llamadas</p></div><span className={tool.errorCount ? 'tool-error-rate has-errors' : 'tool-error-rate'}>{tool.errorCount} fallos · {(tool.errorRate * 100).toFixed(1)}%</span></div><div className="tool-analytics-stats"><div><span>Duración promedio</span><b>{tool.averageDurationMs == null ? 'Sin dato' : duration(tool.averageDurationMs)}</b></div><div><span>Tasa de éxito</span><b>{((1 - tool.errorRate) * 100).toFixed(1)}%</b></div></div>{tool.latestSessions.length > 0 && <div className="tool-session-links"><span>Sesiones recientes</span>{tool.latestSessions.map(session => <button key={session.sessionId} title={session.title || 'Sesión sin título'} onClick={() => openSession(session.sessionId)}><b>{session.title || 'Sesión sin título'}</b><small>{[session.project, session.model].filter(Boolean).join(' · ') || 'Abrir sesión'}</small></button>)}</div>}</article>)}</div>}</>}</section> : view === 'compare' ? <section className="comparison-page"><SectionHeader icon="compare" eyebrow="ANÁLISIS DE RESULTADOS" title="Comparar sesiones" description="Agrupa ejecuciones de la misma tarea para revisar calidad, costo y velocidad por separado." actions={<button onClick={() => void loadComparisons()}>Actualizar</button>} />{comparisonError && <div className="api-error">{comparisonError}</div>}{comparisonGroups.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⇄</div><b>Todavía no hay tareas para comparar</b><p>Abre una sesión, asigna una misma etiqueta de tarea a cada ejecución y guarda la evaluación.</p><button onClick={() => setView('sessions')}>Ir a sesiones</button></div> : <><label className="comparison-picker">Tarea<select value={comparisonTask && comparisonGroups.some(group => group.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel} onChange={event => setComparisonTask(event.target.value)}>{comparisonGroups.map(group => <option value={group.taskLabel} key={group.taskLabel}>{group.taskLabel} · {group.sessions.length} sesiones</option>)}</select></label>{comparisonGroups.filter(group => group.taskLabel === (comparisonTask && comparisonGroups.some(item => item.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel)).map(group => <article className="comparison-group" key={group.taskLabel}><div className="comparison-group-head"><div><h3>{group.taskLabel}</h3><p>{group.sessions.length} ejecuciones con esta etiqueta</p></div></div><div className="table-wrap"><table className="comparison-table"><thead><tr><th>SESIÓN / MODELO</th><th>CALIDAD</th><th>COSTO</th><th>CUOTA GO</th><th>DURACIÓN</th><th>TOKENS</th><th>TOOLS</th></tr></thead><tbody>{group.sessions.map(run => <tr key={run.id}><td><b>{run.title || 'Sesión sin título'}</b><small>{run.model || 'Modelo desconocido'} · {time(run.updatedAt)} · {run.status}</small>{run.note && <small className="comparison-note">{run.note}</small>}</td><td>{run.rating == null ? 'Sin puntuar' : <span className="comparison-rating">{'★'.repeat(run.rating)}<small>{run.rating}/5</small></span>}</td><td>{money(run.cost)}</td><td>{money(run.quotaCostEstimate, 'Sin dato')}</td><td>{duration(run.durationMs)}</td><td>{tokenText(tokenSum(run.inputTokens, run.outputTokens))}<small>{tokenText(run.inputTokens)} entrada · {tokenText(run.outputTokens)} salida</small></td><td>{run.tools.length ? run.tools.join(', ') : '—'}</td></tr>)}</tbody></table></div></article>)}</>}</section> : view === 'benchmarks' ? <BenchmarksPage version={benchmarkVersion} onOpenSession={id => openSession(id)} /> : <><SectionHeader icon="monitoring" eyebrow="MONITOREO" title="Observabilidad" description="Sesiones, modelos y actividad de OpenCode en tiempo real." actions={<div className="section-header-actions"><ScopeSelect scope={scope} setScope={setScope} /><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportSessions()}>{exporting ? 'Exportando…' : 'Exportar JSONL'}</button></div>} />
    {apiError && <div className="api-error" role="status">{apiError}</div>}
    <section className="stats"><article><span>Sesiones encontradas</span><b>{listing.total.toLocaleString()}</b></article><article><span>Errores en esta página</span><b>{sessions.reduce((a, s) => a + s.errorCount, 0)}</b></article><article><span>Duración acumulada</span><b>{duration(durationTotal)}</b></article><article><span>Spans en esta página</span><b>{sessions.reduce((a, s) => a + s.spanCount, 0)}</b></article><article><span>Tokens reportados</span><b>{tokenText(tokenTotal)}</b></article></section>
    <details className="budgets-panel"><summary>Presupuestos locales <span>{budgetPanelSummary(budgets)}</span></summary><div className="budgets-content"><form className="budget-form" onSubmit={saveBudget}><label>Proyecto<input list="known-projects" value={budgetProject} onChange={e => setBudgetProject(e.target.value)} placeholder="Nombre del proyecto" required maxLength={120}/><datalist id="known-projects">{[...new Set(sessions.map(s => s.project).filter(Boolean))].map(project => <option key={project} value={project}/>)}</datalist></label><label>Límite mensual (US$)<input type="number" min="0.01" max="1000000" step="0.01" value={budgetLimit} onChange={e => setBudgetLimit(e.target.value)} placeholder="25.00" required/></label><label>Medición<select value={budgetMetric} onChange={e => setBudgetMetric(e.target.value as 'cost' | 'quota')}><option value="cost">Costo reportado</option><option value="quota">Cuota Go estimada</option></select></label><button disabled={budgetSaving}>{budgetSaving ? 'Guardando…' : 'Guardar límite'}</button></form>{budgetMessage && <p className="form-message" role="status">{budgetMessage}</p>}{budgets.length > 0 && <div className="budget-list">{budgets.map(budget => <article className={`budget-item ${(budget.percentage ?? 0) >= 100 ? 'over-budget' : (budget.percentage ?? 0) >= 80 ? 'near-budget' : ''}`} key={budget.project}><div className="budget-heading"><div><b>{budget.project}</b><small>{budgetMetricLabel(budget.metric)} · mes actual{budget.totalSpans ? ` · ${budget.measuredSpans ?? 0}/${budget.totalSpans} pasos con dato${budget.isPartial ? ' (parcial)' : ''}` : ''}</small></div><button className="text-button" onClick={() => void deleteBudget(budget.project)}>Eliminar</button></div><div className="budget-amount">{budgetAmountText(budget, value => money(value))}</div><div className="budget-track"><i style={{ width: `${Math.min(100, budget.percentage ?? 0)}%` }}/></div><small>{budget.percentage == null ? 'El uso aparecerá cuando haya costos disponibles.' : `${budget.percentage.toFixed(0)}% del límite${budget.percentage >= 100 ? ' · límite superado' : budget.percentage >= 80 ? ' · cerca del límite' : ''}`}</small></article>)}</div>}<p className="budget-footnote">Los límites son avisos locales por mes calendario; no detienen OpenCode ni representan cargos confirmados.</p></div></details>
    <section className="layout"><div className="panel"><div className="panel-head"><div><h2>Sesiones</h2><small>Actividad reciente</small></div><span className="result-count">{listing.total} resultados</span></div>
      <div className="filters"><label>Estado<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos</option><option value="active">Activa</option><option value="completed">Completada</option><option value="interrupted">Interrumpida</option><option value="error">Error</option></select></label><label>Modelo<input placeholder="Cualquier modelo" value={model} onChange={e => setModel(e.target.value)} /></label><label>Proyecto<input list="known-projects" placeholder="Cualquier proyecto" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} /></label><label>Herramienta<input placeholder="Ej.: bash" value={toolFilter} onChange={e => setToolFilter(e.target.value)} /></label><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label className="check-filter"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />Sólo errores</label></div>
      {apiError ? <div className="empty"><div className="empty-icon">!</div><b>API no disponible</b><p>La página ya está lista. Inicia el backend y vuelve a actualizar.</p><button onClick={() => void load()}>Reintentar</button></div> : sessions.length === 0 ? <div className="empty"><div className="empty-icon">⌁</div><b>Sin sesiones todavía</b><p>Cuando el plugin de OpenCode envíe telemetría, aparecerá aquí.</p></div> : <><div className="table-wrap sessions-table" role="region" aria-label="Lista de sesiones" tabIndex={0}><table><thead><tr><th>SESIÓN</th><th>ESTADO</th><th>MODELO</th><th>SPANS</th><th>INICIADA</th></tr></thead><tbody>{sessions.map(s => <tr onClick={() => openSession(s.id)} className={selected === s.id ? 'selected' : ''} key={s.id}><td><b title={s.title || 'Sesión sin título'}>{s.title || 'Sesión sin título'}</b></td><td><span className={`badge ${s.status}`}>{s.status}</span>{s.errorCount > 0 && (
  <button
    type="button"
    className="error-count"
    title="Abrir la sesión y seleccionar el primer span con error"
    aria-label={`Ver ${s.errorCount} ${s.errorCount === 1 ? 'error' : 'errores'} en el trace`}
    onClick={(event) => { event.stopPropagation(); openSession(s.id, true); }}
  >
    {s.errorCount} {s.errorCount === 1 ? 'error' : 'errores'}
  </button>
)}</td><td>{s.model || '—'}</td><td>{s.spanCount}</td><td>{time(s.startedAt)}</td></tr>)}</tbody></table></div><div className="pagination"><span>Página {listing.page} de {Math.max(1, Math.ceil(listing.total / listing.pageSize))}</span><div><button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Anterior</button><button disabled={page * listing.pageSize >= listing.total} onClick={() => setPage(p => p + 1)}>Siguiente</button></div></div></>}
    </div><div className="panel detail"><div className="panel-head"><div><h2>{detail?.session?.title || (detail ? 'Sesión sin título' : 'Trace de sesión')}</h2><small>{detail ? 'Trace de sesión' : 'Selecciona una sesión para ver su trace'}</small></div><div className="detail-actions"><button onClick={() => { void load(); if (selected) void loadDetail(selected); }}>Actualizar</button>{detail && <button type="button" className="danger-button" disabled={deletingSession} onClick={() => void deleteSession(detail.session.id)}>{deletingSession ? 'Eliminando…' : 'Eliminar'}</button>}</div></div>{detail ? <>
      <div className="session-meta"><span className={`badge ${detail.session.status}`}>{detail.session.status}</span><span>{detail.session.source}</span><span>{detail.session.model || 'Modelo desconocido'}</span>{detail.quality && <span className={`badge ${detail.quality.status === 'complete' ? 'completed' : 'interrupted'}`} title={detail.quality.status === 'complete' ? 'Todos los pasos reportan inicio, duración y tokens' : qualitySummary(detail.quality)}>{detail.quality.status === 'complete' ? 'Traza completa' : `Traza parcial (${qualitySummary(detail.quality)})`}</span>}</div>
      <section className="review-box"><div><h3>Evaluación de la sesión</h3><p>Califica el resultado. Usa la misma tarea en las sesiones que quieras comparar.</p></div><div className="rating-input" role="group" aria-label="Puntuación de 1 a 5">{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} aria-label={`${value} de 5`} aria-pressed={reviewRating === value} className={reviewRating != null && value <= reviewRating ? 'rated' : ''} onClick={() => setReviewRating(value)}>★</button>)}<button type="button" className="clear-rating" onClick={() => setReviewRating(null)}>Quitar</button></div><label className="review-note-label">Etiqueta de tarea<div className="task-label-row"><input list="known-tasks" maxLength={120} value={taskLabel} onChange={e => setTaskLabel(e.target.value)} placeholder="Ej.: resumir contrato"/>{detail.session.title && <button type="button" className="secondary-button task-title-btn" onClick={() => setTaskLabel(detail.session.title ?? '')}>Usar título</button>}</div><datalist id="known-tasks">{comparisonGroups.map(group => <option key={group.taskLabel} value={group.taskLabel}/>)}</datalist></label><label className="review-note-label">Nota<textarea maxLength={2000} rows={3} value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="¿Qué salió bien o qué mejorarías?"/></label><div className="review-actions"><small>{reviewMessage || 'La evaluación se guarda solo en esta instalación.'}</small><button onClick={() => void saveReview()} disabled={reviewSaving}>{reviewSaving ? 'Guardando…' : 'Guardar evaluación'}</button></div></section>
      <div className="metrics"><div><span>Duración</span><b>{detail.metrics.durationMs == null ? 'En curso' : `${(detail.metrics.durationMs / 1000).toFixed(1)} s`}</b></div><div><span>Entrada</span><b>{tokenText(detail.metrics.inputTokens)}</b></div><div><span>Salida</span><b>{tokenText(detail.metrics.outputTokens)}</b></div><div><span>Razonamiento incluido</span><b>{tokenText(detail.metrics.reasoningTokens)}</b></div><div><span>Caché leída</span><b>{tokenText(detail.metrics.cacheReadTokens)}</b></div><div><span>Caché escrita</span><b>{tokenText(detail.metrics.cacheWriteTokens)}</b></div><div><span>Costo reportado</span><b>{money(detail.metrics.cost)}</b></div><div><span>Cuota Go estimada</span><b>{money(detail.metrics.quotaCostEstimate, 'Tarifa no disponible')}</b></div></div>
      {toolsUsed.length > 0 && <><h3>Tools usadas</h3><div className="tool-list">{toolsUsed.map(tool => <span className="tool-chip" key={tool}>{tool}</span>)}</div></>}
      <h3>Spans del trace</h3>{spans.length === 0 ? <p className="muted detail-note">Sin spans correlacionados. Hay {detail.events.length} eventos de sesión.</p> : <div className="trace-layout"><div className="timeline waterfall" role="region" aria-label="Spans del trace" tabIndex={0}><TraceWaterfall waterfall={waterfall} selectedId={selectedSpanId} highlightedId={highlightedSpanId} onSelect={(id) => setSelectedSpanId(id)} registerRow={registerRow} /></div><SpanInspector span={selectedSpan} parent={parentSpan} /></div>}
      {errorEvents.length > 0 && <>
        <h3>Eventos con error</h3>
        <div className="timeline error-events">
          {errorEvents.map((event) => {
            const linked = findSpanForEvent(spans, event);
            return (
              <div className="span" key={event.id}>
                <div className="dot bad" />
                <div>
                  <b>{event.type}</b>
                  <small>{time(event.timestamp)}</small>
                  {safeAttributes(event.attributesJson).map(([key, value]) => (
                    <small className="attributes" key={key}>{key}: {value}</small>
                  ))}
                  {linked ? (
                    <button type="button" className="trace-link" onClick={() => {
                      setSelectedSpanId(linked.id);
                      setReveal((current) => ({ spanId: linked.id, nonce: (current?.nonce ?? 0) + 1 }));
                    }}>Ver en el trace</button>
                  ) : (
                    <small className="trace-link-missing">Sin span asociado</small>
                  )}
                </div>
                <span className="badge error">error</span>
              </div>
            );
          })}
        </div>
      </>}
      {(detail.unrelatedEvents?.length ?? 0) > 0 && <details className="unrelated-events"><summary>Eventos de sesión no correlacionados ({detail.unrelatedEvents!.length})</summary><div className="timeline">{detail.unrelatedEvents!.map(event => <div className="span" key={event.id}><div className={isErrorStatus(event.status) ? 'dot bad' : 'dot'} /><div><b>{event.type}</b><small>{time(event.timestamp)}</small>{safeAttributes(event.attributesJson).map(([key, value]) => <small className="attributes" key={key}>{key}: {value}</small>)}</div><span className={`badge ${event.status ?? 'ok'}`}>{event.status ?? 'ok'}</span></div>)}</div></details>}
    </> : <div className="empty compact"><div className="empty-icon">◷</div><b>Explora un trace</b><p>Elige una sesión para inspeccionar el timeline, los errores y los atributos seguros.</p></div>}</div></section>
    <footer>La cuota Go es una estimación con precios del catálogo local de OpenCode. Los datos se guardan localmente; no se recopila el contenido de prompts ni respuestas.{systemVersion ? ` · Protocolo v${systemVersion.protocolVersion} · Esquema v${systemVersion.schemaVersion}` : ''}</footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
