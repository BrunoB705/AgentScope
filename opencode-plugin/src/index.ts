import type { Plugin } from '@opencode-ai/plugin';

// All OpenCode event shape assumptions live here so the adapter can be updated independently.
type OpenCodeEvent = { type: string; properties?: Record<string, unknown> };
const get = (o: Record<string, unknown> | undefined, key: string) => o?.[key];
  const numeric = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const AgentObservability: Plugin = async () => {
  const endpoint = process.env.OPENCODE_OBSERVABILITY_URL ?? 'http://127.0.0.1:5080';
  const apiKey = process.env.OPENCODE_OBSERVABILITY_KEY ?? '[development-key-removed]';
  const logicalProject = process.env.OPENCODE_OBSERVABILITY_PROJECT ?? 'opencode';
  const queue: unknown[] = [];
  let flushing = false;

  // Bounded in-memory best-effort queue. Never await network I/O from OpenCode hooks.
  const enqueue = (event: Record<string, unknown>) => {
    queue.push(event);
    if (queue.length > 100) queue.shift();
    void flush();
  };
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const body = queue[0];
        let sent = false;
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          try {
            const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/telemetry/events`, {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-telemetry-key': apiKey },
              body: JSON.stringify(body), signal: AbortSignal.timeout(1800),
            });
            sent = response.ok;
          } catch { /* collector may be stopped */ }
          if (!sent && attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        }
        queue.shift(); // drop after bounded retries; collection must never block OpenCode
      }
    } finally { flushing = false; }
  }

  const emit = (type: string, sessionId: string, props?: Record<string, unknown>, extras: Record<string, unknown> = {}) => {
    if (!sessionId) return;
    // Deliberately select safe scalar metadata; never serialize prompt, content, args, or output.
    enqueue({ eventId: extras.eventId ?? id(), source: 'opencode', sessionId, timestamp: extras.timestamp ?? new Date().toISOString(), type,
      project: logicalProject, status: extras.status ?? (type.endsWith('.error') ? 'error' : 'ok'),
      name: extras.name, durationMs: extras.durationMs, model: str(get(props, 'modelID')),
      parentId: extras.parentId,
      inputTokens: numeric(get(get(props, 'tokens') as Record<string, unknown> | undefined, 'input')),
      outputTokens: numeric(get(get(props, 'tokens') as Record<string, unknown> | undefined, 'output')),
      attributes: { opencode_event: type, ...(extras.errorCode ? { error_code: extras.errorCode } : {}) } });
  };

  return {
    event: async ({ event }) => {
      const mapped = event as unknown as OpenCodeEvent;
      const p = mapped.properties;
      const info = get(p, 'info') as Record<string, unknown> | undefined;
      const partInfo = get(p, 'part') as Record<string, unknown> | undefined;
      const sid = str(get(p, 'sessionID')) ?? str(get(p, 'sessionId')) ?? str(get(info, 'id')) ?? str(get(partInfo, 'sessionID'));
      if (!sid) return;
      switch (mapped.type) {
        case 'session.created': emit(mapped.type, sid, p, { status: 'active' }); break;
        case 'session.idle': emit(mapped.type, sid, p, { status: 'completed' }); break;
        case 'session.error': {
          const error = get(p, 'error') as Record<string, unknown> | undefined;
          emit(mapped.type, sid, p, { status: 'error', errorCode: str(get(error, 'name')) ?? 'session_error' });
          break;
        }
        case 'message.updated': {
          const info = get(p, 'info') as Record<string, unknown> | undefined;
          if (str(get(info, 'role')) === 'assistant') {
            const time = get(info, 'time') as Record<string, unknown> | undefined;
            const start = numeric(get(time, 'created')); const end = numeric(get(time, 'completed'));
            // Message updates arrive repeatedly. Emit only the completed assistant turn with a stable ID.
            if (end > 0) {
              const error = get(info, 'error') as Record<string, unknown> | undefined;
              emit('model.completed', sid, info, { eventId: `model:${str(get(info, 'id'))}`, name: str(get(info, 'modelID')) ?? 'model', timestamp: new Date(start).toISOString(), durationMs: Math.max(0, end - start), status: error ? 'error' : 'ok', errorCode: str(get(error, 'name')) });
            }
          }
          break;
        }
        case 'message.part.updated': {
          const part = partInfo;
          if (str(get(part, 'type')) !== 'tool') break;
          const state = get(part, 'state') as Record<string, unknown> | undefined;
          const stateName = str(get(state, 'status'));
          if (stateName !== 'completed' && stateName !== 'error') break;
          const time = get(state, 'time') as Record<string, unknown> | undefined;
          const start = numeric(get(time, 'start')); const end = numeric(get(time, 'end'));
          emit('tool.completed', sid, undefined, { eventId: `tool:${str(get(part, 'callID'))}`, parentId: `model:${str(get(part, 'messageID'))}`, name: str(get(part, 'tool')) ?? 'tool', timestamp: new Date(start).toISOString(), durationMs: Math.max(0, end - start), status: stateName === 'error' ? 'error' : 'ok', errorCode: stateName === 'error' ? 'opencode_tool_error' : undefined });
          break;
        }
        default: break;
      }
    },
  };
};
