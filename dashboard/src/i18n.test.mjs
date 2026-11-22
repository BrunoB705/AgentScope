import test from 'node:test';
import assert from 'node:assert/strict';
import { es } from './locales/es.ts';
import { en } from './locales/en.ts';
import { apiErrorText, formatMoney, plural, resolveInitialLanguage, translate, translateError } from './i18n.ts';

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
  assert.equal(translate('es', 'common.errors', { count: 3 }), '3 errores');
});

test('los montos usan el separador del idioma', () => {
  assert.equal(formatMoney('en', 1234.5), 'US$ 1,234.50000000');
  assert.equal(formatMoney('es', 1234.5), 'US$ 1.234,50000000');
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

test('una clave inexistente devuelve la clave y nunca undefined', () => {
  // @ts-expect-error clave inexistente a propósito
  assert.equal(translate('en', 'signals.unknown.title'), 'signals.unknown.title');
});
