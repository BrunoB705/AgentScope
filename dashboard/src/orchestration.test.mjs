import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionHierarchy, summarizeDelegation } from './orchestration.ts';

test('classifySessionHierarchy distingue orquestador, subagente y sesión aislada', () => {
  assert.equal(classifySessionHierarchy({ subagentCount: 2 }), 'orchestrator');
  assert.equal(classifySessionHierarchy({ parentSessionId: 'p1', subagentCount: 1 }), 'orchestrator');
  assert.equal(classifySessionHierarchy({ parentSessionId: 'p1', subagentCount: 0 }), 'subagent');
  assert.equal(classifySessionHierarchy({}), 'standalone');
});

test('summarizeDelegation agrega roles distintos, cuota y tokens sin inventar ceros', () => {
  const summary = summarizeDelegation([
    { id: 'c1', agent: 'reviewer', status: 'completed', startedAt: '2026-11-22T00:00:00Z', spanCount: 2, errorCount: 0, inputTokens: 100, outputTokens: 50, quotaCostEstimate: 0.01, childCount: 0 },
    { id: 'c2', agent: 'explore', status: 'error', startedAt: '2026-11-22T00:01:00Z', spanCount: 1, errorCount: 1, inputTokens: null, outputTokens: null, quotaCostEstimate: null, childCount: 0 },
  ]);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.distinctRoles, ['reviewer', 'explore']);
  assert.equal(summary.totalQuota, 0.01);
  assert.equal(summary.totalTokens, 150);
  assert.equal(summary.errorCount, 1);

  const empty = summarizeDelegation([]);
  assert.equal(empty.totalQuota, null);
  assert.equal(empty.totalTokens, null);
});
