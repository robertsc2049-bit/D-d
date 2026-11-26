import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roll, rollD20, setDieRoller, DiceError } from '../supabase/functions/solo-dnd/core/dice.js';

test('parses and totals expressions', () => {
  const restore = setDieRoller((sides) => sides); // always max
  try {
    assert.equal(roll('1d20+5').total, 25);
    assert.equal(roll('2d6 + 1d4 - 1').total, 15);
    assert.equal(roll('d8').total, 8);
    assert.equal(roll('-1d4+10').total, 6);
    assert.equal(roll('3').total, 3);
  } finally {
    restore();
  }
});

test('keep highest / lowest', () => {
  const seq = [1, 6, 3, 5];
  const restore = setDieRoller(() => seq.shift());
  try {
    const r = roll('4d6kh3');
    assert.equal(r.total, 14);
    assert.deepEqual(r.terms[0].kept.sort(), [3, 5, 6]);
  } finally {
    restore();
  }
});

test('critical doubles dice but not modifiers', () => {
  const restore = setDieRoller(() => 1);
  try {
    const r = roll('2d6+3', { critical: true });
    assert.equal(r.terms[0].rolls.length, 4);
    assert.equal(r.total, 7);
  } finally {
    restore();
  }
});

test('rejects bad expressions', () => {
  for (const bad of ['', 'abc', '1d', '2d6++3', '1000d6', '1d1']) {
    assert.throws(() => roll(bad), DiceError, bad);
  }
});

test('real dice stay in range', () => {
  for (let i = 0; i < 500; i++) {
    const t = roll('1d20').total;
    assert.ok(t >= 1 && t <= 20);
  }
  const d = rollD20('advantage');
  assert.equal(d.rolls.length, 2);
  assert.equal(d.natural, Math.max(...d.rolls));
});
