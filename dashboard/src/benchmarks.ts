export type BenchmarkTest = {
  name: string;
  type: 'code' | 'open';
  rubric: string[];
  judge: boolean;
};

export type BenchmarkSuite = {
  id: string;
  name: string;
  description?: string | null;
  defaultJudge?: string | null;
  modelTimeoutMs: number;
  tests: BenchmarkTest[];
};

export type BenchmarkRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type BenchmarkResultStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timedout' | 'cancelled';

export type BenchmarkResult = {
  id: string;
  testName: string;
  testType: 'code' | 'open';
  model: string;
  status: BenchmarkResultStatus;
  verifyPassed?: boolean | null;
  verifyExitCode?: number | null;
  sessionId?: string | null;
  judgeSessionId?: string | null;
  durationMs?: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost?: number | null;
  quotaCostEstimate?: number | null;
  judgeScore?: number | null;
  judgeRationale?: string | null;
  metricsError?: string | null;
  error?: string | null;
};

export type BenchmarkRun = {
  id: string;
  suite: string;
  judgeModel: string;
  status: BenchmarkRunStatus;
  total: number;
  completed: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  baselineJson?: string | null;
  requestVerdict: boolean;
  verdict?: string | null;
  error?: string | null;
  results: BenchmarkResult[];
};

export type ModelSummary = {
  model: string;
  total: number;
  passed: number;
  failed: number;
  judgeAverage: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number | null;
  quotaCost: number | null;
  errors: number;
};

export const VARIANTS = ['low', 'medium', 'high', 'max', 'thinking'];

export function combinationCount(suite: BenchmarkSuite, models: string[]): number {
  return suite.tests.length * models.length;
}

export function modelSpec(model: string, variant?: string | null): string {
  const clean = variant?.trim();
  return clean ? `${model}#${clean}` : model;
}

export function filterModels(models: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? models.filter((model) => model.toLowerCase().includes(needle)) : models;
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br />');
}

function isPassed(result: BenchmarkResult): boolean {
  if (result.testType === 'code') return result.verifyPassed === true;
  return result.judgeScore != null && result.judgeScore >= 3;
}

export function tokenTotal(result: BenchmarkResult): number {
  return result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
}

export function summarizeByModel(results: BenchmarkResult[]): ModelSummary[] {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const group = groups.get(result.model) ?? [];
    group.push(result);
    groups.set(result.model, group);
  }

  return [...groups.entries()]
    .map(([model, items]) => {
      const passed = items.filter(isPassed).length;
      const scores = items
        .map((item) => item.judgeScore)
        .filter((score): score is number => score != null);
      const costs = items
        .map((item) => item.cost)
        .filter((cost): cost is number => cost != null);
      const quotas = items
        .map((item) => item.quotaCostEstimate)
        .filter((quota): quota is number => quota != null);
      return {
        model,
        total: items.length,
        passed,
        failed: items.length - passed,
        judgeAverage: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
        durationMs: items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
        inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0),
        outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
        reasoningTokens: items.reduce((sum, item) => sum + item.reasoningTokens, 0),
        cacheReadTokens: items.reduce((sum, item) => sum + item.cacheReadTokens, 0),
        cacheWriteTokens: items.reduce((sum, item) => sum + item.cacheWriteTokens, 0),
        totalTokens: items.reduce((sum, item) => sum + tokenTotal(item), 0),
        cost: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
        quotaCost: quotas.length ? quotas.reduce((sum, quota) => sum + quota, 0) : null,
        errors: items.filter((item) => item.status === 'failed' || item.status === 'timedout' || item.metricsError != null).length,
      };
    })
    .sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
}

export function quotaPerPassed(summary: ModelSummary): number | null {
  if (summary.quotaCost == null || summary.passed === 0) return null;
  return summary.quotaCost / summary.passed;
}
