import { Plugin } from '@opencode/plugin';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Event = { id?: string; created?: number; type: string; data?: Record<string, unknown>; location?: { directory?: string } };
export type Telemetry = Record<string, unknown>;
export type DeliveryResult = 'ok' | 'retry' | 'permanent';
export type TelemetryQueueOptions = { max?: number; attempts?: number; attemptDelayMs?: number; retryDelayMs?: number; persistPath?: string; signal?: AbortSignal; onDrop?: (dropped: number) => void; onPermanent?: (event: Telemetry) => void; onRetry?: (failures: number) => void };
type ModelCost = { tier?: { type?: string; size?: number }; input?: number; output?: number; cache?: { read?: number; write?: number } };
const get = (value: unknown, key: string): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
/** Un contador ausente no es cero: se omite para que el backend guarde NULL. */
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const date = (value?: number) => new Date(typeof value === 'number' ? value : Date.now()).toISOString();
const basename = (path?: string) => path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const session = (event: Event) => str(event.data?.sessionID);
const modelLabel = (data: Record<string, unknown>) => {
  const model = get(data, 'model');
  const direct = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  const id = direct ? undefined : (str(get(model, 'id')) ?? str(get(model, 'modelID')) ?? str(get(data, 'modelID')));
  const provider = str(get(model, 'providerID')) ?? str(get(data, 'providerID'));
  const base = direct ?? (id ? (provider && !id.includes('/') ? `${provider}/${id}` : id) : undefined);
  if (!base) return undefined;
  const variant = str(get(model, 'variant')) ?? str(get(data, 'variant'));
  return variant && !base.includes('#') ? `${base}#${variant}` : base;
};
const baseModelId = (model?: string) => model?.split('#')[0];
export type QuotaEstimate = { value?: number; missingReason?: string; snapshot?: string };

/**
 * La cuota Go es una estimación local: el número solo no alcanza para auditarla.
 * Se devuelve además el motivo cuando no hay valor y el snapshot de tarifas
 * aplicadas, para que una estimación histórica se pueda reproducir.
 */
export function estimateGoAllowance(
  model: string | undefined,
  tokens: unknown,
  modelInfo?: Record<string, unknown>,
): QuotaEstimate {
  if (!model) return { missingReason: 'model_unknown' };
  if (!model.startsWith('opencode-go/')) return { missingReason: 'not_applicable' };
  const costTiers = get(modelInfo, 'cost');
  if (!Array.isArray(costTiers) || costTiers.length === 0) return { missingReason: 'no_catalog' };
  const input = finite(get(tokens, 'input'));
  const output = finite(get(tokens, 'output'));
  const cache = get(tokens, 'cache');
  const cacheRead = finite(get(cache, 'read'));
  const cacheWrite = finite(get(cache, 'write'));
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
    return { missingReason: 'tokens_missing' };
  const contextSize = input + cacheRead + cacheWrite;
  const applicable = (costTiers as ModelCost[])
    .filter(tier => !tier.tier || tier.tier.type !== 'context' || contextSize >= (tier.tier.size ?? Number.POSITIVE_INFINITY))
    .sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0))
    .at(-1);
  if (!applicable) return { missingReason: 'no_rate' };
  if (![applicable.input, applicable.output, applicable.cache?.read, applicable.cache?.write].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0))
    return { missingReason: 'incomplete_rate' };
  // OpenCode output tokens already include reasoning; input excludes cached tokens.
  const value = (input * applicable.input! + output * applicable.output! + cacheRead * applicable.cache!.read! + cacheWrite * applicable.cache!.write!) / 1_000_000;
  const snapshot = JSON.stringify({
    input: applicable.input,
    output: applicable.output,
    cacheRead: applicable.cache!.read,
    cacheWrite: applicable.cache!.write,
    tier: applicable.tier ?? null,
  });
  return { value, snapshot };
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

export const TELEMETRY_PROTOCOL_VERSION = 1;

