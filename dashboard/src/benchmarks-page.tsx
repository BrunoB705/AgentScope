import React from 'react';
import {
  combinationCount,
  filterModels,
  modelSpec,
  quotaPerPassed,
  renderMarkdown,
  summarizeByModel,
  tokenTotal,
  VARIANTS,
  type BenchmarkRun,
  type BenchmarkSuite,
} from './benchmarks';
import {
  formatDate,
  formatMoney,
  formatNumber,
  statusLabel,
  translateError,
  useLanguage,
  type Language,
  type Translate,
  type TranslationKey,
} from './i18n';

type CatalogError = { id: string; error: string; code: string; params?: Record<string, string> | null };
type SuiteResponse = { suites: BenchmarkSuite[]; errors: CatalogError[] };
type ModelsResponse = { models: string[]; error?: string | null; code?: string | null };
type RunPage = { items: BenchmarkRun[]; total: number; page: number; pageSize: number };
/** Error de la página: la clave o el `code` estable se resuelven al renderizar, en el idioma activo. */
type PageError = { key?: TranslationKey; message?: string; code?: string; params?: Record<string, string | number> };

const errorText = (t: Translate, error: PageError): string =>
  translateError(t, error.code, error.key ? t(error.key, error.params) : error.message ?? '', error.params);

