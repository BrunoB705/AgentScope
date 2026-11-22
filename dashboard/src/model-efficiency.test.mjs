import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScatterPlot, computeModelHighlights, filterModelsByMinCalls, layoutScatterLabels } from './model-efficiency.ts';

const sampleModels = [
  {
    name: 'opencode-go/rapido',
    calls: 10,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    tokens: 1700,
    share: 0.5,
    reportedCost: 0,
    quotaEstimate: 0.1,
    errorCount: 0,
    averageDurationMs: 1200,
    outputTokensPerSec: 80,
    cacheEfficiency: 0.2,
    reportedCostPerCall: 0,
    quotaPerCall: 0.01,
    quotaPer1MTokens: 58.82,
    benchmarkCases: 4,
    benchmarkPassRate: 0.5,
    benchmarkJudgeAvg: 3.5,
  },
  {
    name: 'opencode-go/preciso',
    calls: 5,
    inputTokens: 800,
    outputTokens: 400,
    cacheReadTokens: 1200,
    cacheWriteTokens: 0,
    tokens: 2400,
    share: 0.5,
    reportedCost: 0,
    quotaEstimate: 0.4,
    errorCount: 1,
    averageDurationMs: 3500,
    outputTokensPerSec: 40,
    cacheEfficiency: 0.6,
    reportedCostPerCall: 0,
    quotaPerCall: 0.08,
    quotaPer1MTokens: 166.67,
    benchmarkCases: 4,
    benchmarkPassRate: 1.0,
    benchmarkJudgeAvg: 4.8,
  },
];

test('computeModelHighlights exige al menos dos modelos comparables por dimensión', () => {
  assert.deepEqual(computeModelHighlights([sampleModels[0]]), []);
});

test('computeModelHighlights elige ganadores objetivos en cada métrica disponible', () => {
  const highlights = Object.fromEntries(computeModelHighlights(sampleModels).map(item => [item.id, item]));
  assert.equal(highlights.fastest.model, 'opencode-go/rapido');
  assert.equal(highlights.throughput.model, 'opencode-go/rapido');
  assert.equal(highlights.cache.model, 'opencode-go/preciso');
  assert.equal(highlights.cheapestQuota.model, 'opencode-go/rapido');
  assert.equal(highlights.cheapestQuota1M.model, 'opencode-go/rapido');
  assert.equal(highlights.benchmarkPass.model, 'opencode-go/preciso');
  assert.equal(highlights.cheapestCost, undefined, 'no destaca costo reportado cuando todos son cero');
});

test('buildScatterPlot soporta cuota/1M, tokens/llamada, latencia y nota del juez sin dividir por cero', () => {
  const withMissing = [
    ...sampleModels,
    { ...sampleModels[0], name: 'opencode-go/sin-cuota', quotaPerCall: null, quotaPer1MTokens: null },
  ];
  const by1M = buildScatterPlot(withMissing, 'quotaPer1M', 'benchmarkJudge');
  assert.equal(by1M.excludedCount, 1);
  assert.equal(by1M.points.length, 2);
  assert.equal(by1M.yMax, 5);
  assert.ok(by1M.points[1].yNorm > by1M.points[0].yNorm);

  const byTokens = buildScatterPlot(sampleModels, 'tokensPerCall', 'latency');
  assert.equal(byTokens.points.length, 2);
  assert.equal(byTokens.points[0].x, 170);
  assert.equal(byTokens.points[0].y, 1.2);

  const flat = buildScatterPlot([
    { ...sampleModels[0], quotaPerCall: 0.05, outputTokensPerSec: 50 },
    { ...sampleModels[1], quotaPerCall: 0.05, outputTokensPerSec: 50 },
  ], 'quotaPerCall', 'speed');
  assert.equal(flat.points.length, 2);
  assert.ok(Number.isFinite(flat.points[0].xNorm) && Number.isFinite(flat.points[0].yNorm));
});

test('layoutScatterLabels ubica etiquetas sin superponer cajas aunque los puntos estén juntos', () => {
  const clustered = [
    { name: 'opencode-go/gpt-5-luna', x: 1, y: 1, xNorm: 0.2, yNorm: 0.2, calls: 5, errorCount: 0 },
    { name: 'opencode-go/kimi-k2.7-code', x: 1, y: 1, xNorm: 0.21, yNorm: 0.19, calls: 4, errorCount: 0 },
    { name: 'opencode-go/deepseek-v4-pro', x: 1, y: 1, xNorm: 0.22, yNorm: 0.21, calls: 6, errorCount: 0 },
    { name: 'opencode-go/glm-5.3-flash', x: 1, y: 1, xNorm: 0.23, yNorm: 0.22, calls: 7, errorCount: 0 },
  ];
  const labels = layoutScatterLabels(clustered);
  assert.equal(labels.length, 4);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].box;
      const b = labels[j].box;
      const overlapX = a.x1 < b.x2 && a.x2 > b.x1;
      const overlapY = a.y1 < b.y2 && a.y2 > b.y1;
      assert.equal(overlapX && overlapY, false, `${labels[i].label} y ${labels[j].label} se superponen`);
    }
  }
});

test('filterModelsByMinCalls excluye modelos por debajo del umbral elegido', () => {
  assert.equal(filterModelsByMinCalls(sampleModels, 1).length, 2);
  assert.deepEqual(filterModelsByMinCalls(sampleModels, 10).map(m => m.name), ['opencode-go/rapido']);
  assert.equal(filterModelsByMinCalls(sampleModels, 50).length, 0);
});