/** Only per-event rejections are permanent; credential, protocol mismatch, and transient failures affect every queued event, so they must stay queued. */
export function deliveryResultForStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return 'ok';
  const affectsAllEvents = status === 401 || status === 403 || status === 408 || status === 426 || status === 429;
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
  private inFlight: Telemetry | undefined;
  private disposed = false;
  private restoring: Promise<void> | undefined;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(send: (event: Telemetry) => Promise<DeliveryResult>, options: TelemetryQueueOptions = {}) {
    this.send = send;
    this.options = options;
    options.signal?.addEventListener('abort', () => this.dispose());
    if (options.persistPath) {
      this.restoring = this.restoreFromDisk().then(() => {
        this.restoring = undefined;
        if (!this.disposed && this.pending.length > 0) void this.flush();
      });
    }
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
    if (this.pending.length >= (this.options.max ?? 100)) this.dropOldestEnqueued();
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
    if (this.pending.length > 0) void this.persistToDisk();
  }

  async shutdown(timeoutMs = 500): Promise<void> {
    if (!this.disposed && (this.pending.length > 0 || this.running || this.restoring)) {
      await Promise.race([
        this.flush(),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    }
    this.dispose();
    await this.persistToDisk();
  }

  /** The in-flight event is already being delivered, so dropping it would report a loss that did not happen. */
  private dropOldestEnqueued(): void {
    if (this.pending[0] === this.inFlight) {
      if (this.pending.length < 2) return;
      this.pending.splice(1, 1);
    } else {
      this.pending.shift();
    }
    this.dropped++;
    this.options.onDrop?.(this.dropped);
    void this.persistToDisk();
  }

  private async restoreFromDisk(): Promise<void> {
    const path = this.options.persistPath;
    if (!path || this.disposed) return;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const limit = this.options.max ?? 100;
      const restored = parsed.filter((item): item is Telemetry => Boolean(item) && typeof item === 'object');
      if (restored.length === 0) return;
      const combined = [...restored, ...this.pending];
      if (combined.length > limit) {
        const overflow = combined.length - limit;
        combined.splice(0, overflow);
        this.dropped += overflow;
        this.options.onDrop?.(this.dropped);
      }
      this.pending.splice(0, this.pending.length, ...combined);
    } catch {
      /* Sin archivo previo o ilegible: la cola arranca vacía sin bloquear OpenCode. */
    }
  }

  private persistToDisk(): Promise<void> {
    const path = this.options.persistPath;
    if (!path) return Promise.resolve();
    const snapshot = this.pending.map(item => ({ ...item }));
    this.persistChain = this.persistChain.then(async () => {
      try {
        if (snapshot.length === 0) {
          await unlink(path).catch(() => undefined);
          return;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(snapshot), 'utf8');
      } catch {
        /* Persistencia best-effort: nunca bloquear OpenCode por errores de disco. */
      }
    });
    return this.persistChain;
  }

  private async drain(): Promise<void> {
    if (this.restoring) await this.restoring;
    while (this.pending.length > 0 && !this.disposed) {
      const event = this.pending[0];
      this.inFlight = event;
      let result: DeliveryResult;
      try {
        result = await this.sendWithAttempts(event);
      } finally {
        this.inFlight = undefined;
      }
      if (result === 'retry') {
        if (this.disposed) return;
        this.failures++;
        if (this.failures === 1) this.options.onRetry?.(this.failures);
        void this.persistToDisk();
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
    if (!this.disposed && this.pending.length === 0) void this.persistToDisk();
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

/**
 * Decide cuándo consultar el título de una sesión como respaldo. La fuente primaria es el evento
 * `session.renamed`; el sondeo sólo se intenta un número acotado de veces con espera creciente.
 */
export class TitleLookupPolicy {
  private readonly known = new Set<string>();
  private readonly attempts = new Map<string, { count: number; last: number }>();
  private readonly delaysMs: readonly number[];
  constructor(delaysMs: readonly number[] = [0, 30_000, 120_000, 600_000]) { this.delaysMs = delaysMs; }

  markKnown(sessionId: string): void {
    this.known.add(sessionId);
    this.attempts.delete(sessionId);
  }

  isKnown(sessionId: string): boolean { return this.known.has(sessionId); }

  /** Devuelve true y registra el intento si corresponde consultar ahora. */
  tryAcquire(sessionId: string, now = Date.now()): boolean {
    if (this.known.has(sessionId)) return false;
    const state = this.attempts.get(sessionId);
    const count = state?.count ?? 0;
    if (count >= this.delaysMs.length) return false;
    if (state && now - state.last < this.delaysMs[count]) return false;
    this.attempts.set(sessionId, { count: count + 1, last: now });
    return true;
  }
}

/** Maps only scalar metadata from OpenCode v2 events; message, tool input/output are never copied. */
export function mapOpenCodeEvent(event: Event, fallbackProject = 'opencode', step?: { model?: string; started?: number; modelInfo?: Record<string, unknown>; toolName?: string; catalogFetchedAt?: string; agent?: string }): Telemetry[] {
  const sid = session(event);
  if (!sid) return [];
  const data = event.data ?? {};
  const project = basename(event.location?.directory) ?? fallbackProject;
  const common = { source: 'opencode', sessionId: sid, timestamp: date(event.created), project, protocolVersion: TELEMETRY_PROTOCOL_VERSION };
  const payload = (type: string, extras: Record<string, unknown> = {}): Telemetry => ({
    eventId: `${type}:${event.id ?? `${sid}:${event.created ?? Date.now()}`}`,
    ...common, type, status: 'ok', attributes: { opencode_event: event.type }, ...extras,
  });
  switch (event.type) {
    case 'session.created':
    case 'session.forked': {
      const parentSessionId = str(get(data, 'parentID'));
      const agent = str(get(data, 'agent'));
      return [payload(event.type, {
        status: 'active',
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(agent ? { agent } : {}),
      })];
    }
    case 'session.agent.selected': {
      const agent = str(get(data, 'agent'));
      return agent ? [payload('session.agent.selected', { agent })] : [];
    }
    case 'session.renamed': {
      const title = str(get(data, 'title'));
      return title ? [payload('session.title.updated', { title })] : [];
    }
    case 'session.idle': return [payload(event.type, { status: 'completed' })];
    case 'session.execution.started': return [payload(event.type, { status: 'active' })];
    case 'session.execution.succeeded': return [payload(event.type, { status: 'completed' })];
    case 'session.execution.interrupted': return [payload('session.idle', { status: 'interrupted' })];
    case 'session.execution.failed': {
      const error = get(data, 'error');
      const code = str(get(error, 'type')) ?? 'execution_failed';
      return [payload('session.error', { status: 'error', attributes: { opencode_event: event.type, error_code: code } })];
    }
    case 'session.model.selected':
    case 'session.step.started': {
      const model = modelLabel(data);
      const agent = str(get(data, 'agent'));
      if (!model) return agent ? [payload('session.agent.selected', { agent })] : [];
      return [payload('session.model.selected', {
        eventId: `model-selection:${event.id ?? `${sid}:${event.created ?? Date.now()}`}`,
        model,
        ...(agent ? { agent } : {}),
      })];
    }
    case 'session.step.ended': {
      const tokens = get(data, 'tokens');
      const finish = str(get(data, 'finish'));
      const directModel = modelLabel(data);
      const resolvedModel = directModel ?? step?.model;
      const resolvedAgent = str(get(data, 'agent')) ?? step?.agent;
      const resolution = directModel ? 'event' : step?.model ? 'step' : 'unknown';
      const quota = estimateGoAllowance(resolvedModel, tokens, step?.modelInfo);
      return [payload('model.completed', {
        eventId: `model:${str(get(data, 'assistantMessageID')) ?? event.id ?? sid}`,
        name: resolvedModel ?? 'model', model: resolvedModel,
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
        status: finish === 'error' ? 'error' : 'ok',
        timestamp: date(step?.started ?? event.created),
        durationMs: typeof step?.started === 'number' && typeof event.created === 'number' ? Math.max(0, event.created - step.started) : undefined,
        cost: finite(get(data, 'cost')),
        inputTokens: count(get(tokens, 'input')), outputTokens: count(get(tokens, 'output')),
        reasoningTokens: count(get(tokens, 'reasoning')),
        cacheReadTokens: count(get(get(tokens, 'cache'), 'read')),
        cacheWriteTokens: count(get(get(tokens, 'cache'), 'write')),
        quotaCostEstimate: quota.value,
        quotaMissingReason: quota.missingReason,
        quotaRateSnapshot: quota.snapshot,
        quotaCatalogFetchedAt: quota.value === undefined ? undefined : step?.catalogFetchedAt,
        attributes: {
          opencode_event: event.type,
          model_resolution: resolution,
          ...(finish === 'error' ? { error_code: 'model_error' } : {}),
        },
      })];
    }
    case 'session.tool.called':
      return [];
    case 'session.tool.success':
    case 'session.tool.failed': {
      const metadata = get(data, 'metadata');
      const native = get(data, 'native');
      const name = str(get(metadata, 'tool')) ?? str(get(metadata, 'name')) ?? str(get(native, 'name')) ?? str(get(data, 'name')) ?? step?.toolName ?? 'tool';
      const assistantMessageId = str(get(data, 'assistantMessageID'));
      return [payload('tool.completed', {
        eventId: `tool:${str(get(data, 'id')) ?? event.id ?? sid}`,
        ...(assistantMessageId ? { parentId: `model:${assistantMessageId}` } : {}),
        ...(step?.agent ? { agent: step.agent } : {}),
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
    const stepByMessage = new Map<string, { model: string; started: number; modelInfo?: Record<string, unknown>; catalogFetchedAt?: string; agent?: string }>();
    const modelBySession = new Map<string, string>();
    const agentBySession = new Map<string, string>();
    const modelInfoById = new Map<string, Record<string, unknown>>();
    const titleLookup = new TitleLookupPolicy();
    const titleBySession = new Map<string, string>();
    const toolNameById = new Map<string, string>();
    const toolStartedAtById = new Map<string, number>();
    let catalogFetchedAt: string | undefined;
    try {
      const models = await ctx.model.list({ location: { directory: ctx.location.directory } });
      for (const model of models.data) modelInfoById.set(`${model.providerID}/${model.modelID}`, model as unknown as Record<string, unknown>);
      catalogFetchedAt = new Date().toISOString();
    } catch { /* Model pricing is optional; keep collecting usage when unavailable. */ }
    const controller = new AbortController();
    let credentialsWarned = false;
    let protocolWarned = false;
    const queue = new TelemetryQueue(async (body): Promise<DeliveryResult> => {
      try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/telemetry/events`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-telemetry-key': apiKey, 'x-telemetry-protocol': String(TELEMETRY_PROTOCOL_VERSION) },
          body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1800)]),
        });
        if ((response.status === 401 || response.status === 403) && !credentialsWarned) {
          credentialsWarned = true;
          console.warn('Agent Observability: la clave de telemetría fue rechazada; los eventos quedan en cola hasta corregirla.');
        }
        if (response.status === 426 && !protocolWarned) {
          protocolWarned = true;
          console.warn('Agent Observability: versión de protocolo incompatible entre el plugin y la API; actualiza el plugin o el colector.');
        }
        return deliveryResultForStatus(response.status);
      } catch {
        /* Collector may be stopped; OpenCode must keep working. */
        return 'retry';
      }
    }, {
      signal: controller.signal,
      persistPath: process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AgentObservabilityPlatform', 'telemetry-queue.json') : undefined,
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
            if (str(item.title)) { titleBySession.set(sessionId, str(item.title)!); titleLookup.markKnown(sessionId); }
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
              titleLookup.markKnown(sessionId);
              queue.enqueue({ eventId: `session-title:${sessionId}`, source: 'opencode', sessionId, timestamp: date(), type: 'session.title.updated', title, project: fallbackProject, protocolVersion: TELEMETRY_PROTOCOL_VERSION });
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
          if (sid && renamedTitle) { titleBySession.set(sid, renamedTitle); titleLookup.markKnown(sid); }
          if (sid && !titleBySession.has(sid) && titleLookup.tryAcquire(sid)) {
            try {
              const sessionInfo = await (ctx.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }).get({ sessionID: sid });
              const infoObj = get(sessionInfo, 'data') ?? sessionInfo;
              const title = str(get(infoObj, 'title'));
              const parentSessionId = str(get(infoObj, 'parentID'));
              const sessionAgent = str(get(infoObj, 'agent'));
              if (sessionAgent) agentBySession.set(sid, sessionAgent);
              if (title) {
                titleBySession.set(sid, title);
                titleLookup.markKnown(sid);
                queue.enqueue({
                  eventId: `session-title:${sid}`, source: 'opencode', sessionId: sid, timestamp: date(), type: 'session.title.updated', title,
                  ...(parentSessionId ? { parentSessionId } : {}),
                  ...(sessionAgent ? { agent: sessionAgent } : {}),
                  project: basename(current.location?.directory) ?? fallbackProject, protocolVersion: TELEMETRY_PROTOCOL_VERSION,
                });
              } else if (parentSessionId || sessionAgent) {
                queue.enqueue({
                  eventId: `session-meta:${sid}`, source: 'opencode', sessionId: sid, timestamp: date(), type: 'session.agent.selected',
                  ...(parentSessionId ? { parentSessionId } : {}),
                  ...(sessionAgent ? { agent: sessionAgent } : {}),
                  project: basename(current.location?.directory) ?? fallbackProject, protocolVersion: TELEMETRY_PROTOCOL_VERSION,
                });
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
          const eventAgent = str(get(current.data, 'agent'));
          if (sid && eventAgent) agentBySession.set(sid, eventAgent);
          const step = current.type === 'session.step.ended' ? (messageId ? stepByMessage.get(messageId) : undefined) : undefined;
          const directModel = current.type === 'session.step.ended' ? modelLabel(current.data ?? {}) : undefined;
          const stepModel = directModel ?? step?.model;
          const stepModelInfo = step?.modelInfo ?? (stepModel ? modelInfoById.get(baseModelId(stepModel)!) : undefined);
          for (const mapped of mapOpenCodeEvent(current, fallbackProject, {
            model: stepModel,
            started: step?.started ?? toolStartedAt,
            modelInfo: stepModelInfo,
            toolName,
            catalogFetchedAt: step?.catalogFetchedAt ?? catalogFetchedAt,
            agent: step?.agent ?? (sid ? agentBySession.get(sid) : undefined),
          })) queue.enqueue(mapped);
          if (sid && directModel) modelBySession.set(sid, directModel);
          if (sid && (current.type === 'session.model.selected' || current.type === 'session.step.started')) {
            const model = modelLabel(current.data ?? {});
            if (model) modelBySession.set(sid, model);
            if (current.type === 'session.step.started' && messageId) {
              const startedModel = model ?? modelBySession.get(sid);
              if (startedModel) {
                const started = finite(get(current.data, 'started'));
                stepByMessage.set(messageId, {
                  model: startedModel,
                  started: started ?? current.created ?? Date.now(),
                  modelInfo: modelInfoById.get(baseModelId(startedModel)!),
                  catalogFetchedAt,
                  agent: eventAgent ?? agentBySession.get(sid),
                });
              }
            }
          }
          if (current.type === 'session.step.ended' && messageId) stepByMessage.delete(messageId);
        }
      } catch { /* Abort during plugin shutdown or a transient event stream failure. */ }
    })();
    return () => { void queue.shutdown().finally(() => controller.abort()); };
  },
});
