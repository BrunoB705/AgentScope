import test from 'node:test';
import assert from 'node:assert/strict';
import { addItem } from '../src/cart.ts';
import type { Cart } from '../src/cart.ts';

test('agregar un id existente sube la cantidad sin mutar el original', () => {
  const original: Cart = { items: [{ id: 'a', qty: 2 }] };
  const itemOriginal = original.items[0];

  const resultado = addItem(original, 'a');

  assert.notEqual(resultado, original);
  assert.equal(original.items.length, 1);
  assert.equal(original.items[0], itemOriginal);
  assert.equal(original.items[0].qty, 2);
  assert.equal(resultado.items.length, 1);
  assert.equal(resultado.items[0].qty, 3);
});

test('agregar un id nuevo entra con cantidad uno sin mutar el original', () => {
  const original: Cart = { items: [] };

  const resultado = addItem(original, 'b');

  assert.notEqual(resultado, original);
  assert.equal(original.items.length, 0);
  assert.equal(resultado.items.length, 1);
  assert.equal(resultado.items[0].id, 'b');
  assert.equal(resultado.items[0].qty, 1);
});
