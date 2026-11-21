import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryResultForStatus, mapOpenCodeEvent, TelemetryQueue } from './index.ts';

test('maps v2 session events and derives project name from its working directory', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e1', created: 2000, type: 'session.created', location: { directory: 'C:\\work\\my-app' }, data: { sessionID: 's1', title: 'private title' } });
  assert.equal(mapped.eventId, 'session.created:e1');
  assert.equal(mapped.sessionId, 's1');
  assert.equal(mapped.project, 'my-app');
  assert.equal(mapped.status, 'active');
  assert.equal(JSON.stringify(mapped).includes('private title'), false);
});

test('maps finished model steps and safe token counts without serializing content', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e2', created: 3000, type: 'session.step.ended', data: {
    sessionID: 's1', assistantMessageID: 'm1', finish: 'stop', tokens: { input: 15, output: 7 }, snapshot: 'secret prompt',
  } });
  assert.equal(mapped.eventId, 'model:m1');
  assert.equal(mapped.type, 'model.completed');
  assert.equal(mapped.inputTokens, 15);
  assert.equal(mapped.outputTokens, 7);
  assert.equal(JSON.stringify(mapped).includes('secret prompt'), false);
});

test('maps completed tool call with correlation and drops its content and metadata payload', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e3', created: 4000, type: 'session.tool.failed', data: {
    sessionID: 's1', assistantMessageID: 'm1', id: 'call1', content: [{ type: 'text', text: 'sensitive tool output' }],
    metadata: { tool: 'bash', command: 'secret command' },
  } });
  assert.equal(mapped.eventId, 'tool:call1');
  assert.equal(mapped.parentId, 'model:m1');
  assert.equal(mapped.name, 'bash');
  assert.equal(mapped.status, 'error');
  assert.equal(JSON.stringify(mapped).includes('sensitive tool output'), false);
  assert.equal(JSON.stringify(mapped).includes('secret command'), false);
});

test('la cuota Go estimada guarda el snapshot de tarifas y la fecha del catálogo', () => {
  const [mapped] = mapOpenCodeEvent(
    { id: 'e6', created: 7000, type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: 'm1', tokens: { input: 1000, output: 500, cache: { read: 200, write: 100 } } } },
    'opencode',
    {
      model: 'opencode-go/model-x',
      started: 6000,
      catalogFetchedAt: '2026-11-17T10:22:00.000Z',
      modelInfo: { cost: [{ input: 0.15, output: 0.6, cache: { read: 0.015, write: 0.1875 } }] },
    },
  );
  assert.equal(mapped.quotaCostEstimate, (1000 * 0.15 + 500 * 0.6 + 200 * 0.015 + 100 * 0.1875) / 1_000_000);
  assert.equal(mapped.quotaCatalogFetchedAt, '2026-11-17T10:22:00.000Z');
  assert.equal(mapped.quotaMissingReason, undefined);
  const snapshot = JSON.parse(String(mapped.quotaRateSnapshot));
  assert.deepEqual(snapshot, { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.1875, tier: null });
});

test('sin tarifa no se inventa una cuota y se registra el motivo', () => {
  const [mapped] = mapOpenCodeEvent(
    { id: 'e7', created: 7000, type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: 'm1', tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } } },
    'opencode',
    { model: 'opencode-go/model-y', started: 6000, catalogFetchedAt: '2026-11-17T10:22:00.000Z', modelInfo: { cost: [] } },
  );
  assert.equal(mapped.quotaCostEstimate, undefined);
  assert.equal(mapped.quotaRateSnapshot, undefined);
  assert.equal(mapped.quotaMissingReason, 'no_catalog');
  assert.equal(mapped.quotaCatalogFetchedAt, undefined);
});

test('un modelo fuera de opencode-go no intenta estimar cuota', () => {
  const [mapped] = mapOpenCodeEvent(
    { id: 'e8', created: 7000, type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: 'm1', tokens: { input: 10, output: 5 } } },
    'opencode',
    { model: 'anthropic/claude', started: 6000, modelInfo: { cost: [{ input: 1, output: 1, cache: { read: 1, write: 1 } }] } },
  );
  assert.equal(mapped.quotaCostEstimate, undefined);
  assert.equal(mapped.quotaMissingReason, 'not_applicable');
});

