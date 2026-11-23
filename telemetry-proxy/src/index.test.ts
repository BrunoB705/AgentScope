import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  createProxyServer,
  extractUsageFromObject,
  normalizeModelName,
  parseProxyRoute,
  SessionTracker,
  SseUsageTracker,
  type TelemetryPayload,
} from './index.ts';

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('parseProxyRoute extracts app prefix, avoids duplicate /v1, and classifies inference paths', () => {
  const withApp = parseProxyRoute('/learnharness/v1/chat/completions?foo=1', 'POST', 'https://opencode.ai/zen/go/v1');
  assert.equal(withApp.sourceFromPath, 'learnharness');
  assert.equal(withApp.upstreamUrl, 'https://opencode.ai/zen/go/v1/chat/completions?foo=1');
  assert.equal(withApp.isInference, true);
  assert.equal(withApp.endpointTag, 'chat/completions');

  const direct = parseProxyRoute('/v1/messages', 'POST', 'https://opencode.ai/zen/go/v1');
  assert.equal(direct.sourceFromPath, undefined);
  assert.equal(direct.upstreamUrl, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(direct.isInference, true);
  assert.equal(direct.endpointTag, 'messages');

  const noV1 = parseProxyRoute('/learnharness/chat/completions', 'POST', 'https://opencode.ai/zen/go/v1');
  assert.equal(noV1.sourceFromPath, 'learnharness');
  assert.equal(noV1.upstreamUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(noV1.isInference, true);

  const models = parseProxyRoute('/learnharness/v1/models', 'GET', 'https://opencode.ai/zen/go/v1');
  assert.equal(models.sourceFromPath, 'learnharness');
  assert.equal(models.upstreamUrl, 'https://opencode.ai/zen/go/v1/models');
  assert.equal(models.isInference, false);
});

test('normalizeModelName prefixes OpenCode Go and Zen models without double-prefixing', () => {
  assert.equal(normalizeModelName('kimi-k2.5', 'https://opencode.ai/zen/go/v1'), 'opencode-go/kimi-k2.5');
  assert.equal(normalizeModelName('opencode-go/glm-5', 'https://opencode.ai/zen/go/v1'), 'opencode-go/glm-5');
  assert.equal(normalizeModelName('gpt-5', 'https://opencode.ai/zen/v1'), 'opencode/gpt-5');
  assert.equal(normalizeModelName('llama-3', 'http://127.0.0.1:11434/v1'), 'llama-3');
});

test('extractUsageFromObject handles OpenAI cached/reasoning tokens without double-counting and Anthropic cache fields', () => {
  const openAi = extractUsageFromObject({
    prompt_tokens: 1000,
    completion_tokens: 250,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 120 },
  });
  assert.deepEqual(openAi, {
    inputTokens: 200,
    outputTokens: 250,
    reasoningTokens: 120,
    cacheReadTokens: 800,
  });

  const anthropic = extractUsageFromObject({
    input_tokens: 150,
    output_tokens: 90,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 50,
  });
  assert.deepEqual(anthropic, {
    inputTokens: 150,
    outputTokens: 90,
    cacheReadTokens: 400,
    cacheWriteTokens: 50,
  });
});

test('SseUsageTracker handles split chunks for OpenAI and Anthropic streams', () => {
  const openAiTracker = new SseUsageTracker();
  openAiTracker.push('data: {"model":"kimi-k2.5","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"model":"kimi-k2.5","usage":');
  openAiTracker.push('{"prompt_tokens":120,"completion_tokens":45}}\n\ndata: [DONE]\n\n');
  openAiTracker.finish();
  assert.equal(openAiTracker.model, 'kimi-k2.5');
  assert.deepEqual(openAiTracker.usage, { inputTokens: 120, outputTokens: 45 });

  const anthropicTracker = new SseUsageTracker();
  anthropicTracker.push('event: message_start\ndata: {"type":"message_start","message":{"model":"minimax-m2.5","usage":{"input_tokens":80,"cache_read_input_tokens":300,"output_tokens":1}}}\n\n');
  anthropicTracker.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":64}}\n\n');
  anthropicTracker.finish();
  assert.equal(anthropicTracker.model, 'minimax-m2.5');
  assert.deepEqual(anthropicTracker.usage, { inputTokens: 80, outputTokens: 64, cacheReadTokens: 300 });
});

test('SessionTracker groups within timeout, rotates after timeout, and preserves monotonic timestamps', () => {
  let current = 10_000;
  const tracker = new SessionTracker(5_000, () => current);

  const first = tracker.resolve('learnharness');
  assert.equal(first.isNew, true);
  const t1 = tracker.nextTimestamp('learnharness', undefined, current);
  const t2 = tracker.nextTimestamp('learnharness', undefined, current);
  assert.ok(t2 > t1);

  current += 4_000;
  const second = tracker.resolve('learnharness');
  assert.equal(second.isNew, false);
  assert.equal(second.sessionId, first.sessionId);

  current += 6_000;
  const third = tracker.resolve('learnharness');
  assert.equal(third.isNew, true);
  assert.notEqual(third.sessionId, first.sessionId);
});

test('Proxy end-to-end: forwards JSON, SSE streams, errors, and emits privacy-safe telemetry', async () => {
  let receivedUpstreamAuth: string | undefined;
  let receivedStreamOptions: unknown;
  let receivedForbiddenHeader: string | undefined;
  const receivedOpenCodeSessions: Array<string | undefined> = [];

  const upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    receivedUpstreamAuth = req.headers.authorization;
    receivedForbiddenHeader = req.headers['x-agentscope-source'] as string | undefined;
    if (req.url === '/v1/chat/completions') {
      receivedOpenCodeSessions.push(req.headers['x-opencode-session'] as string | undefined);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.url === '/v1/models') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'kimi-k2.5' }] }));
      return;
    }

    const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    if (req.url === '/v1/chat/completions' && parsed.model === 'fail-model') {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } }));
      return;
    }

    if (req.url === '/v1/chat/completions' && parsed.stream === true) {
      receivedStreamOptions = parsed.stream_options;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"id":"1","model":"kimi-k2.5","choices":[{"delta":{"content":"Hola"}}]}\n\n');
      res.write('data: {"id":"1","model":"kimi-k2.5","choices":[],"usage":{"prompt_tokens":500,"completion_tokens":75,"prompt_tokens_details":{"cached_tokens":200}}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [{ message: { role: 'assistant', content: 'SECRET_ANSWER_SHOULD_NOT_BE_IN_TELEMETRY' } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
  });

  const upstreamPort = await listen(upstream);
  const events: TelemetryPayload[] = [];
  const { server: proxy, sender } = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    injectOpenCodeSession: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const proxyPort = await listen(proxy);

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string };
    assert.equal(healthJson.status, 'ok');

    // 2. Non-inference GET /models should not emit telemetry
    const modelsRes = await fetch(`http://127.0.0.1:${proxyPort}/learnharness/v1/models`);
    assert.equal(modelsRes.status, 200);
    assert.equal(events.length, 0);

    // 3. Non-streaming chat completion
    const jsonRes = await fetch(`http://127.0.0.1:${proxyPort}/learnharness/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-secret-user-key',
        'x-agentscope-title': 'Estudio: Grafos',
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: 'SECRET_PROMPT_SHOULD_NOT_BE_IN_TELEMETRY' }],
      }),
    });
    assert.equal(jsonRes.status, 200);
    const jsonBody = (await jsonRes.json()) as { id: string };
    assert.equal(jsonBody.id, 'chatcmpl-1');
    assert.equal(receivedUpstreamAuth, 'Bearer sk-secret-user-key');
    assert.equal(receivedForbiddenHeader, undefined);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'session.created',
      'session.title.updated',
      'session.execution.started',
      'model.completed',
      'session.idle',
    ]);
    const modelEvent = events.find((e) => e.type === 'model.completed')!;
    assert.equal(modelEvent.source, 'learnharness');
    assert.equal(modelEvent.project, 'learnharness');
    assert.equal(modelEvent.inputTokens, 100);
    assert.equal(modelEvent.outputTokens, 40);
    assert.equal(modelEvent.status, 'ok');
    const titleEvent = events.find((e) => e.type === 'session.title.updated')!;
    assert.equal(titleEvent.title, 'Estudio: Grafos');

    // Privacy check: no prompt, answer, or API key leaked
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('SECRET_PROMPT_SHOULD_NOT_BE_IN_TELEMETRY'), false);
    assert.equal(serialized.includes('SECRET_ANSWER_SHOULD_NOT_BE_IN_TELEMETRY'), false);
    assert.equal(serialized.includes('sk-secret-user-key'), false);

    // 4. Streaming SSE completion reuses the same sessionId and injects stream_options
    const firstSessionId = modelEvent.sessionId;
    const sseRes = await fetch(`http://127.0.0.1:${proxyPort}/learnharness/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hola' }],
      }),
    });
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('"Hola"'));
    assert.deepEqual(receivedStreamOptions, { include_usage: true });

    const modelEvents = events.filter((e) => e.type === 'model.completed');
    assert.equal(modelEvents.length, 2);
    assert.equal(modelEvents[1].sessionId, firstSessionId);
    assert.equal(receivedOpenCodeSessions[0], firstSessionId);
    assert.equal(receivedOpenCodeSessions[1], firstSessionId);
    assert.equal(modelEvents[1].inputTokens, 300);
    assert.equal(modelEvents[1].cacheReadTokens, 200);
    assert.equal(modelEvents[1].outputTokens, 75);

    // 5. Upstream 429 error emits error model span and session.error
    const errRes = await fetch(`http://127.0.0.1:${proxyPort}/learnharness/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fail-model', messages: [] }),
    });
    assert.equal(errRes.status, 429);
    const allModelEvents = events.filter((e) => e.type === 'model.completed');
    assert.equal(allModelEvents.length, 3);
    assert.equal(allModelEvents[2].status, 'error');
    assert.equal((allModelEvents[2].attributes as Record<string, string>).error_code, 'rate_limit_exceeded');
    assert.equal(events.at(-1)?.type, 'session.error');
  } finally {
    await sender.shutdown();
    await close(proxy);
    await close(upstream);
  }
});

test('TelemetrySender posts events with X-Telemetry-Key and X-Telemetry-Protocol headers', async () => {
  const received: Array<{ key?: string; protocol?: string; body: TelemetryPayload }> = [];
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TelemetryPayload;
    received.push({
      key: req.headers['x-telemetry-key'] as string | undefined,
      protocol: req.headers['x-telemetry-protocol'] as string | undefined,
      body,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true, duplicate: false }));
  });
  const collectorPort = await listen(collector);

  const upstream = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'c1',
        model: 'kimi-k2.5',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  const upstreamPort = await listen(upstream);

  const { server: proxy, sender } = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    collectorUrl: `http://127.0.0.1:${collectorPort}`,
    apiKey: 'test-telemetry-key-123',
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/learnharness/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k2.5', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const deadline = Date.now() + 2000;
    while (received.length < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(received.length, 5);
    assert.ok(received.every((item) => item.key === 'test-telemetry-key-123'));
    assert.ok(received.every((item) => item.protocol === '1'));
    assert.deepEqual(
      received.map((item) => item.body.type),
      ['session.created', 'session.title.updated', 'session.execution.started', 'model.completed', 'session.idle'],
    );
  } finally {
    await sender.shutdown();
    await close(proxy);
    await close(upstream);
    await close(collector);
  }
});
