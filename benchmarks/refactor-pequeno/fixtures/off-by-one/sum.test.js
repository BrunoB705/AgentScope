import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.js';

test('suma dos números', () => {
  assert.equal(sum(2, 3), 5);
});
