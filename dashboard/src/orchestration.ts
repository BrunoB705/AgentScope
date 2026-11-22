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

export type SessionTreeRow<T extends { id: string; parentSessionId?: string | null; subagentCount?: number }> = {
  session: T;
  depth: number;
  expandable: boolean;
  expanded: boolean;
};

/** Aplana sesiones raíz y subagentes expandidos respetando profundidad máxima y evitando ciclos. */
export function flattenSessionTree<T extends { id: string; parentSessionId?: string | null; subagentCount?: number }>(
  roots: ReadonlyArray<T>,
  childrenByParent: Readonly<Record<string, ReadonlyArray<T>>>,
  expandedIds: ReadonlySet<string>,
  maxDepth = 4,
): SessionTreeRow<T>[] {
  const rows: SessionTreeRow<T>[] = [];
  const visited = new Set<string>();
  const visit = (items: ReadonlyArray<T>, depth: number) => {
    for (const session of items) {
      if (visited.has(session.id)) continue;
      visited.add(session.id);
      const loadedChildren = childrenByParent[session.id] ?? [];
      const expandable = depth < maxDepth && ((session.subagentCount ?? 0) > 0 || loadedChildren.length > 0);
      const expanded = expandable && expandedIds.has(session.id);
      rows.push({ session, depth, expandable, expanded });
      if (expanded && loadedChildren.length > 0) visit(loadedChildren, depth + 1);
    }
  };
  visit(roots, 0);
  return rows;
}

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
