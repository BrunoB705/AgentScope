import type { Translate } from './i18n.ts';

export type BudgetMetric = 'cost' | 'quota';

/** Etiqueta visible de la métrica que mide un presupuesto; costo reportado y cuota estimada no se mezclan. */
export function budgetMetricLabel(metric: BudgetMetric, t: Translate): string {
  return t(metric === 'quota' ? 'budgets.metric.quota' : 'budgets.metric.cost');
}

/** Resumen del panel: cantidad de presupuestos y qué métricas están activas. */
export function budgetPanelSummary(budgets: ReadonlyArray<{ metric: BudgetMetric }>, t: Translate): string {
  if (!budgets.length) return t('budgets.panel.empty');
  const metrics = (['cost', 'quota'] as const)
    .filter(metric => budgets.some(budget => budget.metric === metric))
    .map(metric => budgetMetricLabel(metric, t))
    .join(t('budgets.panel.metricSeparator'));
  return t('budgets.panel.summary', {
    configured: t('budgets.panel.configured', { count: budgets.length }),
    metrics,
  });
}

/** Monto consumido rotulado con su métrica, o el motivo por el que todavía no hay dato. */
export function budgetAmountText(
  budget: { metric: BudgetMetric; spent: number | null; monthlyLimit: number },
  money: (value: number) => string,
  t: Translate,
): string {
  if (budget.spent == null) {
    return t(budget.metric === 'quota' ? 'budgets.amount.missingQuota' : 'budgets.amount.missingCost');
  }
  return t(budget.metric === 'quota' ? 'budgets.amount.estimated' : 'budgets.amount.reported', {
    metric: budgetMetricLabel(budget.metric, t),
    spent: money(budget.spent),
    limit: money(budget.monthlyLimit),
  });
}
