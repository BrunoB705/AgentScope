import test from 'node:test';
import assert from 'node:assert/strict';
import { combinationCount, filterModels, modelSpec, quotaPerPassed, renderMarkdown, summarizeByModel, tokenTotal } from './benchmarks.ts';

const suite = {
  id: 'demo',
  name: 'Demo',
  modelTimeoutMs: 300000,
  tests: [
    { name: 'code-test', type: 'code', rubric: [], judge: false },
    { name: 'open-test', type: 'open', rubric: ['Claridad'], judge: true },
  ],
};

const result = (overrides) => ({
  id: 'r1',
  testName: 'code-test',
  testType: 'code',
  model: 'm1',
  status: 'completed',
  verifyPassed: true,
  judgeScore: null,
  metricsError: null,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: null,
  quotaCostEstimate: null,
  ...overrides,
});

test('combinationCount multiplica modelos por pruebas', () => {
  assert.equal(combinationCount(suite, ['a', 'b', 'c']), 6);
  assert.equal(combinationCount(suite, []), 0);
});

test('summarizeByModel agrupa y cuenta aprobadas', () => {
  const summary = summarizeByModel([
    result({ id: 'm1-code', model: 'm1', verifyPassed: true }),
    result({ id: 'm1-open', model: 'm1', testType: 'open', verifyPassed: null, judgeScore: 4 }),
    result({ id: 'm2-code', model: 'm2', verifyPassed: false }),
    result({ id: 'm2-open', model: 'm2', testType: 'open', verifyPassed: null, judgeScore: 2 }),
  ]);
  assert.deepEqual(summary.map((item) => item.model), ['m1', 'm2']);
  assert.equal(summary[0].total, 2);
  assert.equal(summary[0].passed, 2);
  assert.equal(summary[0].failed, 0);
  assert.equal(summary[1].passed, 0);
  assert.equal(summary[1].failed, 2);
});

test('summarizeByModel promedia notas e ignora nulos', () => {
  const summary = summarizeByModel([
    result({ model: 'm1', testType: 'open', verifyPassed: null, judgeScore: 4 }),
    result({ model: 'm1', testType: 'open', verifyPassed: null, judgeScore: null }),
    result({ model: 'm1', testType: 'open', verifyPassed: null, judgeScore: 2 }),
  ]);
  assert.equal(summary[0].judgeAverage, 3);
});

test('summarizeByModel suma tokens y costo', () => {
  const summary = summarizeByModel([
    result({ model: 'm1', inputTokens: 10, outputTokens: 5, reasoningTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.001, quotaCostEstimate: 0.002, durationMs: 100 }),
    result({ model: 'm1', testType: 'open', verifyPassed: null, judgeScore: 4, inputTokens: 20, outputTokens: 10, reasoningTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, cost: 0.002, quotaCostEstimate: 0.003, durationMs: 200 }),
    result({ model: 'm2', inputTokens: 7, outputTokens: 3, cost: null, quotaCostEstimate: null, durationMs: 50 }),
  ]);
  assert.equal(summary[0].inputTokens, 30);
  assert.equal(summary[0].outputTokens, 15);
  assert.equal(summary[0].reasoningTokens, 9);
  assert.equal(summary[0].cacheReadTokens, 5);
  assert.equal(summary[0].cacheWriteTokens, 3);
  assert.equal(summary[0].totalTokens, 53);
  assert.equal(summary[0].durationMs, 300);
  assert.equal(summary[0].cost, 0.003);
  assert.equal(summary[0].quotaCost, 0.005);
  assert.equal(summary[1].cost, null);
  assert.equal(summary[1].quotaCost, null);
});

test('tokenTotal suma entrada, salida y caché sin razonamiento', () => {
  assert.equal(tokenTotal(result({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 })), 18);
});

test('summarizeByModel cuenta errores', () => {
  const summary = summarizeByModel([
    result({ model: 'm1', status: 'failed' }),
    result({ model: 'm1', status: 'timedout' }),
    result({ model: 'm1', status: 'completed', metricsError: 'sin telemetría' }),
    result({ model: 'm1', status: 'completed' }),
  ]);
  assert.equal(summary[0].errors, 3);
});

test('quotaPerPassed devuelve null sin aprobadas', () => {
  assert.equal(quotaPerPassed({ model: 'm1', total: 2, passed: 0, failed: 2, judgeAverage: null, durationMs: 0, inputTokens: 0, outputTokens: 0, cost: null, quotaCost: 0.004, errors: 0 }), null);
  assert.equal(quotaPerPassed({ model: 'm1', total: 2, passed: 2, failed: 0, judgeAverage: null, durationMs: 0, inputTokens: 0, outputTokens: 0, cost: 0.004, quotaCost: null, errors: 0 }), null);
});

test('quotaPerPassed divide la cuota Go por aprobadas', () => {
  assert.equal(quotaPerPassed({ model: 'm1', total: 2, passed: 2, failed: 0, judgeAverage: null, durationMs: 0, inputTokens: 0, outputTokens: 0, cost: null, quotaCost: 0.004, errors: 0 }), 0.002);
});

test('filterModels busca por nombre sin distinguir mayúsculas', () => {
  assert.deepEqual(filterModels(['opencode-go/a', 'opencode-go/b', 'nvidia/c'], 'GO/B'), ['opencode-go/b']);
  assert.deepEqual(filterModels(['a', 'b'], ''), ['a', 'b']);
});

test('modelSpec agrega la variante solo si existe', () => {
  assert.equal(modelSpec('provider/model'), 'provider/model');
  assert.equal(modelSpec('provider/model', 'high'), 'provider/model#high');
  assert.equal(modelSpec('provider/model', '  '), 'provider/model');
});

test('renderMarkdown convierte negritas, código y escapa HTML', () => {
  assert.equal(renderMarkdown('**hola**'), '<strong>hola</strong>');
  assert.equal(renderMarkdown('`código`'), '<code>código</code>');
  assert.equal(renderMarkdown('*énfasis*'), '<em>énfasis</em>');
  assert.equal(renderMarkdown('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(renderMarkdown('a\nb'), 'a<br />b');
});

test('summarizeByModel con lista vacía devuelve []', () => {
  assert.deepEqual(summarizeByModel([]), []);
});
