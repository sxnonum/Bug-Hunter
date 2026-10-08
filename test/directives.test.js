'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');

const ids = (src, opts) => analyzeSource(src, opts).map((f) => `${f.rule}@${f.line}`);

test('a directive without rule ids suppresses every rule on that line', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line'), []);
});

test('a reason may follow "--"', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line no-eval -- input is a build-time constant'), []);
});

test('block comments work', () => {
  assert.deepEqual(ids('eval(a); /* bughunter-disable-line no-eval */'), []);
  assert.deepEqual(ids('/* bughunter-disable-next-line no-eval */\neval(a);'), []);
});

test('a misspelled rule id suppresses nothing and is reported', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line no-evl'), ['no-eval@1', 'invalid-directive@1']);
});

test('known ids still apply when another id on the same comment is unknown', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line no-eval, nope'), ['invalid-directive@1']);
});

test('invalid-directive can be disabled like any rule', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line no-evl', { disabledRules: ['invalid-directive'] }), ['no-eval@1']);
});

test('directive text inside a string literal is not a directive', () => {
  assert.deepEqual(ids('const s = "// bughunter-disable-line"; eval(a);'), ['no-eval@1']);
  assert.deepEqual(ids('const s = `bughunter-disable-next-line`;\neval(a);'), ['no-eval@2']);
});

test('a directive suppresses only the rules it names', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line loose-equality'), ['no-eval@1']);
  assert.deepEqual(ids('// bughunter-disable-next-line no-eval\n\neval(a);'), ['no-eval@3']);
});
