import assert from 'node:assert/strict';
import test from 'node:test';
import { clockMinutes, clockParts, deadlineHours, clockLabel } from '../frontend/time.js';

test('clock deadlines use plan start, minutes and explicit days', () => {
  assert.equal(deadlineHours('14:00', 1, '09:00'), 5);
  assert.equal(deadlineHours('12:30', 1, '09:00'), 3.5);
  assert.equal(deadlineHours('01:30', 2, '22:00'), 3.5);
  assert.deepEqual(clockParts(3.5, '22:00'), { time: '01:30', day: 2 });
  assert.equal(clockLabel(48, '09:00'), '09:00 · день 3');
  assert.equal(deadlineHours('12:00', 1, '13:00'), -1);
});

test('switching display preserves existing fractional and multi-day deadlines', () => {
  for (const start of ['00:00', '09:00', '23:59']) {
    for (const original of [.001, .123, .999, 8, 24, 60, 100000]) {
      const { time, day } = clockParts(original, start);
      assert.equal(deadlineHours(time, day, start, original), original);
    }
  }
  assert.equal(deadlineHours('14:00', 1, '10:00', 5), 4);
});

test('invalid clock and day values cannot silently become valid deadlines', () => {
  for (const value of ['', '24:00', '12:60', '9:00', null]) assert.ok(Number.isNaN(clockMinutes(value)));
  for (const day of [0, 1.5, 4169, NaN]) assert.ok(Number.isNaN(deadlineHours('14:00', day, '09:00')));
  assert.ok(Number.isNaN(deadlineHours('', 1, '09:00')));
});
