import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterfall, findSpanForEvent, isErrorStatus, spanIdForEvent } from './trace.ts';

const at = (ms) => new Date(ms).toISOString();
const span = (id, start, durationMs, extra = {}) => ({
  id, name: id, kind: 'inference', status: 'ok', startedAt: at(start), durationMs, ...extra,
});
const row = (waterfall, id) => waterfall.rows.find((item) => item.span.id === id);

test('ordena por inicio y calcula offsets y anchos proporcionales', () => {
  const waterfall = buildWaterfall([span('late', 1500, 500), span('early', 1000, 1000)]);
  assert.deepEqual(waterfall.rows.map((item) => item.span.id), ['early', 'late']);
  assert.equal(waterfall.domainStart, 1000);
  assert.equal(waterfall.domainEnd, 2000);
  assert.equal(waterfall.totalMs, 1000);
  assert.equal(waterfall.rows[0].startPercent, 0);
  assert.equal(waterfall.rows[0].widthPercent, 100);
  assert.equal(waterfall.rows[1].startPercent, 50);
  assert.equal(waterfall.rows[1].widthPercent, 50);
  assert.equal(waterfall.hasAnyDuration, true);
});

test('desempata por id cuando dos spans empiezan al mismo tiempo', () => {
  const waterfall = buildWaterfall([span('b', 1000, 100), span('a', 1000, 100)]);
  assert.deepEqual(waterfall.rows.map((item) => item.span.id), ['a', 'b']);
});

test('los spans sin duración son marcadores y no extienden el dominio', () => {
  const waterfall = buildWaterfall([
    span('unknown', 1000, null),
    span('known', 1000, 2000),
  ]);
  assert.equal(waterfall.totalMs, 2000);
  assert.equal(row(waterfall, 'unknown').hasDuration, false);
  assert.equal(row(waterfall, 'unknown').widthPercent, 0);
  assert.equal(row(waterfall, 'known').widthPercent, 100);
  assert.equal(waterfall.hasAnyDuration, true);
});

test('usa un dominio de un segundo cuando no hay duración positiva', () => {
  const waterfall = buildWaterfall([span('only', 1000, null)]);
  assert.equal(waterfall.domainStart, 1000);
  assert.equal(waterfall.domainEnd, 2000);
  assert.equal(waterfall.totalMs, 1000);
  assert.equal(waterfall.hasAnyDuration, false);
});

test('una duración cero no rompe el dominio', () => {
  const waterfall = buildWaterfall([span('zero', 1000, 0), span('next', 2000, 0)]);
  assert.equal(waterfall.totalMs, 1000);
  assert.equal(row(waterfall, 'zero').widthPercent, 0);
  assert.equal(waterfall.hasAnyDuration, true);
});

test('calcula la profundidad, la limita a 5 y no se cuelga con ciclos', () => {
  const chain = Array.from({ length: 7 }, (_, index) =>
    span(`s${index}`, 1000 + index, 100, { parentId: index ? `s${index - 1}` : undefined }));
  const waterfall = buildWaterfall(chain);
  assert.equal(row(waterfall, 's0').depth, 0);
  assert.equal(row(waterfall, 's5').depth, 5);
  assert.equal(row(waterfall, 's6').depth, 5);

  const cycle = buildWaterfall([
    span('x', 1000, 100, { parentId: 'y' }),
    span('y', 1000, 100, { parentId: 'x' }),
  ]);
  assert.ok(cycle.rows.every((item) => item.depth <= 5));
});

test('correlaciona un evento con su span por source y eventId', () => {
  const spans = [span('opencode:tool:call-1', 1000, 100)];
  assert.equal(spanIdForEvent({ source: 'opencode', eventId: 'tool:call-1' }), 'opencode:tool:call-1');
  assert.equal(findSpanForEvent(spans, { source: 'opencode', eventId: 'tool:call-1' })?.id, 'opencode:tool:call-1');
  assert.equal(findSpanForEvent(spans, { source: 'opencode', eventId: 'session.error:1' }), undefined);
});

test('reconoce error y failed como estados de error', () => {
  assert.equal(isErrorStatus('error'), true);
  assert.equal(isErrorStatus('failed'), true);
  assert.equal(isErrorStatus('ok'), false);
  assert.equal(isErrorStatus(undefined), false);
});
