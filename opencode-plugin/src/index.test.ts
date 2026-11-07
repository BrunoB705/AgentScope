import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AgentObservability } from './index.ts';
import type { Plugin } from '@opencode-ai/plugin';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.OPENCODE_OBSERVABILITY_URL;
const sent: Record<string, unknown>[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.OPENCODE_OBSERVABILITY_URL;
  else process.env.OPENCODE_OBSERVABILITY_URL = originalUrl;
  sent.length = 0;
});

async function plugin() {
  process.env.OPENCODE_OBSERVABILITY_URL = 'http://collector.invalid';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return AgentObservability({} as Parameters<Plugin>[0]);
}

test('captures only safe tool metadata and correlates the parent model span', async () => {
  const hooks = await plugin();
  await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
    id: 'part-1', sessionID: 'session-1', messageID: 'assistant-1', callID: 'call-1', type: 'tool', tool: 'bash',
    state: { status: 'error', error: 'sensitive tool output', input: { command: 'secret' }, time: { start: 1000, end: 1250 } },
  } } } } as never);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'session-1');
  assert.equal(sent[0].eventId, 'tool:call-1');
  assert.equal(sent[0].parentId, 'model:assistant-1');
  assert.equal(sent[0].status, 'error');
  assert.deepEqual(sent[0].attributes, { opencode_event: 'tool.completed', error_code: 'opencode_tool_error' });
  assert.equal(sent[0].durationMs, 250);
  assert.equal(sent[0].name, 'bash');
  assert.equal(JSON.stringify(sent[0]).includes('sensitive tool output'), false);
  assert.equal(JSON.stringify(sent[0]).includes('command'), false);
});

test('uses stable IDs for completed model updates and emits only duration and token counts', async () => {
  const hooks = await plugin();
  const info = { id: 'assistant-2', sessionID: 'session-2', role: 'assistant', modelID: 'model-x', time: { created: 2000, completed: 2900 }, tokens: { input: 15, output: 7, reasoning: 1, cache: { read: 0, write: 0 } }, text: 'must not be recorded' };
  await hooks.event?.({ event: { type: 'message.updated', properties: { info } } } as never);
  await hooks.event?.({ event: { type: 'message.updated', properties: { info } } } as never);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].eventId, 'model:assistant-2');
  assert.equal(sent[0].durationMs, 900);
  assert.equal(sent[0].inputTokens, 15);
  assert.equal(sent[0].outputTokens, 7);
  assert.equal(sent[1].eventId, sent[0].eventId);
  assert.equal(JSON.stringify(sent[0]).includes('must not be recorded'), false);
});
