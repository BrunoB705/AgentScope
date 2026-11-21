export type BudgetMetric = 'cost' | 'quota';

/** Etiqueta visible de la métrica que mide un presupuesto; costo reportado y cuota estimada no se mezclan. */
export function budgetMetricLabel(metric: BudgetMetric): string {
  return metric === 'quota' ? 'Cuota Go estimada' : 'Costo reportado';
}

/** Resumen del panel: cantidad de presupuestos y qué métricas están activas. */
export function budgetPanelSummary(budgets: ReadonlyArray<{ metric: BudgetMetric }>): string {
  if (!budgets.length) return 'Configura límites mensuales por proyecto';
  const count = `${budgets.length} configurado${budgets.length === 1 ? '' : 's'}`;
  const metrics = (['cost', 'quota'] as const).filter(metric => budgets.some(budget => budget.metric === metric)).map(budgetMetricLabel);
  return `${count} · ${metrics.join(' y ')}`;
}

/** Monto consumido rotulado con su métrica, o el motivo por el que todavía no hay dato. */
export function budgetAmountText(budget: { metric: BudgetMetric; spent: number | null; monthlyLimit: number }, money: (value: number) => string): string {
  if (budget.spent == null) return budget.metric === 'quota' ? 'Sin cuota Go estimada este mes' : 'Sin costo reportado este mes';
  const prefix = budget.metric === 'quota' ? '≈ ' : '';
  return `${budgetMetricLabel(budget.metric)}: ${prefix}${money(budget.spent)} de ${money(budget.monthlyLimit)}`;
}
