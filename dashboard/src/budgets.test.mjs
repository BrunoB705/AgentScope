import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetAmountText, budgetMetricLabel, budgetPanelSummary } from './budgets.ts';

const money = value => `US$${value.toFixed(2)}`;

test('la etiqueta distingue costo reportado de cuota estimada', () => {
  assert.equal(budgetMetricLabel('cost'), 'Costo reportado');
  assert.equal(budgetMetricLabel('quota'), 'Cuota Go estimada');
});

test('el resumen del panel nombra las métricas activas', () => {
  assert.equal(budgetPanelSummary([]), 'Configura límites mensuales por proyecto');
  assert.equal(budgetPanelSummary([{ metric: 'cost' }]), '1 configurado · Costo reportado');
  assert.equal(budgetPanelSummary([{ metric: 'quota' }, { metric: 'cost' }, { metric: 'quota' }]), '3 configurados · Costo reportado y Cuota Go estimada');
});

test('el monto consumido lleva la métrica y marca la cuota como aproximada', () => {
  assert.equal(budgetAmountText({ metric: 'cost', spent: 1.5, monthlyLimit: 25 }, money), 'Costo reportado: US$1.50 de US$25.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: 0.25, monthlyLimit: 10 }, money), 'Cuota Go estimada: ≈ US$0.25 de US$10.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: null, monthlyLimit: 10 }, money), 'Sin cuota Go estimada este mes');
  assert.equal(budgetAmountText({ metric: 'cost', spent: null, monthlyLimit: 10 }, money), 'Sin costo reportado este mes');
});
