'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasLongLine } = require('../src/scanner');

// The semantics of the original regex /[^\r\n]{5001}/: some line has more than 5000 characters.
const old = (text) => /[^\r\n]{5001}/.test(text);

test('hasLongLine: more than 5000 characters triggers, exactly 5000 does not', () => {
  assert.equal(hasLongLine('x'.repeat(5000)), false);
  assert.equal(hasLongLine('x'.repeat(5001)), true);
  assert.equal(hasLongLine(`${'x'.repeat(5000)}\n${'y'.repeat(5000)}\n`), false);
  assert.equal(hasLongLine(`a\n${'x'.repeat(5001)}\nb`), true);
  assert.equal(hasLongLine(''), false);
});

test('hasLongLine: \\r, \\n and \\r\\n all end a line', () => {
  const line = 'x'.repeat(3000);
  for (const br of ['\n', '\r', '\r\n']) {
    assert.equal(hasLongLine(line + br + line + br + line), false, JSON.stringify(br));
    assert.equal(hasLongLine(line + br + 'x'.repeat(5001) + br + line), true, JSON.stringify(br));
  }
});

test('hasLongLine agrees with the original regex on edge cases', () => {
  const x = (n) => 'x'.repeat(n);
  for (const text of [x(5000) + '\r' + x(5000), x(4999) + '\r\n' + x(5001), x(2500) + '\n\n' + x(2501), '\n'.repeat(10), x(10000), `${x(5000)}\r\n${x(5000)}\r\n`]) {
    assert.equal(hasLongLine(text), old(text), JSON.stringify(text.slice(0, 20)) + text.length);
  }
});

test('hasLongLine is linear: 1 MB of 4999-character lines takes well under a second', () => {
  const text = `${'x'.repeat(4999)}\n`.repeat(210);
  const t = process.hrtime.bigint();
  assert.equal(hasLongLine(text), false);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 200, `took ${ms} ms`);
});
