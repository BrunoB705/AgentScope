import { Plugin } from '@opencode/plugin';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type Event = { id?: string; created?: number; type: string; data?: Record<string, unknown>; location?: { directory?: string } };
type Telemetry = Record<string, unknown>;
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

/** Maps only scalar metadata from OpenCode v2 events; message, tool input/output are never copied. */
export function mapOpenCodeEvent(event: Event, fallbackProject = 'opencode', step?: { model?: string; started?: number; modelInfo?: Record<string, unknown> }): Telemetry[] {
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
    case 'session.tool.success':
    case 'session.tool.failed': {
      const metadata = get(data, 'metadata');
      const name = str(get(metadata, 'tool')) ?? 'tool';
      return [payload('tool.completed', {
        eventId: `tool:${str(get(data, 'id')) ?? event.id ?? sid}`,
        parentId: `model:${str(get(data, 'assistantMessageID')) ?? ''}`,
        name, status: event.type.endsWith('.failed') ? 'error' : 'ok',
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
    const queue: Telemetry[] = [];
    const stepByMessage = new Map<string, { model: string; started: number; modelInfo?: Record<string, unknown> }>();
    const modelBySession = new Map<string, string>();
    const modelInfoById = new Map<string, Record<string, unknown>>();
    try {
      const models = await ctx.model.list({ location: { directory: ctx.location.directory } });
      for (const model of models.data) modelInfoById.set(`${model.providerID}/${model.modelID}`, model as unknown as Record<string, unknown>);
    } catch { /* Model pricing is optional; keep collecting usage when unavailable. */ }
    const controller = new AbortController();
    let flushing = false;
    const enqueue = (event: Telemetry) => { queue.push(event); if (queue.length > 100) queue.shift(); void flush(); };
    async function flush() {
      if (flushing) return;
      flushing = true;
      try {
        while (queue.length && !controller.signal.aborted) {
          const body = queue[0]; let sent = false;
          for (let attempt = 0; attempt < 3 && !sent && !controller.signal.aborted; attempt++) {
            try {
              const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/telemetry/events`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-telemetry-key': apiKey },
                body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1800)]),
              });
              sent = response.ok;
            } catch { /* Collector may be stopped; OpenCode must keep working. */ }
            if (!sent && attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          }
          queue.shift();
        }
      } finally { flushing = false; }
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const current = event as Event;
          const sid = session(current);
          const messageId = str(get(current.data, 'assistantMessageID'));
          if (sid && (current.type === 'session.model.selected' || current.type === 'session.step.started')) {
            const model = modelLabel(current.data ?? {});
            if (model) modelBySession.set(sid, model);
            if (current.type === 'session.step.started' && messageId && model) {
              const started = finite(get(current.data, 'started'));
              stepByMessage.set(messageId, { model, started: started ?? current.created ?? Date.now(), modelInfo: modelInfoById.get(model) });
            }
          }
          const step = current.type === 'session.step.ended' ? (messageId ? stepByMessage.get(messageId) : undefined) : undefined;
          const model = step?.model ?? (sid ? modelBySession.get(sid) : undefined);
          for (const mapped of mapOpenCodeEvent(current, fallbackProject, { model, started: step?.started, modelInfo: step?.modelInfo ?? (model ? modelInfoById.get(model) : undefined) })) enqueue(mapped);
          if (current.type === 'session.step.ended' && messageId) stepByMessage.delete(messageId);
        }
      } catch { /* Abort during plugin shutdown or a transient event stream failure. */ }
    })();
    return () => controller.abort();
  },
});
