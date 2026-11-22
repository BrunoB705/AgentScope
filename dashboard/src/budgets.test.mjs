import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, translate } from './i18n.ts';
import { budgetAmountText, budgetMetricLabel, budgetPanelSummary } from './budgets.ts';

const es = translate.bind(null, 'es');
const en = translate.bind(null, 'en');
const money = value => `US$${value.toFixed(2)}`;

test('la etiqueta distingue costo reportado de cuota estimada', () => {
  assert.equal(budgetMetricLabel('cost', es), 'Costo reportado');
  assert.equal(budgetMetricLabel('quota', es), 'Cuota Go estimada');
  assert.equal(budgetMetricLabel('cost', en), 'Reported cost');
  assert.equal(budgetMetricLabel('quota', en), 'Estimated Go quota');
});

test('el resumen del panel nombra las métricas activas', () => {
  assert.equal(budgetPanelSummary([], es), 'Configura límites mensuales por proyecto');
  assert.equal(budgetPanelSummary([{ metric: 'cost' }], es), '1 configurado · Costo reportado');
  assert.equal(budgetPanelSummary([{ metric: 'quota' }, { metric: 'cost' }, { metric: 'quota' }], es), '3 configurados · Costo reportado y Cuota Go estimada');
});

test('el resumen del panel usa el idioma pedido', () => {
  assert.equal(budgetPanelSummary([], en), 'Set monthly limits per project');
  assert.equal(budgetPanelSummary([{ metric: 'quota' }], en), '1 configured · Estimated Go quota');
  assert.equal(budgetPanelSummary([{ metric: 'quota' }, { metric: 'cost' }], en), '2 configured · Reported cost and Estimated Go quota');
});

test('el monto consumido lleva la métrica y marca la cuota como aproximada', () => {
  assert.equal(budgetAmountText({ metric: 'cost', spent: 1.5, monthlyLimit: 25 }, money, es), 'Costo reportado: US$1.50 de US$25.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: 0.25, monthlyLimit: 10 }, money, es), 'Cuota Go estimada: ≈ US$0.25 de US$10.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: null, monthlyLimit: 10 }, money, es), 'Sin cuota Go estimada este mes');
  assert.equal(budgetAmountText({ metric: 'cost', spent: null, monthlyLimit: 10 }, money, es), 'Sin costo reportado este mes');
});

test('el monto consumido se traduce sin cambiar el formateador inyectado', () => {
  assert.equal(budgetAmountText({ metric: 'cost', spent: 1.5, monthlyLimit: 25 }, money, en), 'Reported cost: US$1.50 of US$25.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: 0.25, monthlyLimit: 10 }, money, en), 'Estimated Go quota: ≈ US$0.25 of US$10.00');
  assert.equal(budgetAmountText({ metric: 'quota', spent: null, monthlyLimit: 10 }, money, en), 'No estimated Go quota this month');
  assert.equal(budgetAmountText({ metric: 'cost', spent: null, monthlyLimit: 10 }, money, en), 'No reported cost this month');
});

test('el monto respeta el formateador de cada locale sin mezclar separadores', () => {
  const budget = { metric: 'cost', spent: 1234.5, monthlyLimit: 9999 };
  assert.equal(budgetAmountText(budget, value => formatMoney('en', value), en), 'Reported cost: US$ 1,234.50000000 of US$ 9,999.00000000');
  assert.equal(budgetAmountText(budget, value => formatMoney('es', value), es), 'Costo reportado: US$ 1.234,50000000 de US$ 9.999,00000000');
});
