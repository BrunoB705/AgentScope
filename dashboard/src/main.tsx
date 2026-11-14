import React from 'react';
import { createRoot } from 'react-dom/client';
import { HubConnectionBuilder } from '@microsoft/signalr';
import './style.css';

type Session = { id: string; source: string; project?: string; title?: string; status: string; model?: string; startedAt: string; endedAt?: string; spanCount: number; errorCount: number; inputTokens: number; outputTokens: number };
type Span = { id: string; parentId?: string; name: string; kind: string; status: string; startedAt: string; durationMs?: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost?: number | null; quotaCostEstimate?: number | null; attributesJson: string };
type Budget = { project: string; monthlyLimit: number; metric: 'cost' | 'quota'; spent: number | null; periodStart: string; percentage: number | null };
type ComparisonRun = { id: string; title?: string; project?: string; model?: string; status: string; rating?: number | null; note?: string; taskLabel: string; updatedAt: string; durationMs: number; inputTokens: number; outputTokens: number; cost?: number | null; quotaCostEstimate?: number | null; tools: string[] };
type ComparisonGroup = { taskLabel: string; sessions: ComparisonRun[] };
type ToolSession = { sessionId: string; title?: string; project?: string; model?: string };
type ToolMetric = { name: string; callCount: number; errorCount: number; errorRate: number; sessionCount: number; averageDurationMs?: number | null; latestSessions: ToolSession[] };
type ToolAnalytics = { windowDays?: number | null; totalCalls: number; errorCount: number; tools: ToolMetric[] };
type Listing = { items: Session[]; total: number; page: number; pageSize: number };
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const duration = (milliseconds: number) => milliseconds < 60_000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.floor(milliseconds / 60_000)} min ${Math.floor(milliseconds % 60_000 / 1000)} s`;
const money = (value?: number | null, missing = 'Sin dato') => value == null ? missing : `US$ ${value.toFixed(8)}`;
const safeAttributes = (value: string) => { try { return Object.entries(JSON.parse(value) as Record<string, string>); } catch { return []; } };

function App() {
  const [listing, setListing] = React.useState<Listing>({ items: [], total: 0, page: 1, pageSize: 100 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<any>(null);
  const [status, setStatus] = React.useState('');
  const [model, setModel] = React.useState('');
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
  const [view, setView] = React.useState<'sessions' | 'compare' | 'tools'>('sessions');
  const [taskLabel, setTaskLabel] = React.useState('');
  const [comparisonGroups, setComparisonGroups] = React.useState<ComparisonGroup[]>([]);
  const [comparisonTask, setComparisonTask] = React.useState('');
  const [comparisonError, setComparisonError] = React.useState('');
  const [toolAnalytics, setToolAnalytics] = React.useState<ToolAnalytics | null>(null);
  const [toolWindow, setToolWindow] = React.useState('30');
  const [toolError, setToolError] = React.useState('');
  const loadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const selectedRef = React.useRef<string | null>(selected);
  const detailLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const toolLoadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const viewRef = React.useRef(view);

  const load = React.useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '100' });
    if (status) params.set('status', status);
    if (model.trim()) params.set('model', model.trim());
    if (errorsOnly) params.set('error', 'true');
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    try {
      const response = await fetch(`/api/v1/sessions?${params}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      setListing(await response.json()); setApiError('');
    } catch { setApiError('No se pudo conectar con la API. Inicia la plataforma con start.ps1.'); }
  }, [status, model, from, to, errorsOnly, page]);
  loadRef.current = load;
  selectedRef.current = selected;
  const loadDetail = React.useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      const next = await response.json();
      if (selectedRef.current === sessionId) {
        setDetail(next);
        setReviewRating(next.session.rating ?? null);
        setReviewNote(next.session.reviewNote ?? '');
        setTaskLabel(next.session.reviewTask ?? '');
      }
    } catch { /* Preserve current detail if a background refresh fails. */ }
  }, []);
  detailLoadRef.current = async () => { if (selectedRef.current) await loadDetail(selectedRef.current); };

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
      const response = await fetch(`/api/v1/analytics/tools?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setToolAnalytics(await response.json()); setToolError('');
    } catch { setToolError('No se pudo cargar la analítica de herramientas. Comprueba que la API esté actualizada.'); }
  }, [toolWindow]);
  toolLoadRef.current = loadToolAnalytics;
  viewRef.current = view;
  React.useEffect(() => { void loadBudgets(); }, [loadBudgets]);
  React.useEffect(() => { if (view === 'compare') void loadComparisons(); }, [view, loadComparisons]);
  React.useEffect(() => { if (view === 'tools') void loadToolAnalytics(); }, [view, loadToolAnalytics]);
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
    connection.on('telemetry.updated', (event?: { sessionId?: string }) => { setOnline(true); void loadRef.current(); void loadBudgets(); if (viewRef.current === 'tools') void toolLoadRef.current(); if (event?.sessionId === selectedRef.current) void detailLoadRef.current(); });
    connection.onreconnected(() => { setOnline(true); void loadRef.current(); });
    connection.onclose(() => setOnline(false));
    connection.start().then(() => setOnline(true)).catch(() => setOnline(false));
    const interval = window.setInterval(() => { void loadRef.current(); void loadBudgets(); if (viewRef.current === 'tools') void toolLoadRef.current(); }, 10000);
    return () => { window.clearInterval(interval); void connection.stop(); };
  }, []);
  React.useEffect(() => { if (selected) void loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);
  React.useEffect(() => { setPage(1); }, [status, model, from, to, errorsOnly]);

  const sessions = listing.items;
  const spans: Span[] = detail?.spans ?? [];
  const toolsUsed = [...new Set(spans.filter(span => span.kind === 'execute_tool').map(span => span.name))];
  const depthOf = (span: Span) => { let depth = 0, parent = span.parentId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); const item = spans.find(s => s.id === parent); if (!item) break; depth++; parent = item.parentId; } return Math.min(depth, 5); };
  const tokenTotal = sessions.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
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

  return <main>
    <header><div><span className="eyebrow">LOCAL AGENT TELEMETRY</span><h1>AgentScope</h1><p>Sesiones y actividad de OpenCode en tiempo real</p></div><div className="header-actions"><button className="install-button" disabled={installed} onClick={() => void installApplication()}>{installed ? 'Aplicación instalada' : 'Instalar aplicación'}</button><span className={`live ${online ? 'connected' : ''}`}><i />{online ? 'En vivo' : 'Reconectando'}</span>{installHelp && <small className="install-help">{installHelp}</small>}</div></header>
    <nav className="main-nav" aria-label="Secciones de AgentScope"><button className={view === 'sessions' ? 'active' : ''} onClick={() => setView('sessions')}>Observabilidad</button><button className={view === 'tools' ? 'active' : ''} onClick={() => setView('tools')}>Herramientas</button><button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>Comparar</button></nav>
    {view === 'tools' ? <section className="comparison-page"><div className="comparison-heading"><div><span className="eyebrow">ANÁLISIS DE EJECUCIÓN</span><h2>Analítica de herramientas</h2><p>Uso, duración y fallos de las herramientas observadas en tus sesiones.</p></div><div className="analytics-actions"><select aria-label="Período de análisis" value={toolWindow} onChange={event => setToolWindow(event.target.value)}><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="all">Todo el historial</option></select><button onClick={() => void loadToolAnalytics()}>Actualizar</button></div></div>{toolError && <div className="api-error">{toolError}</div>}{toolAnalytics && <><div className="analytics-summary"><article><span>Llamadas a herramientas</span><b>{toolAnalytics.totalCalls.toLocaleString()}</b></article><article><span>Herramientas distintas</span><b>{toolAnalytics.tools.length.toLocaleString()}</b></article><article><span>Llamadas fallidas</span><b>{toolAnalytics.errorCount.toLocaleString()}</b></article></div>{toolAnalytics.tools.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⌁</div><b>No hay herramientas en este período</b><p>Cuando OpenCode registre llamadas a herramientas, aparecerán aquí.</p></div> : <div className="tool-analytics-list">{toolAnalytics.tools.map(tool => <article className="tool-analytics-card" key={tool.name}><div className="tool-analytics-heading"><div><h3>{tool.name}</h3><p>{tool.sessionCount} sesiones · {tool.callCount} llamadas</p></div><span className={tool.errorCount ? 'tool-error-rate has-errors' : 'tool-error-rate'}>{tool.errorCount} fallos · {(tool.errorRate * 100).toFixed(1)}%</span></div><div className="tool-analytics-stats"><div><span>Duración promedio</span><b>{tool.averageDurationMs == null ? 'Sin dato' : duration(tool.averageDurationMs)}</b></div><div><span>Tasa de éxito</span><b>{((1 - tool.errorRate) * 100).toFixed(1)}%</b></div></div>{tool.latestSessions.length > 0 && <div className="tool-session-links"><span>Sesiones recientes</span>{tool.latestSessions.map(session => <button key={session.sessionId} onClick={() => { setSelected(session.sessionId); setView('sessions'); }}><b>{session.title || 'Sesión sin título'}</b><small>{[session.project, session.model].filter(Boolean).join(' · ') || 'Abrir sesión'}</small></button>)}</div>}</article>)}</div>}</>}</section> : view === 'compare' ? <section className="comparison-page"><div className="comparison-heading"><div><span className="eyebrow">ANÁLISIS DE RESULTADOS</span><h2>Comparar sesiones</h2><p>Agrupa ejecuciones de la misma tarea para revisar calidad, costo y velocidad por separado.</p></div><button onClick={() => void loadComparisons()}>Actualizar</button></div>{comparisonError && <div className="api-error">{comparisonError}</div>}{comparisonGroups.length === 0 ? <div className="empty comparison-empty"><div className="empty-icon">⇄</div><b>Todavía no hay tareas para comparar</b><p>Abre una sesión, asigna una misma etiqueta de tarea a cada ejecución y guarda la evaluación.</p><button onClick={() => setView('sessions')}>Ir a sesiones</button></div> : <><label className="comparison-picker">Tarea<select value={comparisonTask && comparisonGroups.some(group => group.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel} onChange={event => setComparisonTask(event.target.value)}>{comparisonGroups.map(group => <option value={group.taskLabel} key={group.taskLabel}>{group.taskLabel} · {group.sessions.length} sesiones</option>)}</select></label>{comparisonGroups.filter(group => group.taskLabel === (comparisonTask && comparisonGroups.some(item => item.taskLabel === comparisonTask) ? comparisonTask : comparisonGroups[0].taskLabel)).map(group => <article className="comparison-group" key={group.taskLabel}><div className="comparison-group-head"><div><h3>{group.taskLabel}</h3><p>{group.sessions.length} ejecuciones con esta etiqueta</p></div></div><div className="table-wrap"><table className="comparison-table"><thead><tr><th>SESIÓN / MODELO</th><th>CALIDAD</th><th>COSTO</th><th>CUOTA GO</th><th>DURACIÓN</th><th>TOKENS</th><th>TOOLS</th></tr></thead><tbody>{group.sessions.map(run => <tr key={run.id}><td><b>{run.title || 'Sesión sin título'}</b><small>{run.model || 'Modelo desconocido'} · {time(run.updatedAt)} · {run.status}</small>{run.note && <small className="comparison-note">{run.note}</small>}</td><td>{run.rating == null ? 'Sin puntuar' : <span className="comparison-rating">{'★'.repeat(run.rating)}<small>{run.rating}/5</small></span>}</td><td>{money(run.cost)}</td><td>{money(run.quotaCostEstimate, 'Sin dato')}</td><td>{duration(run.durationMs)}</td><td>{(run.inputTokens + run.outputTokens).toLocaleString()}<small>{run.inputTokens.toLocaleString()} entrada · {run.outputTokens.toLocaleString()} salida</small></td><td>{run.tools.length ? run.tools.join(', ') : '—'}</td></tr>)}</tbody></table></div></article>)}</>}</section> : <>
    {apiError && <div className="api-error" role="status">{apiError}</div>}
    <section className="stats"><article><span>Sesiones encontradas</span><b>{listing.total.toLocaleString()}</b></article><article><span>Errores en esta página</span><b>{sessions.reduce((a, s) => a + s.errorCount, 0)}</b></article><article><span>Duración acumulada</span><b>{duration(durationTotal)}</b></article><article><span>Spans en esta página</span><b>{sessions.reduce((a, s) => a + s.spanCount, 0)}</b></article><article><span>Tokens conocidos</span><b>{tokenTotal.toLocaleString()}</b></article></section>
    <details className="budgets-panel"><summary>Presupuestos locales <span>{budgets.length ? `${budgets.length} configurado${budgets.length === 1 ? '' : 's'}` : 'Configura límites mensuales por proyecto'}</span></summary><div className="budgets-content"><form className="budget-form" onSubmit={saveBudget}><label>Proyecto<input list="known-projects" value={budgetProject} onChange={e => setBudgetProject(e.target.value)} placeholder="Nombre del proyecto" required maxLength={120}/><datalist id="known-projects">{[...new Set(sessions.map(s => s.project).filter(Boolean))].map(project => <option key={project} value={project}/>)}</datalist></label><label>Límite mensual (US$)<input type="number" min="0.01" max="1000000" step="0.01" value={budgetLimit} onChange={e => setBudgetLimit(e.target.value)} placeholder="25.00" required/></label><label>Medición<select value={budgetMetric} onChange={e => setBudgetMetric(e.target.value as 'cost' | 'quota')}><option value="cost">Costo reportado</option><option value="quota">Cuota Go estimada</option></select></label><button disabled={budgetSaving}>{budgetSaving ? 'Guardando…' : 'Guardar límite'}</button></form>{budgetMessage && <p className="form-message" role="status">{budgetMessage}</p>}{budgets.length > 0 && <div className="budget-list">{budgets.map(budget => <article className={`budget-item ${(budget.percentage ?? 0) >= 100 ? 'over-budget' : (budget.percentage ?? 0) >= 80 ? 'near-budget' : ''}`} key={budget.project}><div className="budget-heading"><div><b>{budget.project}</b><small>{budget.metric === 'quota' ? 'Cuota Go estimada' : 'Costo reportado'} · mes actual</small></div><button className="text-button" onClick={() => void deleteBudget(budget.project)}>Eliminar</button></div><div className="budget-amount">{budget.spent == null ? 'Sin datos de costo para este mes' : `${money(budget.spent)} de ${money(budget.monthlyLimit)}`}</div><div className="budget-track"><i style={{ width: `${Math.min(100, budget.percentage ?? 0)}%` }}/></div><small>{budget.percentage == null ? 'El uso aparecerá cuando haya costos disponibles.' : `${budget.percentage.toFixed(0)}% del límite${budget.percentage >= 100 ? ' · límite superado' : budget.percentage >= 80 ? ' · cerca del límite' : ''}`}</small></article>)}</div>}<p className="budget-footnote">Los límites son avisos locales por mes calendario; no detienen OpenCode ni representan cargos confirmados.</p></div></details>
    <section className="layout"><div className="panel"><div className="panel-head"><div><h2>Sesiones</h2><small>Actividad reciente</small></div><span className="result-count">{listing.total} resultados</span></div>
      <div className="filters"><label>Estado<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos</option><option value="active">Activa</option><option value="completed">Completada</option><option value="error">Error</option></select></label><label>Modelo<input placeholder="Cualquier modelo" value={model} onChange={e => setModel(e.target.value)} /></label><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label className="check-filter"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />Sólo errores</label></div>
      {apiError ? <div className="empty"><div className="empty-icon">!</div><b>API no disponible</b><p>La página ya está lista. Inicia el backend y vuelve a actualizar.</p><button onClick={() => void load()}>Reintentar</button></div> : sessions.length === 0 ? <div className="empty"><div className="empty-icon">⌁</div><b>Sin sesiones todavía</b><p>Cuando el plugin de OpenCode envíe telemetría, aparecerá aquí.</p></div> : <><div className="table-wrap"><table><thead><tr><th>SESIÓN</th><th>ESTADO</th><th>MODELO</th><th>SPANS</th><th>INICIADA</th></tr></thead><tbody>{sessions.map(s => <tr onClick={() => setSelected(s.id)} className={selected === s.id ? 'selected' : ''} key={s.id}><td><b title={s.title || 'Sesión sin título'}>{s.title || 'Sesión sin título'}</b></td><td><span className={`badge ${s.status}`}>{s.status}</span>{s.errorCount > 0 && <span className="error-count">{s.errorCount} error</span>}</td><td>{s.model || '—'}</td><td>{s.spanCount}</td><td>{time(s.startedAt)}</td></tr>)}</tbody></table></div><div className="pagination"><span>Página {listing.page} de {Math.max(1, Math.ceil(listing.total / listing.pageSize))}</span><div><button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Anterior</button><button disabled={page * listing.pageSize >= listing.total} onClick={() => setPage(p => p + 1)}>Siguiente</button></div></div></>}
    </div><div className="panel detail"><div className="panel-head"><div><h2>{detail?.session?.title || (detail ? 'Sesión sin título' : 'Trace de sesión')}</h2><small>{detail ? 'Trace de sesión' : 'Selecciona una sesión para ver su trace'}</small></div><button onClick={() => { void load(); if (selected) void loadDetail(selected); }}>Actualizar</button></div>{detail ? <>
      <div className="session-meta"><span className={`badge ${detail.session.status}`}>{detail.session.status}</span><span>{detail.session.source}</span><span>{detail.session.model || 'Modelo desconocido'}</span></div>
      <section className="review-box"><div><h3>Evaluación de la sesión</h3><p>Califica el resultado. Usa la misma tarea en las sesiones que quieras comparar.</p></div><div className="rating-input" role="group" aria-label="Puntuación de 1 a 5">{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} aria-label={`${value} de 5`} aria-pressed={reviewRating === value} className={reviewRating != null && value <= reviewRating ? 'rated' : ''} onClick={() => setReviewRating(value)}>★</button>)}<button type="button" className="clear-rating" onClick={() => setReviewRating(null)}>Quitar</button></div><label className="review-note-label">Etiqueta de tarea<input maxLength={120} value={taskLabel} onChange={e => setTaskLabel(e.target.value)} placeholder="Ej.: resumir contrato"/></label><label className="review-note-label">Nota<textarea maxLength={2000} rows={3} value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="¿Qué salió bien o qué mejorarías?"/></label><div className="review-actions"><small>{reviewMessage || 'La evaluación se guarda solo en esta instalación.'}</small><button onClick={() => void saveReview()} disabled={reviewSaving}>{reviewSaving ? 'Guardando…' : 'Guardar evaluación'}</button></div></section>
      <div className="metrics"><div><span>Duración</span><b>{detail.metrics.durationMs == null ? 'En curso' : `${(detail.metrics.durationMs / 1000).toFixed(1)} s`}</b></div><div><span>Entrada</span><b>{detail.metrics.inputTokens.toLocaleString()}</b></div><div><span>Salida</span><b>{detail.metrics.outputTokens.toLocaleString()}</b></div><div><span>Razonamiento incluido</span><b>{(detail.metrics.reasoningTokens ?? 0).toLocaleString()}</b></div><div><span>Caché leída</span><b>{(detail.metrics.cacheReadTokens ?? 0).toLocaleString()}</b></div><div><span>Caché escrita</span><b>{(detail.metrics.cacheWriteTokens ?? 0).toLocaleString()}</b></div><div><span>Costo reportado</span><b>{money(detail.metrics.cost)}</b></div><div><span>Cuota Go estimada</span><b>{money(detail.metrics.quotaCostEstimate, 'Tarifa no disponible')}</b></div></div>
      {toolsUsed.length > 0 && <><h3>Tools usadas</h3><div className="tool-list">{toolsUsed.map(tool => <span className="tool-chip" key={tool}>{tool}</span>)}</div></>}
      <h3>Spans del trace</h3>{spans.length === 0 ? <p className="muted detail-note">Sin spans correlacionados. Hay {detail.events.length} eventos de sesión.</p> : <div className="timeline" role="region" aria-label="Spans del trace" tabIndex={0}>{spans.map(s => <div className="span" style={{ marginLeft: `${depthOf(s) * 17}px` }} key={s.id}><div className={`dot ${s.status === 'error' ? 'bad' : ''}`} /><div><b>{s.name}</b><small>{s.kind} · {time(s.startedAt)} · {s.durationMs == null ? '—' : `${s.durationMs} ms`}</small>{(s.inputTokens > 0 || s.outputTokens > 0) && <small>{s.inputTokens.toLocaleString()} entrada · {s.outputTokens.toLocaleString()} salida · {s.reasoningTokens.toLocaleString()} razonamiento · {s.cacheReadTokens.toLocaleString()} caché leída · {s.cacheWriteTokens.toLocaleString()} caché escrita</small>}{s.cost != null && <small>Costo reportado: {money(s.cost)}</small>}{s.quotaCostEstimate != null && <small>Cuota Go estimada: {money(s.quotaCostEstimate)}</small>}{safeAttributes(s.attributesJson).length > 0 && <small className="attributes">{safeAttributes(s.attributesJson).map(([k, v]) => `${k}: ${v}`).join(' · ')}</small>}</div><span className={`badge ${s.status}`}>{s.status}</span></div>)}</div>}
      {detail.events.filter((e: any) => e.status === 'error').length > 0 && <><h3>Eventos con error</h3><div className="timeline">{detail.events.filter((e: any) => e.status === 'error').map((e: any) => <div className="span" key={e.id}><div className="dot bad"/><div><b>{e.type}</b><small>{time(e.timestamp)}</small>{safeAttributes(e.attributesJson).map(([k, v]) => <small className="attributes" key={k}>{k}: {v}</small>)}</div><span className="badge error">error</span></div>)}</div></>}
    </> : <div className="empty compact"><div className="empty-icon">◷</div><b>Explora un trace</b><p>Elige una sesión para inspeccionar el timeline, los errores y los atributos seguros.</p></div>}</div></section>
    <footer>La cuota Go es una estimación con precios del catálogo local de OpenCode. Los datos se guardan localmente; no se recopila el contenido de prompts ni respuestas.</footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