test('un contador de tokens ausente se omite en vez de viajar como cero', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e9', created: 8000, type: 'session.step.ended', data: {
    sessionID: 's1', assistantMessageID: 'm9', finish: 'stop', tokens: { input: 12 },
  } });
  assert.equal(mapped.inputTokens, 12);
  assert.equal(mapped.outputTokens, undefined);
  assert.equal(mapped.cacheReadTokens, undefined);
  assert.equal(JSON.stringify(mapped).includes('"outputTokens"'), false);
});

test('un contador reportado en cero se conserva como cero', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e10', created: 9000, type: 'session.step.ended', data: {
    sessionID: 's1', assistantMessageID: 'm10', finish: 'stop', tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  } });
  assert.equal(mapped.inputTokens, 0);
  assert.equal(mapped.outputTokens, 0);
  assert.equal(mapped.cacheReadTokens, 0);
  assert.equal(mapped.cacheWriteTokens, 0);
});

test('ignores unrelated event and malformed events without a session id', () => {
  assert.deepEqual(mapOpenCodeEvent({ type: 'session.text.delta', data: { sessionID: 's1', text: 'secret' } }), []);
  assert.deepEqual(mapOpenCodeEvent({ type: 'session.idle', data: {} }), []);
});

test('distingue una ejecución interrumpida de una completada', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e4', created: 5000, type: 'session.execution.interrupted', data: { sessionID: 's1' } });
  assert.equal(mapped.type, 'session.idle');
  assert.equal(mapped.status, 'interrupted');
});

test('marca la ejecución exitosa como completada', () => {
  const [mapped] = mapOpenCodeEvent({ id: 'e5', created: 6000, type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  assert.equal(mapped.type, 'session.execution.succeeded');
  assert.equal(mapped.status, 'completed');
});

test('clasifica la respuesta del colector sin descartar errores de credenciales', () => {
  assert.equal(deliveryResultForStatus(200), 'ok');
  assert.equal(deliveryResultForStatus(400), 'permanent');
  assert.equal(deliveryResultForStatus(401), 'retry');
  assert.equal(deliveryResultForStatus(403), 'retry');
  assert.equal(deliveryResultForStatus(408), 'retry');
  assert.equal(deliveryResultForStatus(429), 'retry');
  assert.equal(deliveryResultForStatus(500), 'retry');
});

test('conserva el evento pendiente cuando el envío falla', async () => {
  let attempts = 0;
  const queue = new TelemetryQueue(async () => { attempts++; return 'retry'; }, { attempts: 1, retryDelayMs: 1000 });
  queue.enqueue({ eventId: 'e1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.size, 1);
  assert.equal(queue.droppedCount, 0);
  assert.equal(attempts, 1);
  queue.dispose();
});

test('reintenta y drena cuando el colector vuelve', async () => {
  let result: 'retry' | 'ok' = 'retry';
  const queue = new TelemetryQueue(async () => result, { attempts: 1, retryDelayMs: 5 });
  queue.enqueue({ eventId: 'e2' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queue.size, 1);
  result = 'ok';
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(queue.size, 0);
  queue.dispose();
});

test('descarta el más viejo encolado sin tocar el evento en vuelo', async () => {
  const sent: unknown[] = [];
  let release!: (result: 'ok') => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const queue = new TelemetryQueue(event => {
    sent.push(event.eventId);
    if (event.eventId === 'a') {
      started();
      return new Promise<'ok'>(resolve => { release = resolve; });
    }
    return Promise.resolve('ok');
  }, { max: 2, attempts: 1 });
  queue.enqueue({ eventId: 'a' });
  await startedPromise;
  queue.enqueue({ eventId: 'b' });
  queue.enqueue({ eventId: 'c' });
  assert.equal(queue.size, 2);
  assert.equal(queue.droppedCount, 1);
  assert.equal(queue.peek()?.eventId, 'a');
  release('ok');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['a', 'c']);
  assert.equal(queue.size, 0);
  queue.dispose();
});

test('descarta un rechazo permanente sin bloquear los eventos siguientes', async () => {
  const sent: unknown[] = [];
  const queue = new TelemetryQueue(async event => {
    sent.push(event.eventId);
    return event.eventId === 'bad' ? 'permanent' : 'ok';
  }, { attempts: 1 });
  queue.enqueue({ eventId: 'bad' });
  queue.enqueue({ eventId: 'good' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['bad', 'good']);
  assert.equal(queue.size, 0);
  assert.equal(queue.rejectedCount, 1);
  queue.dispose();
});
