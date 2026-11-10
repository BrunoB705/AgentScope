import { Plugin } from '@opencode/plugin';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type Event = { id?: string; created?: number; type: string; data?: Record<string, unknown>; location?: { directory?: string } };
type Telemetry = Record<string, unknown>;
const get = (value: unknown, key: string): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
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
export function mapOpenCodeEvent(event: Event, fallbackProject = 'opencode'): Telemetry[] {
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
        name: 'model', status: finish === 'error' ? 'error' : 'ok',
        inputTokens: numeric(get(tokens, 'input')), outputTokens: numeric(get(tokens, 'output')),
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
          for (const mapped of mapOpenCodeEvent(event as Event, fallbackProject)) enqueue(mapped);
        }
      } catch { /* Abort during plugin shutdown or a transient event stream failure. */ }
    })();
    return () => controller.abort();
  },
});
