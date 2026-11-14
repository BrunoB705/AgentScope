import { Plugin } from '@opencode/plugin';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type Event = { id?: string; created?: number; type: string; data?: Record<string, unknown>; location?: { directory?: string } };
export type Telemetry = Record<string, unknown>;
export type DeliveryResult = 'ok' | 'retry' | 'permanent';
export type TelemetryQueueOptions = { max?: number; attempts?: number; attemptDelayMs?: number; retryDelayMs?: number; signal?: AbortSignal; onDrop?: (dropped: number) => void; onPermanent?: (event: Telemetry) => void; onRetry?: (failures: number) => void };
type ModelCost = { tier?: { type?: string; size?: number }; input?: number; output?: number; cache?: { read?: number; write?: number } };
const get = (value: unknown, key: string): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const date = (value?: number) => new Date(typeof value === 'number' ? value : Date.now()).toISOString();
const basename = (path?: string) => path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const session = (event: Event) => str(event.data?.sessionID);
const modelLabel = (data: Record<string, unknown>) => {
  const model = get(data, 'model');
  const id = str(get(model, 'id'));
  if (!id) return undefined;
  const provider = str(get(model, 'providerID'));
  return provider ? `${provider}/${id}` : id;
};
function estimateGoAllowance(tokens: unknown, modelInfo?: Record<string, unknown>): number | undefined {
  const costTiers = get(modelInfo, 'cost');
  if (!Array.isArray(costTiers) || costTiers.length === 0) return undefined;
  const input = finite(get(tokens, 'input'));
  const output = finite(get(tokens, 'output'));
  const cache = get(tokens, 'cache');
  const cacheRead = finite(get(cache, 'read'));
  const cacheWrite = finite(get(cache, 'write'));
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const contextSize = input + cacheRead + cacheWrite;
  const applicable = (costTiers as ModelCost[])
    .filter(tier => !tier.tier || tier.tier.type !== 'context' || contextSize >= (tier.tier.size ?? Number.POSITIVE_INFINITY))
    .sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0))
    .at(-1);
  if (!applicable || ![applicable.input, applicable.output, applicable.cache?.read, applicable.cache?.write].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return undefined;
  // OpenCode output tokens already include reasoning; input excludes cached tokens.
  return (input * applicable.input! + output * applicable.output! + cacheRead * applicable.cache!.read! + cacheWrite * applicable.cache!.write!) / 1_000_000;
}

