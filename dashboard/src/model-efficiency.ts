export type CostAxisMetric = 'quotaPerCall' | 'quotaPer1M' | 'tokensPerCall';
export type ValueAxisMetric = 'speed' | 'latency' | 'cache' | 'benchmarkPass' | 'benchmarkJudge';

export type ModelBreakdownItem = {
  name: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  tokens: number | null;
  share: number | null;
  reportedCost?: number | null;
  quotaEstimate?: number | null;
  errorCount: number;
  averageDurationMs?: number | null;
  outputTokensPerSec?: number | null;
  cacheEfficiency?: number | null;
  reportedCostPerCall?: number | null;
  reportedCostPer1MTokens?: number | null;
  quotaPerCall?: number | null;
  quotaPer1MTokens?: number | null;
  sessionCount?: number;
  callSuccessRate?: number | null;
  completedSessionRate?: number | null;
  benchmarkCases?: number;
  benchmarkPassRate?: number | null;
  benchmarkJudgeAvg?: number | null;
};

export type EfficiencyHighlight = {
  id: string;
  label: string;
  model: string;
  metricText: string;
  sampleNote: string;
};

export type ScatterPoint = {
  name: string;
  x: number;
  y: number;
  xNorm: number;
  yNorm: number;
  calls: number;
  errorCount: number;
};

export type ScatterPlot = {
  points: ScatterPoint[];
  xMax: number;
  yMax: number;
  excludedCount: number;
};

function pickHighlight(
  models: ReadonlyArray<ModelBreakdownItem>,
  id: string,
  label: string,
  direction: 'min' | 'max',
  select: (item: ModelBreakdownItem) => number | null | undefined,
  format: (value: number) => string,
  requirePositive = false,
): EfficiencyHighlight | null {
  const candidates = models
    .map(item => ({ item, value: select(item) }))
    .filter((entry): entry is { item: ModelBreakdownItem; value: number } =>
      typeof entry.value === 'number' && Number.isFinite(entry.value) && (!requirePositive || entry.value > 0));
  if (candidates.length < 2) return null;
  candidates.sort((a, b) => (direction === 'min' ? a.value - b.value : b.value - a.value) || b.item.calls - a.item.calls);
  const winner = candidates[0];
  return {
    id,
    label,
    model: winner.item.name,
    metricText: format(winner.value),
    sampleNote: `Comparado entre ${candidates.length} modelos con dato`,
  };
}

/** Filtra modelos con muestra suficiente para evitar sesgos de pocas llamadas. */
export function filterModelsByMinCalls(models: ReadonlyArray<ModelBreakdownItem>, minCalls: number): ModelBreakdownItem[] {
  const threshold = Number.isFinite(minCalls) && minCalls > 1 ? minCalls : 0;
  return threshold === 0 ? [...models] : models.filter(item => item.calls >= threshold);
}

/** Calcula ganadores objetivos por dimensión separada; exige al menos dos modelos comparables. */
export function computeModelHighlights(models: ReadonlyArray<ModelBreakdownItem>): EfficiencyHighlight[] {
  const candidates = [
    pickHighlight(models, 'fastest', 'Más rápido (latencia)', 'min', m => m.averageDurationMs, v => `${(v / 1000).toFixed(2)} s / paso`, true),
    pickHighlight(models, 'throughput', 'Mayor velocidad de salida', 'max', m => m.outputTokensPerSec, v => `${v.toFixed(1)} tok/s`, true),
    pickHighlight(models, 'cache', 'Mejor ahorro de caché', 'max', m => m.cacheEfficiency, v => `${(v * 100).toFixed(1)}%`),
    pickHighlight(models, 'cheapestQuota', 'Menor cuota Go / llamada', 'min', m => m.quotaPerCall, v => `≈ US$ ${v.toFixed(6)}`, true),
    pickHighlight(models, 'cheapestQuota1M', 'Menor cuota Go / 1M tok', 'min', m => m.quotaPer1MTokens, v => `≈ US$ ${v.toFixed(2)}`, true),
    pickHighlight(models, 'cheapestCost', 'Menor costo / llamada', 'min', m => m.reportedCostPerCall, v => `US$ ${v.toFixed(6)}`, true),
    pickHighlight(models, 'benchmarkPass', 'Mayor aprobación en Pruebas', 'max', m => m.benchmarkPassRate, v => `${(v * 100).toFixed(0)}%`),
  ];
  return candidates.filter((item): item is EfficiencyHighlight => item !== null);
}

