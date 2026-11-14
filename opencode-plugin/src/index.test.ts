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

test('descarta el más viejo y lo informa cuando la cola se llena', () => {
  const queue = new TelemetryQueue(() => new Promise<'ok'>(() => undefined), { max: 2 });
  queue.enqueue({ eventId: 'a' });
  queue.enqueue({ eventId: 'b' });
  queue.enqueue({ eventId: 'c' });
  assert.equal(queue.size, 2);
  assert.equal(queue.droppedCount, 1);
  assert.equal(queue.peek()?.eventId, 'b');
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