async function resolveApiKey(): Promise<string | undefined> {
  const fromEnvironment = process.env.OPENCODE_OBSERVABILITY_KEY;
  if (fromEnvironment) return fromEnvironment;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  try {
    return (await readFile(join(localAppData, 'AgentObservabilityPlatform', 'telemetry.key'), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Only per-event rejections are permanent; credential and transient failures affect every queued event, so they must stay queued. */
export function deliveryResultForStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return 'ok';
  const affectsAllEvents = status === 401 || status === 403 || status === 408 || status === 429;
  if (status >= 400 && status < 500 && !affectsAllEvents) return 'permanent';
  return 'retry';
}

/** Bounded outbox: keeps events until the collector accepts them, and reports drops and retry streaks instead of losing them silently. */
export class TelemetryQueue {
  private readonly pending: Telemetry[] = [];
  private readonly send: (event: Telemetry) => Promise<DeliveryResult>;
  private readonly options: TelemetryQueueOptions;
  private dropped = 0;
  private rejected = 0;
  private failures = 0;
  private running: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(send: (event: Telemetry) => Promise<DeliveryResult>, options: TelemetryQueueOptions = {}) {
    this.send = send;
    this.options = options;
    options.signal?.addEventListener('abort', () => this.dispose());
  }

  peek(): Telemetry | undefined {
    return this.pending[0];
  }

  get size(): number {
    return this.pending.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get rejectedCount(): number {
    return this.rejected;
  }

  enqueue(event: Telemetry): void {
    if (this.disposed) return;
    if (this.pending.length >= (this.options.max ?? 100)) {
      this.pending.shift();
      this.dropped++;
      this.options.onDrop?.(this.dropped);
    }
    this.pending.push(event);
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.clearRetry();
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && !this.disposed) {
      const event = this.pending[0];
      const result = await this.sendWithAttempts(event);
      if (result === 'retry') {
        if (this.disposed) return;
        this.failures++;
        if (this.failures === 1) this.options.onRetry?.(this.failures);
        this.scheduleRetry();
        return;
      }
      if (this.pending[0] === event) this.pending.shift();
      this.failures = 0;
      if (result === 'permanent') {
        this.rejected++;
        this.options.onPermanent?.(event);
      }
    }
  }

  private async sendWithAttempts(event: Telemetry): Promise<DeliveryResult> {
    const attempts = this.options.attempts ?? 3;
    const attemptDelayMs = this.options.attemptDelayMs ?? 300;
    for (let attempt = 0; attempt < attempts && !this.disposed; attempt++) {
      const result = await this.trySend(event);
      if (result !== 'retry') return result;
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, attemptDelayMs * (attempt + 1)));
    }
    return 'retry';
  }

  private async trySend(event: Telemetry): Promise<DeliveryResult> {
    try {
      return await this.send(event);
    } catch {
      /* The collector may be stopped; the event stays queued for the next attempt. */
      return 'retry';
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.options.retryDelayMs ?? 5000);
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

/** Maps only scalar metadata from OpenCode v2 events; message, tool input/output are never copied. */
export function mapOpenCodeEvent(event: Event, fallbackProject = 'opencode', step?: { model?: string; started?: number; modelInfo?: Record<string, unknown>; toolName?: string }): Telemetry[] {
  const sid = session(event);
  if (!sid) return [];
  const data = event.data ?? {};
  const project = basename(event.location?.directory) ?? fallbackProject;
  const common = { source: 'opencode', sessionId: sid, timestamp: date(event.created), project };
  const payload = (type: string, extras: Record<string, unknown> = {}): Telemetry => ({
    eventId: `${type}:${event.id ?? `${sid}:${event.created ?? Date.now()}`}`,
    ...common, type, status: 'ok', attributes: { opencode_event: event.type }, ...extras,
  });
  switch (event.type) {
    case 'session.created': return [payload(event.type, { status: 'active' })];
    case 'session.renamed': {
      const title = str(get(data, 'title'));
      return title ? [payload('session.title.updated', { title })] : [];
    }
    case 'session.idle': return [payload(event.type, { status: 'completed' })];
    case 'session.execution.started': return [payload(event.type, { status: 'active' })];
    case 'session.execution.succeeded': return [payload(event.type, { status: 'completed' })];
    case 'session.execution.interrupted': return [payload('session.idle', { status: 'completed' })];
    case 'session.execution.failed': {
      const error = get(data, 'error');
      const code = str(get(error, 'type')) ?? 'execution_failed';
      return [payload('session.error', { status: 'error', attributes: { opencode_event: event.type, error_code: code } })];
    }
    case 'session.model.selected':
    case 'session.step.started': {
      const model = modelLabel(data);
      if (!model) return [];
      return [payload('session.model.selected', {
        eventId: `model-selection:${event.id ?? `${sid}:${event.created ?? Date.now()}`}`,
        model,
      })];
    }
    case 'session.step.ended': {
      const tokens = get(data, 'tokens');
      const finish = str(get(data, 'finish'));
      return [payload('model.completed', {
        eventId: `model:${str(get(data, 'assistantMessageID')) ?? event.id ?? sid}`,
        name: step?.model ?? 'model', model: step?.model,
        status: finish === 'error' ? 'error' : 'ok',
        timestamp: date(step?.started ?? event.created),
        durationMs: typeof step?.started === 'number' && typeof event.created === 'number' ? Math.max(0, event.created - step.started) : undefined,
        cost: finite(get(data, 'cost')),
        inputTokens: numeric(get(tokens, 'input')), outputTokens: numeric(get(tokens, 'output')),
        reasoningTokens: numeric(get(tokens, 'reasoning')),
        cacheReadTokens: numeric(get(get(tokens, 'cache'), 'read')),
        cacheWriteTokens: numeric(get(get(tokens, 'cache'), 'write')),
        quotaCostEstimate: step?.model?.startsWith('opencode-go/') ? estimateGoAllowance(tokens, step.modelInfo) : undefined,
        attributes: { opencode_event: event.type, ...(finish === 'error' ? { error_code: 'model_error' } : {}) },
      })];
    }
    case 'session.tool.called':
      return [];
    case 'session.tool.success':
    case 'session.tool.failed': {
      const metadata = get(data, 'metadata');
      const native = get(data, 'native');
      const name = str(get(metadata, 'tool')) ?? str(get(metadata, 'name')) ?? str(get(native, 'name')) ?? str(get(data, 'name')) ?? step?.toolName ?? 'tool';
      return [payload('tool.completed', {
        eventId: `tool:${str(get(data, 'id')) ?? event.id ?? sid}`,
        parentId: `model:${str(get(data, 'assistantMessageID')) ?? ''}`,
        name, status: event.type.endsWith('.failed') ? 'error' : 'ok',
        timestamp: date(step?.started ?? event.created),
        durationMs: typeof step?.started === 'number' && typeof event.created === 'number' ? Math.max(0, event.created - step.started) : undefined,
        attributes: { opencode_event: event.type, ...(event.type.endsWith('.failed') ? { error_code: 'tool_error' } : {}) },
      })];
    }
    default: return [];
  }
}

export default Plugin.define({
  id: 'agent-observability',
  async setup(ctx) {
    const endpoint = process.env.OPENCODE_OBSERVABILITY_URL ?? 'http://127.0.0.1:5080';
    const apiKey = (await resolveApiKey()) ?? '';
    if (!apiKey) { console.warn('Agent Observability: configura OPENCODE_OBSERVABILITY_KEY para habilitar la ingesta.'); return; }
    const fallbackProject = process.env.OPENCODE_OBSERVABILITY_PROJECT ?? basename(ctx.location.directory) ?? 'opencode';
    const stepByMessage = new Map<string, { model: string; started: number; modelInfo?: Record<string, unknown> }>();
    const modelBySession = new Map<string, string>();
    const modelInfoById = new Map<string, Record<string, unknown>>();
    const titleLookupAt = new Map<string, number>();
    const titleBySession = new Map<string, string>();
    const toolNameById = new Map<string, string>();
    const toolStartedAtById = new Map<string, number>();
    try {
      const models = await ctx.model.list({ location: { directory: ctx.location.directory } });
      for (const model of models.data) modelInfoById.set(`${model.providerID}/${model.modelID}`, model as unknown as Record<string, unknown>);
    } catch { /* Model pricing is optional; keep collecting usage when unavailable. */ }
    const controller = new AbortController();
    let credentialsWarned = false;
    const queue = new TelemetryQueue(async (body): Promise<DeliveryResult> => {
      try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/telemetry/events`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-telemetry-key': apiKey },
          body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1800)]),
        });
        if ((response.status === 401 || response.status === 403) && !credentialsWarned) {
          credentialsWarned = true;
          console.warn('Agent Observability: la clave de telemetría fue rechazada; los eventos quedan en cola hasta corregirla.');
        }
        return deliveryResultForStatus(response.status);
      } catch {
        /* Collector may be stopped; OpenCode must keep working. */
        return 'retry';
      }
    }, {
      signal: controller.signal,
      onDrop: total => console.warn(`Agent Observability: cola llena; se descartaron ${total} eventos en total.`),
      onPermanent: event => console.warn(`Agent Observability: el colector rechazó el evento ${String(event.eventId)}; se descartó sin reintentar.`),
      onRetry: () => console.warn('Agent Observability: no se pudo entregar telemetría; se reintentará con los eventos en cola.'),
    });
    // Recover titles for previously collected sessions across all projects.
    void (async () => {
      try {
        const sessionIds = new Set<string>();
        let page = 1;
        let total = Number.POSITIVE_INFINITY;
        while (sessionIds.size < total) {
          const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/sessions?page=${page}&pageSize=100`, {
            headers: { 'x-telemetry-key': apiKey }, signal: AbortSignal.timeout(1800),
          });
          if (!response.ok) return;
          const result = await response.json() as { items?: Array<{ id?: unknown; title?: unknown }>; total?: number };
          total = typeof result.total === 'number' ? result.total : 0;
          const items = Array.isArray(result.items) ? result.items : [];
          for (const item of items) {
            const sessionId = str(item.id);
            if (!sessionId) continue;
            if (str(item.title)) titleBySession.set(sessionId, str(item.title)!);
            else sessionIds.add(sessionId);
          }
          if (!items.length || items.length < 100) break;
          page++;
        }

        const pending = [...sessionIds];
        const workers = Array.from({ length: 4 }, async () => {
          while (pending.length) {
            const sessionId = pending.pop();
            if (!sessionId) continue;
            try {
              const sessionInfo = await (ctx.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }).get({ sessionID: sessionId });
              const title = str(get(get(sessionInfo, 'data'), 'title')) ?? str(get(sessionInfo, 'title'));
              if (!title) continue;
              titleBySession.set(sessionId, title);
              queue.enqueue({ eventId: `session-title:${sessionId}`, source: 'opencode', sessionId, timestamp: date(), type: 'session.title.updated', title, project: fallbackProject });
            } catch { /* A missing or inaccessible session should not interrupt title recovery. */ }
          }
        });
        await Promise.all(workers);
      } catch { /* Existing titles are a best-effort backfill; telemetry collection still starts. */ }
    })();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const current = event as Event;
          const sid = session(current);
          const messageId = str(get(current.data, 'assistantMessageID'));
          const renamedTitle = current.type === 'session.renamed' ? str(get(current.data, 'title')) : undefined;
          if (sid && renamedTitle) titleBySession.set(sid, renamedTitle);
          if (sid && !titleBySession.has(sid) && Date.now() - (titleLookupAt.get(sid) ?? 0) >= 30_000) {
            titleLookupAt.set(sid, Date.now());
            try {
              const sessionInfo = await (ctx.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }).get({ sessionID: sid });
              // OpenCode's v2 session endpoint wraps its payload in `data`.
              const title = str(get(get(sessionInfo, 'data'), 'title')) ?? str(get(sessionInfo, 'title'));
              if (title) {
                titleBySession.set(sid, title);
                queue.enqueue({ eventId: `session-title:${sid}`, source: 'opencode', sessionId: sid, timestamp: date(), type: 'session.title.updated', title, project: basename(current.location?.directory) ?? fallbackProject });
              }
            } catch { /* Session metadata lookup is optional; live events continue. */ }
          }
          const toolId = str(get(current.data, 'id'));
          if (sid && toolId && current.type === 'session.tool.called') {
            const metadata = get(current, 'metadata');
            const native = get(current.data, 'native');
            const name = str(get(metadata, 'tool')) ?? str(get(metadata, 'name')) ?? str(get(native, 'name')) ?? str(get(current.data, 'name'));
            if (name) toolNameById.set(`${sid}:${toolId}`, name);
            if (typeof current.created === 'number') toolStartedAtById.set(`${sid}:${toolId}`, current.created);
          }
          const toolName = sid && toolId && (current.type === 'session.tool.success' || current.type === 'session.tool.failed') ? toolNameById.get(`${sid}:${toolId}`) : undefined;
          const toolStartedAt = sid && toolId && (current.type === 'session.tool.success' || current.type === 'session.tool.failed') ? toolStartedAtById.get(`${sid}:${toolId}`) : undefined;
          if (sid && toolId && (current.type === 'session.tool.success' || current.type === 'session.tool.failed')) {
            toolNameById.delete(`${sid}:${toolId}`);
            toolStartedAtById.delete(`${sid}:${toolId}`);
          }
          const step = current.type === 'session.step.ended' ? (messageId ? stepByMessage.get(messageId) : undefined) : undefined;
          const model = step?.model ?? (sid ? modelBySession.get(sid) : undefined);
          for (const mapped of mapOpenCodeEvent(current, fallbackProject, { model, started: step?.started ?? toolStartedAt, modelInfo: step?.modelInfo ?? (model ? modelInfoById.get(model) : undefined), toolName })) queue.enqueue(mapped);
          if (sid && (current.type === 'session.model.selected' || current.type === 'session.step.started')) {
            const model = modelLabel(current.data ?? {});
            if (model) modelBySession.set(sid, model);
            if (current.type === 'session.step.started' && messageId && model) {
              const started = finite(get(current.data, 'started'));
              stepByMessage.set(messageId, { model, started: started ?? current.created ?? Date.now(), modelInfo: modelInfoById.get(model) });
            }
          }
          if (current.type === 'session.step.ended' && messageId) stepByMessage.delete(messageId);
        }
      } catch { /* Abort during plugin shutdown or a transient event stream failure. */ }
    })();
    return () => { queue.dispose(); controller.abort(); };
  },
});
