import test from 'node:test';
import assert from 'node:assert/strict';
import { netTotal } from '../src/totals.ts';
import type { Event } from '../src/totals.ts';

test('una lista vacía totaliza cero', () => {
  assert.equal(netTotal([]), 0);
});

test('un evento void deja el total como estaba', () => {
  assert.equal(netTotal([{ kind: 'void' }]), 0);
  assert.equal(
    netTotal([{ kind: 'add', amount: 10 }, { kind: 'void' }, { kind: 'add', amount: 3 }]),
    13,
  );
});

test('suma cargos y resta devoluciones', () => {
  const eventos: Event[] = [
    { kind: 'add', amount: 10 },
    { kind: 'refund', amount: 4 },
  ];
  assert.equal(netTotal(eventos), 6);
});
