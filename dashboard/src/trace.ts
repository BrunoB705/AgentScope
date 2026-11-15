export type TraceSpan = {
  id: string;
  parentId?: string | null;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  durationMs?: number | null;
};

export type TraceEvent = { source: string; eventId: string };

export type WaterfallRow = {
  span: TraceSpan;
  depth: number;
  startPercent: number;
  widthPercent: number;
  durationMs: number;
  hasDuration: boolean;
};

export type Waterfall = {
  rows: WaterfallRow[];
  domainStart: number;
  domainEnd: number;
  totalMs: number;
  hasAnyDuration: boolean;
};

const MAX_DEPTH = 5;
const FALLBACK_DOMAIN_MS = 1000;

const startOf = (span: TraceSpan) => {
  const parsed = Date.parse(span.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const validDuration = (value?: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const depthOf = (span: TraceSpan, byId: Map<string, TraceSpan>) => {
  let depth = 0;
  let parentId = span.parentId;
  const seen = new Set<string>([span.id]);
  while (parentId && depth < MAX_DEPTH && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
};

export function buildWaterfall(spans: TraceSpan[]): Waterfall {
  if (spans.length === 0) {
    return { rows: [], domainStart: 0, domainEnd: 0, totalMs: 0, hasAnyDuration: false };
  }

  const ordered = [...spans].sort((a, b) => {
    const byStart = startOf(a) - startOf(b);
    if (byStart !== 0) return byStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let domainStart = Infinity;
  let domainEnd = -Infinity;
  let hasAnyDuration = false;
  for (const span of ordered) {
    const start = startOf(span);
    const duration = validDuration(span.durationMs);
    if (duration != null) hasAnyDuration = true;
    domainStart = Math.min(domainStart, start);
    domainEnd = Math.max(domainEnd, start + (duration ?? 0));
  }
  if (domainEnd <= domainStart) domainEnd = domainStart + FALLBACK_DOMAIN_MS;

  const totalMs = domainEnd - domainStart;
  const byId = new Map(ordered.map((span) => [span.id, span]));
  const rows = ordered.map((span): WaterfallRow => {
    const duration = validDuration(span.durationMs);
    return {
      span,
      depth: depthOf(span, byId),
      startPercent: clampPercent((startOf(span) - domainStart) / totalMs * 100),
      widthPercent: clampPercent((duration ?? 0) / totalMs * 100),
      durationMs: duration ?? 0,
      hasDuration: duration != null,
    };
  });

  return { rows, domainStart, domainEnd, totalMs, hasAnyDuration };
}

// Replica el `SpanId` del backend (`backend/Program.cs`): la correlación
// error->span es exacta por `source + eventId`, no una heurística temporal.
export function spanIdForEvent(event: TraceEvent): string {
  return `${event.source}:${event.eventId}`;
}

export function findSpanForEvent<T extends TraceSpan>(spans: T[], event: TraceEvent): T | undefined {
  const id = spanIdForEvent(event);
  return spans.find((span) => span.id === id);
}

export function isErrorStatus(status?: string | null): boolean {
  return status === 'error' || status === 'failed';
}
