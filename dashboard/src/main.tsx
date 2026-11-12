import React from 'react';
import { createRoot } from 'react-dom/client';
import { HubConnectionBuilder } from '@microsoft/signalr';
import './style.css';

type Session = { id: string; source: string; project?: string; status: string; model?: string; startedAt: string; endedAt?: string; spanCount: number; errorCount: number; inputTokens: number; outputTokens: number };
type Span = { id: string; parentId?: string; name: string; kind: string; status: string; startedAt: string; durationMs?: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost?: number | null; quotaCostEstimate?: number | null; attributesJson: string };
type Listing = { items: Session[]; total: number; page: number; pageSize: number };
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const shortSessionId = (id: string) => id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
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
  const loadRef = React.useRef<() => Promise<void>>(async () => undefined);
  const selectedRef = React.useRef<string | null>(selected);
  const detailLoadRef = React.useRef<() => Promise<void>>(async () => undefined);

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
      if (selectedRef.current === sessionId) setDetail(next);
    } catch { /* Preserve current detail if a background refresh fails. */ }
  }, []);
  detailLoadRef.current = async () => { if (selectedRef.current) await loadDetail(selectedRef.current); };

  React.useEffect(() => { void load(); }, [load]);
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
    connection.on('telemetry.updated', (event?: { sessionId?: string }) => { setOnline(true); void loadRef.current(); if (event?.sessionId === selectedRef.current) void detailLoadRef.current(); });
    connection.onreconnected(() => { setOnline(true); void loadRef.current(); });
    connection.onclose(() => setOnline(false));
    connection.start().then(() => setOnline(true)).catch(() => setOnline(false));
    const interval = window.setInterval(() => void loadRef.current(), 10000);
    return () => { window.clearInterval(interval); void connection.stop(); };
  }, []);
  React.useEffect(() => { if (selected) void loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);
  React.useEffect(() => { setPage(1); }, [status, model, from, to, errorsOnly]);

  const sessions = listing.items;
  const spans: Span[] = detail?.spans ?? [];
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

  return <main>
    <header><div><span className="eyebrow">LOCAL AGENT TELEMETRY</span><h1>AgentScope</h1><p>Sesiones y actividad de OpenCode en tiempo real</p></div><div className="header-actions"><button className="install-button" disabled={installed} onClick={() => void installApplication()}>{installed ? 'Aplicación instalada' : 'Instalar aplicación'}</button><span className={`live ${online ? 'connected' : ''}`}><i />{online ? 'En vivo' : 'Reconectando'}</span>{installHelp && <small className="install-help">{installHelp}</small>}</div></header>
    {apiError && <div className="api-error" role="status">{apiError}</div>}
    <section className="stats"><article><span>Sesiones encontradas</span><b>{listing.total.toLocaleString()}</b></article><article><span>Errores en esta página</span><b>{sessions.reduce((a, s) => a + s.errorCount, 0)}</b></article><article><span>Duración acumulada</span><b>{duration(durationTotal)}</b></article><article><span>Spans en esta página</span><b>{sessions.reduce((a, s) => a + s.spanCount, 0)}</b></article><article><span>Tokens conocidos</span><b>{tokenTotal.toLocaleString()}</b></article></section>
    <section className="layout"><div className="panel"><div className="panel-head"><div><h2>Sesiones</h2><small>Actividad reciente</small></div><span className="result-count">{listing.total} resultados</span></div>
      <div className="filters"><label>Estado<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos</option><option value="active">Activa</option><option value="completed">Completada</option><option value="error">Error</option></select></label><label>Modelo<input placeholder="Cualquier modelo" value={model} onChange={e => setModel(e.target.value)} /></label><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label className="check-filter"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />Sólo errores</label></div>
      {apiError ? <div className="empty"><div className="empty-icon">!</div><b>API no disponible</b><p>La página ya está lista. Inicia el backend y vuelve a actualizar.</p><button onClick={() => void load()}>Reintentar</button></div> : sessions.length === 0 ? <div className="empty"><div className="empty-icon">⌁</div><b>Sin sesiones todavía</b><p>Cuando el plugin de OpenCode envíe telemetría, aparecerá aquí.</p></div> : <><div className="table-wrap"><table><thead><tr><th>SESIÓN</th><th>ESTADO</th><th>MODELO</th><th>SPANS</th><th>INICIADA</th></tr></thead><tbody>{sessions.map(s => <tr onClick={() => setSelected(s.id)} className={selected === s.id ? 'selected' : ''} key={s.id}><td><b>{s.project || s.id.slice(0, 12)}</b><small className="session-id" title={s.id}>{shortSessionId(s.id)}</small></td><td><span className={`badge ${s.status}`}>{s.status}</span>{s.errorCount > 0 && <span className="error-count">{s.errorCount} error</span>}</td><td>{s.model || '—'}</td><td>{s.spanCount}</td><td>{time(s.startedAt)}</td></tr>)}</tbody></table></div><div className="pagination"><span>Página {listing.page} de {Math.max(1, Math.ceil(listing.total / listing.pageSize))}</span><div><button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Anterior</button><button disabled={page * listing.pageSize >= listing.total} onClick={() => setPage(p => p + 1)}>Siguiente</button></div></div></>}
    </div><div className="panel detail"><div className="panel-head"><div><h2>{detail?.session?.project || 'Detalle de sesión'}</h2><small>{detail?.session?.id || 'Selecciona una sesión para ver su trace'}</small></div><button onClick={() => { void load(); if (selected) void loadDetail(selected); }}>Actualizar</button></div>{detail ? <>
      <div className="session-meta"><span className={`badge ${detail.session.status}`}>{detail.session.status}</span><span>{detail.session.source}</span><span>{detail.session.model || 'Modelo desconocido'}</span></div>
      <div className="metrics"><div><span>Duración</span><b>{detail.metrics.durationMs == null ? 'En curso' : `${(detail.metrics.durationMs / 1000).toFixed(1)} s`}</b></div><div><span>Entrada</span><b>{detail.metrics.inputTokens.toLocaleString()}</b></div><div><span>Salida</span><b>{detail.metrics.outputTokens.toLocaleString()}</b></div><div><span>Razonamiento incluido</span><b>{(detail.metrics.reasoningTokens ?? 0).toLocaleString()}</b></div><div><span>Caché leída</span><b>{(detail.metrics.cacheReadTokens ?? 0).toLocaleString()}</b></div><div><span>Caché escrita</span><b>{(detail.metrics.cacheWriteTokens ?? 0).toLocaleString()}</b></div><div><span>Costo reportado</span><b>{money(detail.metrics.cost)}</b></div><div><span>Cuota Go estimada</span><b>{money(detail.metrics.quotaCostEstimate, 'Tarifa no disponible')}</b></div></div>
      <h3>Timeline de spans</h3>{spans.length === 0 ? <p className="muted detail-note">Sin spans correlacionados. Hay {detail.events.length} eventos de sesión.</p> : <div className="timeline">{spans.map(s => <div className="span" style={{ marginLeft: `${depthOf(s) * 17}px` }} key={s.id}><div className={`dot ${s.status === 'error' ? 'bad' : ''}`} /><div><b>{s.name}</b><small>{s.kind} · {time(s.startedAt)} · {s.durationMs == null ? '—' : `${s.durationMs} ms`}</small>{(s.inputTokens > 0 || s.outputTokens > 0) && <small>{s.inputTokens.toLocaleString()} entrada · {s.outputTokens.toLocaleString()} salida · {s.reasoningTokens.toLocaleString()} razonamiento · {s.cacheReadTokens.toLocaleString()} caché leída · {s.cacheWriteTokens.toLocaleString()} caché escrita</small>}{s.cost != null && <small>Costo reportado: {money(s.cost)}</small>}{s.quotaCostEstimate != null && <small>Cuota Go estimada: {money(s.quotaCostEstimate)}</small>}{safeAttributes(s.attributesJson).length > 0 && <small className="attributes">{safeAttributes(s.attributesJson).map(([k, v]) => `${k}: ${v}`).join(' · ')}</small>}</div><span className={`badge ${s.status}`}>{s.status}</span></div>)}</div>}
      {detail.events.filter((e: any) => e.status === 'error').length > 0 && <><h3>Eventos con error</h3><div className="timeline">{detail.events.filter((e: any) => e.status === 'error').map((e: any) => <div className="span" key={e.id}><div className="dot bad"/><div><b>{e.type}</b><small>{time(e.timestamp)}</small>{safeAttributes(e.attributesJson).map(([k, v]) => <small className="attributes" key={k}>{k}: {v}</small>)}</div><span className="badge error">error</span></div>)}</div></>}
    </> : <div className="empty compact"><div className="empty-icon">◷</div><b>Explora un trace</b><p>Elige una sesión para inspeccionar el timeline, los errores y los atributos seguros.</p></div>}</div></section>
    <footer>La cuota Go es una estimación con precios del catálogo local de OpenCode. Los datos se guardan localmente; no se recopila el contenido de prompts ni respuestas.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
