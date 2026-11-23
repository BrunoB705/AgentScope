import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TELEMETRY_PROTOCOL_VERSION = 1;
export const DEFAULT_PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 5081;
export const DEFAULT_UPSTREAM_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_COLLECTOR_URL = 'http://127.0.0.1:5080';
export const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const MAX_JSON_RESPONSE_INSPECT_BYTES = 8 * 1024 * 1024;

const KNOWN_API_ROOTS = new Set([
  'v1',
  'chat',
  'completions',
  'responses',
  'messages',
  'models',
  'embeddings',
]);

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

export type TelemetryPayload = Record<string, unknown>;

export type ParsedRoute = {
  sourceFromPath?: string;
  apiPath: string;
  query: string;
  upstreamUrl: string;
  isInference: boolean;
  endpointTag: string;
};

export type ExtractedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
};

export type ProxyServerOptions = {
  host?: string;
  port?: number;
  upstreamUrl?: string;
  collectorUrl?: string;
  apiKey?: string;
  sessionTimeoutMs?: number;
  injectStreamUsage?: boolean;
  injectOpenCodeSession?: boolean;
  onEvent?: (event: TelemetryPayload) => Promise<void> | void;
  now?: () => number;
};

const get = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function sanitizeTag(raw: string | undefined, maxLen = 80): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxLen);
}

