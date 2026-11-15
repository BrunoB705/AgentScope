import React from 'react';
import {
  combinationCount,
  filterModels,
  modelSpec,
  quotaPerPassed,
  summarizeByModel,
  VARIANTS,
  type BenchmarkRun,
  type BenchmarkSuite,
} from './benchmarks';

type CatalogError = { id: string; error: string };
type SuiteResponse = { suites: BenchmarkSuite[]; errors: CatalogError[] };
type ModelsResponse = { models: string[]; error?: string | null };
type RunPage = { items: BenchmarkRun[]; total: number; page: number; pageSize: number };

const formatDuration = (milliseconds?: number | null) => {
  if (milliseconds == null) return 'Sin dato';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
};

const formatMoney = (value?: number | null) => value == null ? 'Sin dato' : `US$ ${value.toFixed(8)}`;

const statusLabel = (status: string) => status === 'completed' ? 'completada' : status;

export function BenchmarksPage({ version, onOpenSession }: {
  version: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const [suites, setSuites] = React.useState<BenchmarkSuite[]>([]);
  const [catalogErrors, setCatalogErrors] = React.useState<CatalogError[]>([]);
  const [models, setModels] = React.useState<string[]>([]);
  const [modelError, setModelError] = React.useState('');
  const [runs, setRuns] = React.useState<BenchmarkRun[]>([]);
  const [runTotal, setRunTotal] = React.useState(0);
  const [runPage, setRunPage] = React.useState(1);
  const [suiteId, setSuiteId] = React.useState('');
  const [selectedModels, setSelectedModels] = React.useState<string[]>([]);
  const [variants, setVariants] = React.useState<Record<string, string>>({});
  const [modelSearch, setModelSearch] = React.useState('');
  const [judge, setJudge] = React.useState('');
  const [manualModels, setManualModels] = React.useState('');
  const [requestVerdict, setRequestVerdict] = React.useState(true);
  const [viewRunId, setViewRunId] = React.useState('');
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    try {
      const [suiteResponse, modelResponse, runResponse] = await Promise.all([
        fetch('/api/v1/benchmarks/suites'),
        fetch('/api/v1/benchmarks/models'),
        fetch('/api/v1/benchmarks/runs?page=1&pageSize=20'),
      ]);
      if (!suiteResponse.ok) throw new Error(`Suites: HTTP ${suiteResponse.status}`);
      if (!modelResponse.ok) throw new Error(`Modelos: HTTP ${modelResponse.status}`);
      if (!runResponse.ok) throw new Error(`Corridas: HTTP ${runResponse.status}`);
      const suiteData = await suiteResponse.json() as SuiteResponse;
      const modelData = await modelResponse.json() as ModelsResponse;
      const runData = await runResponse.json() as RunPage;
      setSuites(suiteData.suites);
      setCatalogErrors(suiteData.errors);
      setModels(modelData.models);
      setModelError(modelData.error ?? '');
      setRuns(runData.items);
      setRunTotal(runData.total);
      setRunPage(1);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudieron cargar las pruebas.');
    }
  }, []);

  const loadMore = async () => {
    try {
      const next = runPage + 1;
      const response = await fetch(`/api/v1/benchmarks/runs?page=${next}&pageSize=20`);
      if (!response.ok) throw new Error(`Corridas: HTTP ${response.status}`);
      const data = await response.json() as RunPage;
      setRuns((current) => [...current, ...data.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setRunTotal(data.total);
      setRunPage(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo cargar más historial.');
    }
  };

  const refreshRun = React.useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/v1/benchmarks/runs/${id}`);
      if (!response.ok) return;
      const run = await response.json() as BenchmarkRun;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch {
      // La próxima actualización vuelve a intentar.
    }
  }, []);

  React.useEffect(() => { void loadAll(); }, [loadAll, version]);

  React.useEffect(() => {
    if (suites.length > 0 && !suites.some((item) => item.id === suiteId)) setSuiteId(suites[0].id);
  }, [suites, suiteId]);

  const suite = suites.find((item) => item.id === suiteId) ?? suites[0] ?? null;

  React.useEffect(() => {
    if (suite?.defaultJudge) setJudge((current) => current || suite.defaultJudge || '');
  }, [suite?.id]);

  React.useEffect(() => {
    if (judge && selectedModels.includes(judge)) setJudge('');
  }, [judge, selectedModels]);

  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running') ?? null;
  const viewRun = runs.find((run) => run.id === viewRunId) ?? activeRun ?? runs[0] ?? null;

  React.useEffect(() => {
    if (!activeRun) return;
    const id = activeRun.id;
    const interval = window.setInterval(() => { void refreshRun(id); }, 2000);
    return () => window.clearInterval(interval);
  }, [activeRun?.id, activeRun?.status, refreshRun]);

  const manualList = manualModels.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  const chosenModels = models.length > 0
    ? selectedModels.map((model) => modelSpec(model, variants[model]))
    : manualList;
  const total = suite ? combinationCount(suite, chosenModels) : 0;
  const visibleModels = filterModels(models, modelSearch);
  const judgeOptions = models.filter((model) => !selectedModels.includes(model));
  if (judge && !judgeOptions.includes(judge)) judgeOptions.unshift(judge);
  const baselineWarnings = React.useMemo(() => {
    if (!viewRun?.baselineJson) return [] as { test: string; passed: boolean }[];
    try {
      const items = JSON.parse(viewRun.baselineJson) as { test: string; passed: boolean }[];
      return items.filter((item) => item.passed);
    } catch {
      return [] as { test: string; passed: boolean }[];
    }
  }, [viewRun?.baselineJson]);

  const toggleModel = (model: string) => {
    setSelectedModels((current) => current.includes(model)
      ? current.filter((item) => item !== model)
      : [...current, model]);
  };

  const start = async () => {
    if (!suite || chosenModels.length === 0 || !judge) {
      setError('Elegí una suite, al menos un modelo y un juez.');
      return;
    }
    const verdictNote = requestVerdict ? ' + 1 recomendación final' : '';
    if (!window.confirm(`Se van a ejecutar ${total} combinaciones${verdictNote}. Esto consume cuota real de los modelos. ¿Continuar?`)) return;
    setCreating(true);
    setError('');
    try {
      const response = await fetch('/api/v1/benchmarks/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suite: suite.id, models: chosenModels, judge, requestVerdict }),
      });
      const data = await response.json() as BenchmarkRun & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRuns((current) => [data, ...current]);
      setRunTotal((current) => current + 1);
      setViewRunId(data.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo iniciar la corrida.');
    } finally {
      setCreating(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/benchmarks/runs/${id}/cancel`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      await refreshRun(id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo cancelar la corrida.');
    }
  };

  return <section className="model-analytics-page benchmarks-page">
    <div className="model-analytics-header section-header">
      <div className="analytics-title">
        <span className="analytics-icon" aria-hidden="true">≡</span>
        <div>
          <span className="eyebrow">PRUEBAS</span>
          <h2>Pruebas de modelos</h2>
          <p>La misma suite contra varios modelos, con un juez aparte.</p>
        </div>
      </div>
      <div className="section-header-actions"><button onClick={() => void loadAll()}>Actualizar</button></div>
    </div>

    <p className="benchmark-warning">Contención best-effort: las corridas usan tu usuario y <code>--auto</code>. No hay sandbox; no ejecutes pruebas que no confíes.</p>
    {catalogErrors.map((item) => <p className="benchmark-warning" key={item.id}>Suite <b>{item.id}</b>: {item.error}</p>)}
    {error && <div className="api-error" role="status">{error}</div>}

    <div className="benchmark-layout">
      <article className="benchmark-card">
        <h3>Nueva corrida</h3>
        {suites.length === 0 ? <p className="benchmark-empty">No hay suites en <code>benchmarks/</code>.</p> : <>
          <div className="benchmark-form">
            <label>Suite
              <select value={suite?.id ?? ''} onChange={(event) => setSuiteId(event.target.value)}>
                {suites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {suite && <p className="benchmark-meta">{suite.tests.length} pruebas · timeout de modelo {formatDuration(suite.modelTimeoutMs)}</p>}

            {models.length > 0 ? <div role="group" aria-label="Modelos a comparar">
              <span className="benchmark-meta">Modelos a comparar</span>
              <input className="benchmark-search" type="text" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Buscar modelo por nombre" />
              <div className="benchmark-models">
                {visibleModels.length === 0 && <span className="benchmark-empty">Ningún modelo coincide con la búsqueda.</span>}
                {visibleModels.map((model) => <div className="benchmark-model-row" key={model}>
                  <label>
                    <input type="checkbox" checked={selectedModels.includes(model)} onChange={() => toggleModel(model)} />
                    <span>{model}</span>
                  </label>
                  {selectedModels.includes(model) && <select className="benchmark-variant" value={variants[model] ?? ''} onChange={(event) => setVariants((current) => ({ ...current, [model]: event.target.value }))} aria-label={`Variante de ${model}`}>
                    <option value="">Sin variante</option>
                    {VARIANTS.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
                  </select>}
                </div>)}
              </div>
            </div> : <label>Modelos
              <input type="text" value={manualModels} onChange={(event) => setManualModels(event.target.value)} placeholder="proveedor/modelo, proveedor/otro" />
              {modelError && <small>{modelError}</small>}
            </label>}

            <label>Juez
              {judgeOptions.length > 0 ? <select value={judge} onChange={(event) => setJudge(event.target.value)}>
                <option value="">Elegí un juez</option>
                {judgeOptions.map((model) => <option key={model} value={model}>{model}</option>)}
              </select> : <input type="text" value={judge} onChange={(event) => setJudge(event.target.value)} placeholder="proveedor/modelo" />}
            </label>

            <label className="benchmark-verdict-toggle" title="Una llamada extra al juez que recomienda el mejor modelo de la corrida">
              <input type="checkbox" checked={requestVerdict} onChange={(event) => setRequestVerdict(event.target.checked)} />
              <span>Pedir recomendación final del juez (+1 llamada)</span>
            </label>

            <p className="benchmark-meta">{total} combinaciones{requestVerdict ? ' + 1 recomendación final' : ''}</p>
            <div className="benchmark-actions">
              <button disabled={creating || total === 0 || !judge} onClick={() => void start()}>{creating ? 'Iniciando…' : 'Correr'}</button>
              {activeRun && <button className="benchmark-secondary" onClick={() => void cancel(activeRun.id)}>Cancelar corrida</button>}
            </div>
          </div>
        </>}
      </article>

      <article className="benchmark-card">
        <h3>Resultados</h3>
        {!viewRun ? <p className="benchmark-empty">Todavía no hay corridas.</p> : <>
          <div className="benchmark-run">
            <div className="benchmark-actions">
              <span className={`benchmark-status ${viewRun.status}`}>{statusLabel(viewRun.status)}</span>
              <span className="benchmark-meta">Suite {viewRun.suite} · juez {viewRun.judgeModel} · {viewRun.completed}/{viewRun.total}</span>
            </div>
            <div className="benchmark-bar"><i style={{ width: `${viewRun.total ? viewRun.completed / viewRun.total * 100 : 0}%` }} /></div>
            {viewRun.error && <p className="benchmark-warning">{viewRun.error}</p>}
            {baselineWarnings.length > 0 && <p className="benchmark-warning">Línea base: {baselineWarnings.map((item) => item.test).join(', ')} ya pasa sobre el fixture limpio; la prueba no distingue.</p>}
          </div>

          {viewRun.verdict && <div className="benchmark-verdict">
            <h4>Recomendación del juez</h4>
            <p>{viewRun.verdict}</p>
          </div>}

          <div className="table-wrap benchmark-table-wrap">
            <table className="benchmark-results">
              <thead><tr><th>MODELO</th><th>APROBADAS</th><th>NOTA</th><th>DURACIÓN</th><th>TOKENS</th><th>CUOTA GO</th><th>CUOTA/APROBADA</th><th>ERRORES</th></tr></thead>
              <tbody>{summarizeByModel(viewRun.results).map((summary) => <tr key={summary.model}>
                <td><b>{summary.model}</b></td>
                <td>{summary.passed}/{summary.total}</td>
                <td>{summary.judgeAverage == null ? 'Sin dato' : summary.judgeAverage.toFixed(1)}</td>
                <td>{formatDuration(summary.durationMs)}</td>
                <td>{(summary.inputTokens + summary.outputTokens).toLocaleString()}</td>
                <td>{formatMoney(summary.quotaCost)}</td>
                <td>{formatMoney(quotaPerPassed(summary))}</td>
                <td>{summary.errors}</td>
              </tr>)}</tbody>
            </table>
          </div>

          <details className="benchmark-details">
            <summary>Detalle por prueba</summary>
            <div className="benchmark-results-scroll">
              {viewRun.results.map((result) => <div className="benchmark-result-row" key={result.id}>
                <div><b>{result.testName}</b><small>{result.model}</small></div>
                <div><span className={`benchmark-status ${result.status}`}>{result.status}</span>{result.verifyPassed != null && <small>{result.verifyPassed ? 'verify OK' : `verify ${result.verifyExitCode}`}</small>}</div>
                <div>{result.judgeScore == null ? 'Sin nota' : `Juez ${result.judgeScore}/5`}{result.judgeRationale && <small>{result.judgeRationale}</small>}</div>
                <div>{result.sessionId && <button className="text-button overview-open" onClick={() => onOpenSession(result.sessionId!)}>Ver trace</button>}
                  <small>Cuota Go: {formatMoney(result.quotaCostEstimate)} · Reportado: {formatMoney(result.cost)}</small>
                  {result.metricsError && <small>{result.metricsError}</small>}
                  {result.error && <small>{result.error}</small>}
                </div>
              </div>)}
            </div>
          </details>

          <div className="benchmark-history">
            <h4>Historial</h4>
            {runs.length === 0 ? <p className="benchmark-empty">Sin corridas.</p> : runs.map((run) => <button key={run.id} className={run.id === viewRun.id ? 'selected' : ''} onClick={() => setViewRunId(run.id)}>
              <b>{run.suite}</b>
              <small>{new Date(run.createdAt).toLocaleString()} · {run.completed}/{run.total} · {run.status}</small>
            </button>)}
            {runs.length < runTotal && <button className="benchmark-more" onClick={() => void loadMore()}>Cargar más</button>}
          </div>
        </>}
      </article>
    </div>
  </section>;
}
