import test from 'node:test';
import assert from 'node:assert/strict';
import { es } from './locales/es.ts';
import { en } from './locales/en.ts';
import { apiErrorText, formatMoney, formatNumber, hasSignal, plural, resolveInitialLanguage, statusLabel, translate, translateError, translateSignal } from './i18n.ts';

test('los diccionarios tienen las mismas claves', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
});

test('un idioma guardado inválido cae al navegador y el navegador se normaliza', () => {
  assert.equal(resolveInitialLanguage('en', 'es-UY'), 'en');
  assert.equal(resolveInitialLanguage('fr', 'es-UY'), 'es');
  assert.equal(resolveInitialLanguage(null, 'en-GB'), 'en');
  assert.equal(resolveInitialLanguage(null, 'es-419'), 'es');
  assert.equal(resolveInitialLanguage('', 'fr-FR'), 'en');
});

test('las formas plurales siguen el idioma', () => {
  assert.equal(plural('en', 1, { one: 'a', other: 'b' }), 'a');
  assert.equal(plural('en', 2, { one: 'a', other: 'b' }), 'b');
  assert.equal(plural('es', 0, { one: 'a', other: 'b' }), 'b');
  assert.equal(translate('es', 'common.errors', { count: 3, value: '3' }), '3 errores');
});

test('los montos usan el separador del idioma', () => {
  assert.equal(formatMoney('en', 1234.5), 'US$ 1,234.50000000');
  assert.equal(formatMoney('es', 1234.5), 'US$ 1.234,50000000');
});

test('los números decimales respetan el locale sin perder precisión', () => {
  assert.equal(formatNumber('en', 1234.5), '1,234.5');
  assert.equal(formatNumber('es', 1234.5), '1.234,5');
  assert.equal(formatNumber('en', 0.1875, { maximumFractionDigits: 20 }), '0.1875');
  assert.equal(formatNumber('es', 0.1875, { maximumFractionDigits: 20 }), '0,1875');
  assert.equal(formatNumber('es', 1.2, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), '1,20');
});

test('todos los códigos de error de API tienen traducción', () => {
  for (const [code, key] of Object.entries(apiErrorText)) {
    assert.ok(key in es, `falta ${code} en español`);
    assert.ok(key in en, `falta ${code} en inglés`);
  }
});

test('un código desconocido cae al texto de la API', () => {
  assert.equal(translateError(translate.bind(null, 'es'), 'unknown_code', 'Something failed.'), 'Something failed.');
});

test('un código conocido interpola los parámetros que mandó la API', () => {
  assert.equal(
    translateError(translate.bind(null, 'es'), 'suite_not_found', 'The suite "demo" does not exist.', { suite: 'demo' }),
    'La suite "demo" no existe.',
  );
  assert.equal(
    translateError(translate.bind(null, 'en'), 'suite_not_found', 'texto de la API', { suite: 'demo' }),
    'The suite "demo" does not exist.',
  );
  assert.equal(
    translateError(translate.bind(null, 'es'), 'baseline_verify_timeout', 'The baseline verify of "code-test" timed out.', { test: 'code-test' }),
    'La verificación de la línea base de "code-test" agotó el tiempo de espera.',
  );
});

test('una clave inexistente devuelve la clave y nunca undefined', () => {
  // @ts-expect-error clave inexistente a propósito
  assert.equal(translate('en', 'signals.unknown.title'), 'signals.unknown.title');
});

test('una señal conocida se traduce con la evidencia', () => {
  const signal = { kind: 'tool_loop', title: 'Tool loop: bash', explanation: 'text from the API', evidence: { tool: 'bash', calls: 9, maxConsecutive: 4, errors: 2 } };
  const text = translateSignal(translate.bind(null, 'es'), signal);
  assert.equal(text.title, 'Bucle de herramienta: bash');
  assert.equal(text.explanation, 'bash se llamó 9 veces; 2 fallaron y la racha máxima fue 4.');
});

test('un kind de señal desconocido conserva el texto en inglés que mandó la API', () => {
  assert.equal(hasSignal('tool_loop'), true);
  assert.equal(hasSignal('future_kind'), false);
  const signal = { kind: 'future_kind', title: 'Future signal', explanation: 'Something the dictionary does not know yet.', evidence: { count: 2, extra: null } };
  assert.deepEqual(translateSignal(translate.bind(null, 'es'), signal), {
    title: 'Future signal',
    explanation: 'Something the dictionary does not know yet.',
  });
});

test('una señal conocida sin un campo de evidencia deja el hueco vacío', () => {
  const signal = { kind: 'tool_loop', title: 'Tool loop: bash', explanation: 'text from the API', evidence: { tool: 'bash', calls: 9, maxConsecutive: 4 } };
  const text = translateSignal(translate.bind(null, 'es'), signal);
  assert.equal(text.explanation, 'bash se llamó 9 veces;  fallaron y la racha máxima fue 4.');
  assert.ok(!text.explanation.includes('undefined'));
});

test('el plural usa count y el número mostrado conserva el separador', () => {
  const text = translate('es', 'models.totals.calls', { count: 9999, value: formatNumber('es', 9999) });
  assert.equal(text, '9.999 llamadas de modelo');
  const one = translate('en', 'models.totals.calls', { count: 1, value: formatNumber('en', 1) });
  assert.equal(one, '1 model call');
});

test('un estado conocido se traduce y uno desconocido se muestra crudo', () => {
  assert.equal(statusLabel(translate.bind(null, 'es'), 'completed'), 'Completada');
  assert.equal(statusLabel(translate.bind(null, 'es'), 'timedout'), 'Tiempo agotado');
  assert.equal(statusLabel(translate.bind(null, 'en'), 'queued'), 'Queued');
  assert.equal(statusLabel(translate.bind(null, 'es'), 'future_state'), 'future_state');
  assert.equal(statusLabel(translate.bind(null, 'en'), 'otro_estado'), 'otro_estado');
});

test('el conteo de errores conserva el separador y la forma plural', () => {
  assert.equal(translate('es', 'common.errors', { count: 1200, value: formatNumber('es', 1200) }), '1.200 errores');
  assert.equal(translate('en', 'common.errors', { count: 1200, value: formatNumber('en', 1200) }), '1,200 errors');
  assert.equal(translate('es', 'common.errors', { count: 1, value: formatNumber('es', 1) }), '1 error');
  assert.equal(translate('en', 'common.errors', { count: 1, value: formatNumber('en', 1) }), '1 error');
});