export function parseProxyRoute(rawUrl: string, method: string, upstreamBase: string): ParsedRoute {
  const parsed = new URL(rawUrl || '/', 'http://127.0.0.1');
  const segments = parsed.pathname.split('/').filter(Boolean);

  let sourceFromPath: string | undefined;
  let apiSegments = segments;

  if (segments.length >= 2 && !KNOWN_API_ROOTS.has(segments[0].toLowerCase())) {
    sourceFromPath = sanitizeTag(decodeURIComponent(segments[0]), 80);
    apiSegments = segments.slice(1);
  }

  const apiPath = `/${apiSegments.join('/')}`;
  const cleanUpstream = upstreamBase.replace(/\/+$/, '');
  const upstreamHasV1 = /\/v1$/i.test(cleanUpstream);
  const effectiveApiPath =
    upstreamHasV1 && /^\/v1(\/|$)/i.test(apiPath)
      ? apiPath.replace(/^\/v1/i, '') || '/'
      : apiPath;

  const upstreamUrl = `${cleanUpstream}${effectiveApiPath}${parsed.search}`;
  const normalizedApiPath = apiPath.replace(/\/+$/, '').toLowerCase();
  const isInference =
    method.toUpperCase() === 'POST' &&
    (normalizedApiPath.endsWith('/chat/completions') ||
      normalizedApiPath.endsWith('/completions') ||
      normalizedApiPath.endsWith('/responses') ||
      normalizedApiPath.endsWith('/messages'));

  const endpointTag = normalizedApiPath.replace(/^\/v1\//, '').replace(/^\//, '') || 'root';

  return {
    sourceFromPath,
    apiPath,
    query: parsed.search,
    upstreamUrl,
    isInference,
    endpointTag,
  };
}

export function normalizeModelName(rawModel: string | undefined, upstreamBase: string): string | undefined {
  const trimmed = str(rawModel);
  if (!trimmed) return undefined;
  if (trimmed.includes('/')) return trimmed;
  if (/opencode\.ai\/zen\/go(\/|$)/i.test(upstreamBase)) return `opencode-go/${trimmed}`;
  if (/opencode\.ai\/zen(\/|$)/i.test(upstreamBase)) return `opencode/${trimmed}`;
  return trimmed;
}

export function extractUsageFromObject(rawUsage: unknown): ExtractedUsage {
  if (!rawUsage || typeof rawUsage !== 'object') return {};

  const anthropicCacheRead = count(get(rawUsage, 'cache_read_input_tokens'));
  const anthropicCacheWrite = count(get(rawUsage, 'cache_creation_input_tokens'));
  const isAnthropicStyle =
    anthropicCacheRead !== undefined ||
    anthropicCacheWrite !== undefined ||
    (get(rawUsage, 'input_tokens') !== undefined &&
      get(rawUsage, 'prompt_tokens') === undefined &&
      get(rawUsage, 'input_tokens_details') === undefined);

  const openAiCacheRead =
    count(get(get(rawUsage, 'prompt_tokens_details'), 'cached_tokens')) ??
    count(get(get(rawUsage, 'input_tokens_details'), 'cached_tokens'));

  const cacheReadTokens = anthropicCacheRead ?? openAiCacheRead;
  const cacheWriteTokens = anthropicCacheWrite;

  const rawInput = count(get(rawUsage, 'prompt_tokens')) ?? count(get(rawUsage, 'input_tokens'));
  const inputTokens =
    rawInput === undefined
      ? undefined
      : isAnthropicStyle
        ? rawInput
        : cacheReadTokens !== undefined
          ? Math.max(0, rawInput - cacheReadTokens)
          : rawInput;

  const outputTokens =
    count(get(rawUsage, 'completion_tokens')) ?? count(get(rawUsage, 'output_tokens'));

  const reasoningTokens =
    count(get(get(rawUsage, 'completion_tokens_details'), 'reasoning_tokens')) ??
    count(get(get(rawUsage, 'output_tokens_details'), 'reasoning_tokens')) ??
    count(get(rawUsage, 'reasoning_tokens'));

  const cost = finite(get(rawUsage, 'cost'));

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function mergeUsage(base: ExtractedUsage, next: ExtractedUsage): ExtractedUsage {
  const inputTokens = next.inputTokens ?? base.inputTokens;
  const outputTokens = next.outputTokens ?? base.outputTokens;
  const reasoningTokens = next.reasoningTokens ?? base.reasoningTokens;
  const cacheReadTokens = next.cacheReadTokens ?? base.cacheReadTokens;
  const cacheWriteTokens = next.cacheWriteTokens ?? base.cacheWriteTokens;
  const cost = next.cost ?? base.cost;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function extractErrorCode(payload: unknown): string | undefined {
  const err = get(payload, 'error');
  return (
    sanitizeTag(str(get(err, 'code')), 60) ??
    sanitizeTag(str(get(err, 'type')), 60) ??
    sanitizeTag(str(get(payload, 'code')), 60)
  );
}

/** Incrementally inspects SSE `data:` lines for model, token usage, and error codes without retaining message content. */
export class SseUsageTracker {
  private buffer = '';
  public model: string | undefined;
  public usage: ExtractedUsage = {};
  public errorCode: string | undefined;

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.processLine(line);
    }
  }

  finish(): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
    }
    this.buffer = '';
  }

  private processLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const directModel =
        str(get(parsed, 'model')) ??
        str(get(get(parsed, 'message'), 'model')) ??
        str(get(get(parsed, 'response'), 'model'));
      if (directModel) this.model = directModel;

      const rawUsage =
        get(parsed, 'usage') ??
        get(get(parsed, 'message'), 'usage') ??
        get(get(parsed, 'response'), 'usage');
      if (rawUsage) {
        this.usage = mergeUsage(this.usage, extractUsageFromObject(rawUsage));
      }

      const errCode = extractErrorCode(parsed);
      if (errCode) this.errorCode = errCode;
    } catch {
      /* Ignore non-JSON SSE lines. */
    }
  }
}