/** Construye puntos normalizados en [0, 1] para dispersión costo/consumo vs rendimiento/calidad. */
export function buildScatterPlot(
  models: ReadonlyArray<ModelBreakdownItem>,
  costAxis: CostAxisMetric,
  valueAxis: ValueAxisMetric,
): ScatterPlot {
  const xOf = (m: ModelBreakdownItem) => {
    if (costAxis === 'quotaPerCall') return m.quotaPerCall;
    if (costAxis === 'quotaPer1M') return m.quotaPer1MTokens;
    return m.tokens != null && m.calls > 0 ? m.tokens / m.calls : null;
  };
  const yOf = (m: ModelBreakdownItem) => {
    if (valueAxis === 'speed') return m.outputTokensPerSec;
    if (valueAxis === 'latency') return typeof m.averageDurationMs === 'number' && m.averageDurationMs > 0 ? m.averageDurationMs / 1000 : null;
    if (valueAxis === 'cache') return typeof m.cacheEfficiency === 'number' ? m.cacheEfficiency * 100 : null;
    if (valueAxis === 'benchmarkPass') return typeof m.benchmarkPassRate === 'number' ? m.benchmarkPassRate * 100 : null;
    return m.benchmarkJudgeAvg;
  };
  const valid = models
    .map(m => ({ m, x: xOf(m), y: yOf(m) }))
    .filter((entry): entry is { m: ModelBreakdownItem; x: number; y: number } =>
      typeof entry.x === 'number' && Number.isFinite(entry.x) && typeof entry.y === 'number' && Number.isFinite(entry.y));
  const excludedCount = models.length - valid.length;
  if (!valid.length) return { points: [], xMax: 0, yMax: 0, excludedCount };

  const xMax = Math.max(...valid.map(entry => entry.x));
  const yMax = valueAxis === 'cache' || valueAxis === 'benchmarkPass'
    ? 100
    : valueAxis === 'benchmarkJudge'
      ? 5
      : Math.max(...valid.map(entry => entry.y));
  return {
    xMax,
    yMax,
    excludedCount,
    points: valid.map(({ m, x, y }) => ({
      name: m.name,
      x,
      y,
      xNorm: xMax > 0 ? x / xMax : 0.5,
      yNorm: yMax > 0 ? y / yMax : 0.5,
      calls: m.calls,
      errorCount: m.errorCount,
    })),
  };
}

export type ScatterLabel = {
  name: string;
  label: string;
  cx: number;
  cy: number;
  x: number;
  y: number;
  anchor: 'start' | 'end' | 'middle';
  needsLeader: boolean;
  leaderX: number;
  leaderY: number;
  box: { x1: number; y1: number; x2: number; y2: number };
};

/** Ubica todas las etiquetas del gráfico evitando colisiones con círculos y otras etiquetas. */
export function layoutScatterLabels(
  points: ReadonlyArray<ScatterPoint>,
  bounds = { x0: 84, y0: 28, width: 792, height: 290 },
): ScatterLabel[] {
  const coords = points.map(pt => ({
    pt,
    cx: bounds.x0 + pt.xNorm * bounds.width,
    cy: bounds.y0 + bounds.height - pt.yNorm * bounds.height,
    label: pt.name.includes('/') ? pt.name.split('/').slice(1).join('/') : pt.name,
  }));
  const circleBoxes = coords.map(c => ({ x1: c.cx - 11, y1: c.cy - 11, x2: c.cx + 11, y2: c.cy + 11 }));
  const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const overlaps = (a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) =>
    a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  const makeCandidate = (cx: number, cy: number, dx: number, dy: number, anchor: 'start' | 'end' | 'middle', w: number, h: number) => {
    const x = cx + dx;
    const y = cy + dy;
    const x1 = anchor === 'start' ? x - 2 : anchor === 'end' ? x - w + 2 : x - w / 2;
    const x2 = x1 + w;
    const y1 = y - h + 3;
    const y2 = y + 4;
    const leaderX = anchor === 'start' ? x - 3 : anchor === 'end' ? x + 3 : x;
    const leaderY = y - 4;
    return { x, y, anchor, leaderX, leaderY, box: { x1, y1, x2, y2 } };
  };

  return coords.map((item, idx) => {
    const w = Math.max(44, item.label.length * 6.8 + 8);
    const h = 15;
    const offsets: Array<{ dx: number; dy: number; anchor: 'start' | 'end' | 'middle' }> = [
      { dx: 12, dy: -6, anchor: 'start' },
      { dx: 12, dy: 14, anchor: 'start' },
      { dx: -12, dy: -6, anchor: 'end' },
      { dx: -12, dy: 14, anchor: 'end' },
      { dx: 0, dy: -14, anchor: 'middle' },
      { dx: 0, dy: 22, anchor: 'middle' },
    ];
    for (const step of [26, 44, 62, 82, 102]) {
      offsets.push(
        { dx: 14, dy: -step, anchor: 'start' },
        { dx: 14, dy: step, anchor: 'start' },
        { dx: -14, dy: -step, anchor: 'end' },
        { dx: -14, dy: step, anchor: 'end' },
        { dx: 54, dy: -step, anchor: 'start' },
        { dx: -54, dy: -step, anchor: 'end' },
        { dx: 54, dy: step, anchor: 'start' },
        { dx: -54, dy: step, anchor: 'end' },
      );
    }

    let chosen = makeCandidate(item.cx, item.cy, 12, -6, 'start', w, h);
    for (const off of offsets) {
      const cand = makeCandidate(item.cx, item.cy, off.dx, off.dy, off.anchor, w, h);
      const inside = cand.box.x1 >= bounds.x0 + 2 && cand.box.x2 <= bounds.x0 + bounds.width - 2 && cand.box.y1 >= 10 && cand.box.y2 <= bounds.y0 + bounds.height - 2;
      if (!inside) continue;
      const hitsCircle = circleBoxes.some((cb, cIdx) => cIdx === idx ? false : overlaps(cand.box, cb)) || overlaps(cand.box, circleBoxes[idx]);
      if (hitsCircle) continue;
      if (placed.some(p => overlaps(cand.box, p))) continue;
      chosen = cand;
      break;
    }
    placed.push(chosen.box);
    const dist = Math.hypot(chosen.leaderX - item.cx, chosen.leaderY - item.cy);
    return {
      name: item.pt.name,
      label: item.label,
      cx: item.cx,
      cy: item.cy,
      x: chosen.x,
      y: chosen.y,
      anchor: chosen.anchor,
      needsLeader: dist > 18,
      leaderX: chosen.leaderX,
      leaderY: chosen.leaderY,
      box: chosen.box,
    };
  });
}