const formatDuration = (milliseconds: number | null | undefined, t: Translate, language: Language): string => {
  if (milliseconds == null) return t('common.noData');
  return milliseconds < 1000
    ? t('duration.milliseconds', { value: formatNumber(language, Math.round(milliseconds), { maximumFractionDigits: 0 }) })
    : t('duration.seconds', { value: formatNumber(language, milliseconds / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
};

const money = (value: number | null | undefined, t: Translate, language: Language): string =>
  value == null ? t('common.noData') : formatMoney(language, value);

const languageLabel = (t: Translate, value: string | null | undefined): string => {
  if (value === 'es' || value === 'en') return t(`benchmarks.language.${value}` as TranslationKey);
  return value ?? '';
};

export function BenchmarksPage({ version, onOpenSession }: {
  version: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const { language, t } = useLanguage();
  const [suites, setSuites] = React.useState<BenchmarkSuite[]>([]);
  const [catalogErrors, setCatalogErrors] = React.useState<CatalogError[]>([]);
  const [models, setModels] = React.useState<string[]>([]);
  const [modelError, setModelError] = React.useState<PageError | null>(null);
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
  const [error, setError] = React.useState<PageError | null>(null);
  const [creating, setCreating] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    try {
      const [suiteResponse, modelResponse, runResponse] = await Promise.all([
        fetch('/api/v1/benchmarks/suites'),
        fetch('/api/v1/benchmarks/models'),
        fetch('/api/v1/benchmarks/runs?page=1&pageSize=20'),
      ]);
      if (!suiteResponse.ok) {
        setError({ key: 'benchmarks.load.suites', params: { status: suiteResponse.status } });
        return;
      }
      if (!modelResponse.ok) {
        setError({ key: 'benchmarks.load.models', params: { status: modelResponse.status } });
        return;
      }
      if (!runResponse.ok) {
        setError({ key: 'benchmarks.load.runs', params: { status: runResponse.status } });
        return;
      }
      const suiteData = await suiteResponse.json() as SuiteResponse;
      const modelData = await modelResponse.json() as ModelsResponse;
      const runData = await runResponse.json() as RunPage;
      setSuites(suiteData.suites);
      setCatalogErrors(suiteData.errors);
      setModels(modelData.models);
      setModelError(modelData.error ? { message: modelData.error, code: modelData.code ?? undefined } : null);
      setRuns(runData.items);
      setRunTotal(runData.total);
      setRunPage(1);
      setError(null);
    } catch {
      setError({ key: 'benchmarks.loadFailed' });
    }
  }, []);

  const loadMore = async () => {
    try {
      const next = runPage + 1;
      const response = await fetch(`/api/v1/benchmarks/runs?page=${next}&pageSize=20`);
      if (!response.ok) {
        const data = await response.json() as { error?: string; code?: string };
        setError({ message: data.error, code: data.code });
        return;
      }
      const data = await response.json() as RunPage;
      setRuns((current) => [...current, ...data.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setRunTotal(data.total);
      setRunPage(next);
    } catch {
      setError({ key: 'benchmarks.loadMoreFailed' });
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
  const viewRunLanguage = viewRun ? languageLabel(t, viewRun.language) : '';

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
      setError({ key: 'benchmarks.start.missing' });
      return;
    }
    const verdictNote = requestVerdict ? t('benchmarks.verdict.note') : '';
    if (!window.confirm(t('benchmarks.start.confirm', { value: formatNumber(language, total), note: verdictNote }))) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/benchmarks/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suite: suite.id, models: chosenModels, judge, requestVerdict, language }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string; code?: string };
        setError({ message: data.error, code: data.code, params: { suite: suite.id } });
        return;
      }
      const data = await response.json() as BenchmarkRun;
      setRuns((current) => [data, ...current]);
      setRunTotal((current) => current + 1);
      setViewRunId(data.id);
    } catch {
      setError({ key: 'benchmarks.startFailed' });
    } finally {
      setCreating(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/benchmarks/runs/${id}/cancel`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json() as { error?: string; code?: string };
        setError({ message: data.error, code: data.code });
        return;
      }
      await refreshRun(id);
    } catch {
      setError({ key: 'benchmarks.cancelFailed' });
    }
  };

  const deleteRun = async (id: string) => {
    if (!window.confirm(t('benchmarks.deleteConfirm'))) return;
    try {
      const response = await fetch(`/api/v1/benchmarks/runs/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json() as { error?: string; code?: string };
        setError({ message: data.error, code: data.code });
        return;
      }
      setRuns((current) => current.filter((run) => run.id !== id));
      setRunTotal((current) => Math.max(0, current - 1));
      if (viewRunId === id) setViewRunId('');
      setError(null);
    } catch {
      setError({ key: 'benchmarks.deleteFailed' });
    }
  };

  return <section className="model-analytics-page benchmarks-page">
    <div className="model-analytics-header section-header">
      <div className="analytics-title">
        <span className="analytics-icon" aria-hidden="true">≡</span>
        <div>
          <span className="eyebrow">{t('benchmarks.eyebrow')}</span>
          <h2>{t('benchmarks.title')}</h2>
          <p>{t('benchmarks.description')}</p>
        </div>
      </div>
      <div className="section-header-actions"><button onClick={() => void loadAll()}>{t('common.refresh')}</button></div>
    </div>

    <p className="benchmark-warning">{t('benchmarks.warning', { flag: '--auto' })}</p>
    {catalogErrors.map((item) => <p className="benchmark-warning" key={item.id}>
      {t('benchmarks.catalogError', { suite: item.id, error: translateError(t, item.code, item.error, item.params ?? undefined) })}
    </p>)}
    {error && <div className="api-error" role="status">{errorText(t, error)}</div>}

    <div className="benchmark-layout">
      <article className="benchmark-card">
        <h3>{t('benchmarks.newRun')}</h3>
        {suites.length === 0 ? <p className="benchmark-empty">{t('benchmarks.emptySuites', { path: 'benchmarks/' })}</p> : <>
          <div className="benchmark-form">
            <label>{t('benchmarks.form.suite')}
              <select value={suite?.id ?? ''} onChange={(event) => setSuiteId(event.target.value)}>
                {suites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {suite && <p className="benchmark-meta">{t('benchmarks.suiteMeta', {
              count: suite.tests.length,
              value: formatNumber(language, suite.tests.length),
              timeout: formatDuration(suite.modelTimeoutMs, t, language),
            })}</p>}

            {models.length > 0 ? <div role="group" aria-label={t('benchmarks.models.label')}>
              <span className="benchmark-meta">{t('benchmarks.models.label')}</span>
              <input className="benchmark-search" type="text" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder={t('benchmarks.models.search')} />
              <div className="benchmark-models">
                {visibleModels.length === 0 && <span className="benchmark-empty">{t('benchmarks.models.empty')}</span>}
                {visibleModels.map((model) => <div className="benchmark-model-row" key={model}>
                  <label>
                    <input type="checkbox" checked={selectedModels.includes(model)} onChange={() => toggleModel(model)} />
                    <span>{model}</span>
                  </label>
                  {selectedModels.includes(model) && <select className="benchmark-variant" value={variants[model] ?? ''} onChange={(event) => setVariants((current) => ({ ...current, [model]: event.target.value }))} aria-label={t('benchmarks.variant.label', { model })}>
                    <option value="">{t('benchmarks.variant.none')}</option>
                    {VARIANTS.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
                  </select>}
                </div>)}
              </div>
            </div> : <label>{t('benchmarks.models.manual')}
              <input type="text" value={manualModels} onChange={(event) => setManualModels(event.target.value)} placeholder={t('benchmarks.models.placeholder')} />
              {modelError && <small>{errorText(t, modelError)}</small>}
            </label>}

            <label>{t('benchmarks.judge')}
              {judgeOptions.length > 0 ? <select value={judge} onChange={(event) => setJudge(event.target.value)}>
                <option value="">{t('benchmarks.judge.placeholder')}</option>
                {judgeOptions.map((model) => <option key={model} value={model}>{model}</option>)}
              </select> : <input type="text" value={judge} onChange={(event) => setJudge(event.target.value)} placeholder={t('benchmarks.judge.manual')} />}
            </label>

            <label className="benchmark-verdict-toggle" title={t('benchmarks.verdict.toggleTitle')}>
              <input type="checkbox" checked={requestVerdict} onChange={(event) => setRequestVerdict(event.target.checked)} />
              <span>{t('benchmarks.verdict.toggle')}</span>
            </label>

            <p className="benchmark-meta">{t('benchmarks.combinations', {
              count: total,
              value: formatNumber(language, total),
              note: requestVerdict ? t('benchmarks.verdict.note') : '',
            })}</p>
            <div className="benchmark-actions">
              <button disabled={creating || total === 0 || !judge} onClick={() => void start()}>{creating ? t('benchmarks.starting') : t('benchmarks.start')}</button>
              {activeRun && <button className="benchmark-secondary" onClick={() => void cancel(activeRun.id)}>{t('benchmarks.cancel')}</button>}
            </div>
          </div>
        </>}
      </article>

      <article className="benchmark-card">
        <h3>{t('benchmarks.results')}</h3>
        {!viewRun ? <p className="benchmark-empty">{t('benchmarks.noRuns')}</p> : <>
          <div className="benchmark-run">
            <div className="benchmark-actions">
              <span className={`benchmark-status ${viewRun.status}`}>{statusLabel(t, viewRun.status)}</span>
              {viewRunLanguage && <span className="benchmark-status">{viewRunLanguage}</span>}
              <span className="benchmark-meta">{t('benchmarks.runMeta', {
                suite: viewRun.suite,
                judge: viewRun.judgeModel,
                completed: formatNumber(language, viewRun.completed),
                total: formatNumber(language, viewRun.total),
              })}</span>
              {viewRun.status !== 'queued' && viewRun.status !== 'running' && <button className="benchmark-secondary benchmark-danger" onClick={() => void deleteRun(viewRun.id)}>{t('benchmarks.deleteRun')}</button>}
            </div>
            <div className="benchmark-bar"><i style={{ width: `${viewRun.total ? viewRun.completed / viewRun.total * 100 : 0}%` }} /></div>
            {viewRun.error && <p className="benchmark-warning">{translateError(t, viewRun.errorCode ?? undefined, viewRun.error, viewRun.errorParams ?? undefined)}</p>}
            {baselineWarnings.length > 0 && <p className="benchmark-warning">{t('benchmarks.baseline', { tests: baselineWarnings.map((item) => item.test).join(', ') })}</p>}
          </div>

          {viewRun.verdict && <div className="benchmark-verdict">
            <h4>{t('benchmarks.verdict.heading')}</h4>
            <div className="benchmark-verdict-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(translateError(t, viewRun.verdictCode ?? undefined, viewRun.verdict, viewRun.verdictParams ?? undefined)) }} />
          </div>}

          <div className="table-wrap benchmark-table-wrap">
            <table className="benchmark-results">
              <thead><tr><th>{t('benchmarks.column.model')}</th><th>{t('benchmarks.column.passed')}</th><th>{t('benchmarks.column.score')}</th><th>{t('benchmarks.column.duration')}</th><th>{t('benchmarks.column.tokens')}</th><th>{t('benchmarks.column.quota')}</th><th>{t('benchmarks.column.quotaPerPassed')}</th><th>{t('benchmarks.column.errors')}</th></tr></thead>
              <tbody>{summarizeByModel(viewRun.results).map((summary) => <tr key={summary.model}>
                <td><b>{summary.model}</b></td>
                <td>{formatNumber(language, summary.passed)}/{formatNumber(language, summary.total)}</td>
                <td>{summary.judgeAverage == null ? t('common.noData') : formatNumber(language, summary.judgeAverage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                <td>{formatDuration(summary.durationMs, t, language)}</td>
                <td title={t('benchmarks.tokens.title', {
                  input: formatNumber(language, summary.inputTokens),
                  output: formatNumber(language, summary.outputTokens),
                  reasoning: formatNumber(language, summary.reasoningTokens),
                  cacheRead: formatNumber(language, summary.cacheReadTokens),
                  cacheWrite: formatNumber(language, summary.cacheWriteTokens),
                })}>{formatNumber(language, summary.totalTokens)}</td>
                <td>{money(summary.quotaCost, t, language)}</td>
                <td>{money(quotaPerPassed(summary), t, language)}</td>
                <td>{formatNumber(language, summary.errors)}</td>
              </tr>)}</tbody>
            </table>
          </div>

          <details className="benchmark-details">
            <summary>{t('benchmarks.detail')}</summary>
            <div className="benchmark-results-scroll">
              {viewRun.results.map((result) => <div className="benchmark-result-row" key={result.id}>
                <div><b>{result.testName}</b><small>{result.model}</small><small>{t('benchmarks.tokens.detail', {
                  input: formatNumber(language, result.inputTokens),
                  output: formatNumber(language, result.outputTokens),
                  reasoning: formatNumber(language, result.reasoningTokens),
                  cacheRead: formatNumber(language, result.cacheReadTokens),
                  cacheWrite: formatNumber(language, result.cacheWriteTokens),
                  total: formatNumber(language, tokenTotal(result)),
                })}</small></div>
                <div><span className={`benchmark-status ${result.status}`}>{statusLabel(t, result.status)}</span>{result.verifyPassed != null && <small>{result.verifyPassed ? t('verify.passed') : t('verify.exit', { code: result.verifyExitCode == null ? t('common.noData') : formatNumber(language, result.verifyExitCode) })}</small>}</div>
                <div>{result.judgeScore == null ? t('benchmarks.noScore') : t('benchmarks.judgeScore', { score: formatNumber(language, result.judgeScore, { maximumFractionDigits: 1 }) })}{result.judgeRationale && <small dangerouslySetInnerHTML={{ __html: renderMarkdown(result.judgeRationale) }} />}</div>
                <div>{result.sessionId && <button className="text-button overview-open" onClick={() => onOpenSession(result.sessionId!)}>{t('benchmarks.viewTrace')}</button>}
                  <small>{t('benchmarks.costs', { quota: money(result.quotaCostEstimate, t, language), cost: money(result.cost, t, language) })}</small>
                  {result.metricsError && <small>{translateError(t, result.metricsErrorCode ?? undefined, result.metricsError, result.metricsErrorParams ?? undefined)}</small>}
                  {result.error && <small>{translateError(t, result.errorCode ?? undefined, result.error, result.errorParams ?? undefined)}</small>}
                </div>
              </div>)}
            </div>
          </details>

          <div className="benchmark-history">
            <h4>{t('benchmarks.history')}</h4>
            {runs.length === 0 ? <p className="benchmark-empty">{t('benchmarks.history.empty')}</p> : runs.map((run) => {
              const runLanguage = languageLabel(t, run.language);
              const meta = {
                date: formatDate(language, run.createdAt),
                completed: formatNumber(language, run.completed),
                total: formatNumber(language, run.total),
                status: statusLabel(t, run.status),
              };
              return <button key={run.id} className={run.id === viewRun.id ? 'selected' : ''} onClick={() => setViewRunId(run.id)}>
                <b>{run.suite}</b>
                <small>{runLanguage
                  ? t('benchmarks.history.item', { ...meta, language: runLanguage })
                  : t('benchmarks.history.itemNoLanguage', meta)}</small>
              </button>;
            })}
            {runs.length < runTotal && <button className="benchmark-more" onClick={() => void loadMore()}>{t('benchmarks.loadMore')}</button>}
          </div>
        </>}
      </article>
    </div>
  </section>;
}