export class SessionTracker {
  private readonly sessions = new Map<string, { sessionId: string; lastActivityMs: number; lastEventMs: number }>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(timeoutMs = DEFAULT_SESSION_TIMEOUT_MS, now: () => number = () => Date.now()) {
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  resolve(source: string, explicitSessionId?: string): { sessionId: string; isNew: boolean } {
    const current = this.now();
    const key = explicitSessionId ? `explicit:${explicitSessionId}` : `source:${source}`;
    const existing = this.sessions.get(key);

    if (existing && (explicitSessionId || current - existing.lastActivityMs <= this.timeoutMs)) {
      existing.lastActivityMs = current;
      return { sessionId: existing.sessionId, isNew: false };
    }

    const sessionId = explicitSessionId ?? `proxy-${source}-${randomUUID().slice(0, 8)}`;
    this.sessions.set(key, { sessionId, lastActivityMs: current, lastEventMs: current - 1 });
    return { sessionId, isNew: true };
  }

  nextTimestamp(source: string, explicitSessionId?: string, candidate?: number): number {
    const key = explicitSessionId ? `explicit:${explicitSessionId}` : `source:${source}`;
    const base = candidate ?? this.now();
    const existing = this.sessions.get(key);
    if (!existing) return base;
    const next = Math.max(base, existing.lastEventMs + 1);
    existing.lastEventMs = next;
    return next;
  }
}

export async function resolveApiKey(explicit?: string): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  const fromEnv =
    process.env.OPENCODE_OBSERVABILITY_KEY?.trim() ||
    process.env.TELEMETRY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  try {
    return (
      (await readFile(join(localAppData, 'AgentObservabilityPlatform', 'telemetry.key'), 'utf8')).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export class TelemetrySender {
  private readonly pending: TelemetryPayload[] = [];
  private readonly maxQueue = 500;
  private readonly collectorUrl: string;
  private readonly apiKeyProvider: () => Promise<string | undefined>;
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(collectorUrl: string, apiKeyProvider: () => Promise<string | undefined>) {
    this.collectorUrl = collectorUrl.replace(/\/+$/, '');
    this.apiKeyProvider = apiKeyProvider;
  }

  enqueue(event: TelemetryPayload): void {
    if (this.disposed) return;
    if (this.pending.length >= this.maxQueue) {
      this.pending.shift();
    }
    this.pending.push(event);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0 && !this.disposed) {
        const next = this.pending[0];
        const ok = await this.deliver(next);
        if (ok === 'ok' || ok === 'permanent') {
          this.pending.shift();
        } else {
          this.scheduleRetry();
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, 3000);
  }

  private async deliver(event: TelemetryPayload): Promise<'ok' | 'retry' | 'permanent'> {
    const apiKey = await this.apiKeyProvider();
    if (!apiKey) return 'retry';
    try {
      const response = await fetch(`${this.collectorUrl}/api/v1/telemetry/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telemetry-key': apiKey,
          'x-telemetry-protocol': String(TELEMETRY_PROTOCOL_VERSION),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(2500),
      });
      if (response.status >= 200 && response.status < 300) return 'ok';
      const retryable =
        response.status === 401 ||
        response.status === 403 ||
        response.status === 408 ||
        response.status === 426 ||
        response.status === 429 ||
        response.status >= 500;
      return retryable ? 'retry' : 'permanent';
    } catch {
      return 'retry';
    }
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error('request_body_too_large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function buildUpstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key) || key.startsWith('x-agentscope-')) continue;
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) headers.append(rawKey, item);
    } else if (rawValue !== undefined) {
      headers.set(rawKey, rawValue);
    }
  }
  return headers;
}

function writeUpstreamHeadersToClient(upstream: Response, res: ServerResponse): void {
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
}

export function createProxyServer(options: ProxyServerOptions = {}): {
  server: Server;
  sender: TelemetrySender;
} {
  const upstreamBase = (options.upstreamUrl ?? process.env.AGENTSCOPE_PROXY_UPSTREAM ?? DEFAULT_UPSTREAM_URL).replace(/\/+$/, '');
  const collectorUrl = (options.collectorUrl ?? process.env.OPENCODE_OBSERVABILITY_URL ?? DEFAULT_COLLECTOR_URL).replace(/\/+$/, '');
  const sessionTimeoutMs = options.sessionTimeoutMs ?? Number(process.env.AGENTSCOPE_PROXY_SESSION_TIMEOUT_MS ?? DEFAULT_SESSION_TIMEOUT_MS);
  const injectStreamUsage = options.injectStreamUsage ?? process.env.AGENTSCOPE_PROXY_INJECT_USAGE !== 'false';
  const injectOpenCodeSession =
    options.injectOpenCodeSession ??
    (process.env.AGENTSCOPE_PROXY_OPENCODE_SESSION !== undefined
      ? process.env.AGENTSCOPE_PROXY_OPENCODE_SESSION !== 'false'
      : /opencode\.ai/i.test(upstreamBase));
  const now = options.now ?? (() => Date.now());
  const sessionTracker = new SessionTracker(
    Number.isFinite(sessionTimeoutMs) && sessionTimeoutMs > 0 ? sessionTimeoutMs : DEFAULT_SESSION_TIMEOUT_MS,
    now,
  );

  let cachedKey: string | undefined = options.apiKey;
  const sender = new TelemetrySender(collectorUrl, async () => {
    if (cachedKey) return cachedKey;
    cachedKey = await resolveApiKey(options.apiKey);
    return cachedKey;
  });

  const emit = (event: TelemetryPayload): void => {
    if (options.onEvent) {
      void options.onEvent(event);
    } else {
      sender.enqueue(event);
    }
  };

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';

    if (method === 'GET' && (rawUrl === '/health' || rawUrl.startsWith('/health?'))) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          upstream: upstreamBase,
          collector: collectorUrl,
          protocolVersion: TELEMETRY_PROTOCOL_VERSION,
        }),
      );
      return;
    }

    const route = parseProxyRoute(rawUrl, method, upstreamBase);
    const headerSource = sanitizeTag(str(req.headers['x-agentscope-source']), 80);
    const headerProject = sanitizeTag(str(req.headers['x-agentscope-project']), 120);
    const headerSession = sanitizeTag(str(req.headers['x-agentscope-session']), 200);
    const headerTitle = str(req.headers['x-agentscope-title'])?.slice(0, 200);

    const source = headerSource ?? route.sourceFromPath ?? 'opencode-proxy';
    const project = headerProject ?? source;

    let bodyBuffer: Buffer | undefined;
    let requestModel: string | undefined;
    let isStream = false;

    if (method !== 'GET' && method !== 'HEAD') {
      try {
        bodyBuffer = await readRequestBody(req);
      } catch {
        res.statusCode = 413;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'Request body exceeds proxy limit', type: 'request_too_large' } }));
        return;
      }

      if (route.isInference && bodyBuffer.length > 0) {
        try {
          const parsedBody = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
          requestModel = str(parsedBody.model);
          isStream = parsedBody.stream === true;
          if (
            injectStreamUsage &&
            isStream &&
            route.endpointTag === 'chat/completions' &&
            parsedBody.stream_options === undefined
          ) {
            parsedBody.stream_options = { include_usage: true };
            bodyBuffer = Buffer.from(JSON.stringify(parsedBody), 'utf8');
          }
        } catch {
          /* Non-JSON body; forward as-is. */
        }
      }
    }

    const startedAt = now();
    let sessionId = '';
    let stepStartedAt = startedAt;
    if (route.isInference) {
      const resolved = sessionTracker.resolve(source, headerSession);
      sessionId = resolved.sessionId;

      if (resolved.isNew) {
        const createdTs = sessionTracker.nextTimestamp(source, headerSession, startedAt);
        emit({
          eventId: `session-created:${sessionId}`,
          source,
          sessionId,
          project,
          timestamp: new Date(createdTs).toISOString(),
          type: 'session.created',
          status: 'active',
          protocolVersion: TELEMETRY_PROTOCOL_VERSION,
          attributes: { proxy_endpoint: route.endpointTag },
        });
        const titleTs = sessionTracker.nextTimestamp(source, headerSession, createdTs + 1);
        emit({
          eventId: `session-title:${sessionId}`,
          source,
          sessionId,
          project,
          timestamp: new Date(titleTs).toISOString(),
          type: 'session.title.updated',
          title: headerTitle ?? `${source} (proxy)`,
          protocolVersion: TELEMETRY_PROTOCOL_VERSION,
          attributes: { proxy_endpoint: route.endpointTag },
        });
      }

      stepStartedAt = sessionTracker.nextTimestamp(source, headerSession, startedAt);
      emit({
        eventId: `exec-start:${randomUUID()}`,
        source,
        sessionId,
        project,
        timestamp: new Date(stepStartedAt).toISOString(),
        type: 'session.execution.started',
        status: 'active',
        ...(requestModel ? { model: normalizeModelName(requestModel, upstreamBase) } : {}),
        protocolVersion: TELEMETRY_PROTOCOL_VERSION,
        attributes: { proxy_endpoint: route.endpointTag, stream: String(isStream) },
      });
    }

    const abortController = new AbortController();
    let clientAborted = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        clientAborted = true;
        abortController.abort();
      }
    });

    const upstreamHeaders = buildUpstreamHeaders(req);
    if (route.isInference && injectOpenCodeSession && sessionId && !upstreamHeaders.has('x-opencode-session')) {
      upstreamHeaders.set('x-opencode-session', sessionId);
    }
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(route.upstreamUrl, {
        method,
        headers: upstreamHeaders,
        body: bodyBuffer && bodyBuffer.length > 0 ? new Uint8Array(bodyBuffer) : undefined,
        signal: abortController.signal,
      });
    } catch (error) {
      const finishedAt = sessionTracker.nextTimestamp(source, headerSession, Math.max(now(), stepStartedAt + 1));
      if (route.isInference) {
        const resolvedModel = normalizeModelName(requestModel, upstreamBase);
        const errorCode = clientAborted ? 'client_aborted' : 'upstream_unreachable';
        emit({
          eventId: `model:${randomUUID()}`,
          source,
          sessionId,
          project,
          timestamp: new Date(stepStartedAt).toISOString(),
          type: 'model.completed',
          name: resolvedModel ?? 'model',
          ...(resolvedModel ? { model: resolvedModel } : {}),
          status: 'error',
          durationMs: Math.max(0, finishedAt - startedAt),
          protocolVersion: TELEMETRY_PROTOCOL_VERSION,
          attributes: {
            proxy_endpoint: route.endpointTag,
            stream: String(isStream),
            error_code: errorCode,
          },
        });
        emit({
          eventId: `exec-end:${randomUUID()}`,
          source,
          sessionId,
          project,
          timestamp: new Date(finishedAt).toISOString(),
          type: clientAborted ? 'session.idle' : 'session.error',
          status: clientAborted ? 'interrupted' : 'error',
          protocolVersion: TELEMETRY_PROTOCOL_VERSION,
          attributes: { proxy_endpoint: route.endpointTag, error_code: errorCode },
        });
      }

      if (!res.headersSent) {
        res.statusCode = clientAborted ? 499 : 502;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              message: clientAborted ? 'Client disconnected' : 'Upstream request failed',
              type: clientAborted ? 'client_aborted' : 'upstream_unreachable',
              detail: error instanceof Error ? error.name : 'Error',
            },
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    res.statusCode = upstreamResponse.status;
    writeUpstreamHeadersToClient(upstreamResponse, res);

    const contentType = upstreamResponse.headers.get('content-type') ?? '';
    const isSse = contentType.toLowerCase().includes('text/event-stream');
    const isJson = contentType.toLowerCase().includes('application/json');
    const sseTracker = route.isInference && isSse ? new SseUsageTracker() : undefined;
    const jsonChunks: Buffer[] = [];
    let jsonSize = 0;
    const decoder = sseTracker ? new TextDecoder('utf-8') : undefined;

    let streamError = false;
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (!res.writableEnded) {
            res.write(chunk);
          }
          if (sseTracker && decoder) {
            sseTracker.push(decoder.decode(chunk, { stream: true }));
          } else if (route.isInference && isJson && jsonSize + chunk.length <= MAX_JSON_RESPONSE_INSPECT_BYTES) {
            jsonChunks.push(chunk);
            jsonSize += chunk.length;
          }
        }
        if (sseTracker && decoder) {
          sseTracker.push(decoder.decode());
          sseTracker.finish();
        }
      } catch {
        streamError = true;
      } finally {
        reader.releaseLock();
      }
    }

    if (!res.writableEnded) {
      res.end();
    }

    if (!route.isInference) return;

    let responseModel: string | undefined;
    let usage: ExtractedUsage = {};
    let errorCode: string | undefined;

    if (sseTracker) {
      responseModel = sseTracker.model;
      usage = sseTracker.usage;
      errorCode = sseTracker.errorCode;
    } else if (jsonChunks.length > 0) {
      try {
        const parsedResponse = JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as unknown;
        responseModel =
          str(get(parsedResponse, 'model')) ??
          str(get(get(parsedResponse, 'response'), 'model'));
        const rawUsage =
          get(parsedResponse, 'usage') ??
          get(get(parsedResponse, 'response'), 'usage');
        usage = extractUsageFromObject(rawUsage);
        errorCode = extractErrorCode(parsedResponse);
      } catch {
        /* Ignore malformed JSON response. */
      }
    }

    const finishedAt = sessionTracker.nextTimestamp(source, headerSession, Math.max(now(), stepStartedAt + 1));
    const resolvedModel = normalizeModelName(responseModel ?? requestModel, upstreamBase);
    const isOk = upstreamResponse.status >= 200 && upstreamResponse.status < 300 && !streamError && !clientAborted && !errorCode;
    const finalErrorCode =
      errorCode ??
      (clientAborted ? 'client_aborted' : streamError ? 'stream_interrupted' : !isOk ? `http_${upstreamResponse.status}` : undefined);

    emit({
      eventId: `model:${randomUUID()}`,
      source,
      sessionId,
      project,
      timestamp: new Date(stepStartedAt).toISOString(),
      type: 'model.completed',
      name: resolvedModel ?? 'model',
      ...(resolvedModel ? { model: resolvedModel } : {}),
      status: isOk ? 'ok' : 'error',
      durationMs: Math.max(0, finishedAt - startedAt),
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
      protocolVersion: TELEMETRY_PROTOCOL_VERSION,
      attributes: {
        proxy_endpoint: route.endpointTag,
        http_status: String(upstreamResponse.status),
        stream: String(isStream || isSse),
        ...(finalErrorCode ? { error_code: finalErrorCode } : {}),
      },
    });

    emit({
      eventId: `exec-end:${randomUUID()}`,
      source,
      sessionId,
      project,
      timestamp: new Date(finishedAt).toISOString(),
      type: isOk ? 'session.idle' : clientAborted ? 'session.idle' : 'session.error',
      status: isOk ? 'completed' : clientAborted ? 'interrupted' : 'error',
      protocolVersion: TELEMETRY_PROTOCOL_VERSION,
      attributes: {
        proxy_endpoint: route.endpointTag,
        http_status: String(upstreamResponse.status),
        ...(finalErrorCode ? { error_code: finalErrorCode } : {}),
      },
    });
  });

  return { server, sender };
}

async function main(): Promise<void> {
  const host = process.env.AGENTSCOPE_PROXY_HOST?.trim() || DEFAULT_PROXY_HOST;
  const parsedPort = Number(process.env.AGENTSCOPE_PROXY_PORT ?? DEFAULT_PROXY_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PROXY_PORT;
  const upstreamUrl = process.env.AGENTSCOPE_PROXY_UPSTREAM?.trim() || DEFAULT_UPSTREAM_URL;
  const collectorUrl = process.env.OPENCODE_OBSERVABILITY_URL?.trim() || DEFAULT_COLLECTOR_URL;

  const { server, sender } = createProxyServer({ host, port, upstreamUrl, collectorUrl });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  console.log(`AgentScope Telemetry Proxy listening on http://${host}:${port}`);
  console.log(`Upstream: ${upstreamUrl}`);
  console.log(`Collector: ${collectorUrl}`);

  const shutdown = () => {
    void sender.shutdown().finally(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  void main().catch((error) => {
    console.error('AgentScope Telemetry Proxy failed to start:', error);
    process.exit(1);
  });
}
