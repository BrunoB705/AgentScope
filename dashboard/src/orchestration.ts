export type SessionHierarchyKind = 'orchestrator' | 'subagent' | 'standalone';

export type ParentSessionSummary = {
  id: string;
  title?: string | null;
  agent?: string | null;
  status: string;
  model?: string | null;
};

export type SubagentSummary = {
  id: string;
  title?: string | null;
  agent?: string | null;
  model?: string | null;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  spanCount: number;
  errorCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost?: number | null;
  quotaCostEstimate?: number | null;
  childCount: number;
};

export type RoleBreakdownItem = {
  role: string;
  sessionCount: number;
  calls: number;
  durationMs?: number | null;
  tokens: number | null;
  reportedCost?: number | null;
  quotaEstimate?: number | null;
  errorCount: number;
};

export type ModelRoleItem = {
  role: string;
  calls: number;
  sessionCount: number;
  tokens: number | null;
  averageDurationMs?: number | null;
  outputTokensPerSec?: number | null;
  reportedCost?: number | null;
  quotaEstimate?: number | null;
  errorCount: number;
};

/** Clasifica si una sesión actuó como orquestador (tiene hijos), subagente (tiene padre) o sesión aislada. */
export function classifySessionHierarchy(session: { parentSessionId?: string | null; subagentCount?: number }): SessionHierarchyKind {
  if ((session.subagentCount ?? 0) > 0) return 'orchestrator';
  if (session.parentSessionId) return 'subagent';
  return 'standalone';
}

/** Resume el volumen delegado a los subagentes directos de una sesión. */
export function summarizeDelegation(subagents: ReadonlyArray<SubagentSummary>): {
  count: number;
  distinctRoles: string[];
  totalQuota: number | null;
  totalTokens: number | null;
  errorCount: number;
} {
  const distinctRoles = [...new Set(subagents.map(s => s.agent).filter((role): role is string => Boolean(role)))];
  const quotas = subagents.map(s => s.quotaCostEstimate).filter((value): value is number => typeof value === 'number');
  const tokenValues = subagents
    .map(s => (s.inputTokens == null && s.outputTokens == null ? null : (s.inputTokens ?? 0) + (s.outputTokens ?? 0)))
    .filter((value): value is number => value != null);
  return {
    count: subagents.length,
    distinctRoles,
    totalQuota: quotas.length ? quotas.reduce((sum, value) => sum + value, 0) : null,
    totalTokens: tokenValues.length ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
    errorCount: subagents.reduce((sum, item) => sum + item.errorCount, 0),
  };
}
