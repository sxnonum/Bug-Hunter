'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask } = require('../src/mask');

test('output keeps the same length and line breaks as the input', () => {
  const src = 'const a = "x"; // hi\n/* multi\nline */ const b = `t${1 + 2}u`;\n';
  const { code, withStrings } = mask(src);
  assert.equal(code.length, src.length);
  assert.equal(withStrings.length, src.length);
  assert.deepEqual(code.split('\n').map((l) => l.length), src.split('\n').map((l) => l.length));
});

test('comments are blanked in both views', () => {
  const { code, withStrings } = mask('a(); // eval(x)\n/* eval(y) */ b();');
  assert.ok(!code.includes('eval'));
  assert.ok(!withStrings.includes('eval'));
});

test('string text is kept in withStrings and blanked in code', () => {
  const { code, withStrings } = mask(`x = 'eval(1)'; y = "a'b";`);
  assert.ok(withStrings.includes('eval(1)'));
  assert.ok(!code.includes('eval'));
  assert.ok(code.includes(`y = "   "`));
});

test('template literal text is blanked but ${} expressions stay code', () => {
  const { code } = mask('const s = `hello ${user.name == 1} world`;');
  assert.ok(!code.includes('hello'));
  assert.ok(code.includes('user.name == 1'));
});

test('nested templates inside expressions are handled', () => {
  const { code } = mask('const s = `a ${ `b ${c}` } d`; eval(x);');
  assert.ok(code.includes('eval(x)'));
  assert.ok(!code.includes(' a '));
});

test('regex literals are blanked, division is not', () => {
  const { code } = mask('x = /eval\\(/.test(s); y = a / b / c;');
  assert.ok(!code.includes('eval'));
  assert.ok(code.includes('a / b / c'));
});

test('a slash in a regex character class does not end the regex', () => {
  const { code } = mask('x = /[/]eval/.test(s); z = 1;');
  assert.ok(!code.includes('eval'));
  assert.ok(code.includes('z = 1'));
});

test('regex after return is recognised', () => {
  const { code } = mask('function f() { return /eval/.test(s); }');
  assert.ok(!code.includes('eval'));
});

test('unterminated string does not swallow following lines', () => {
  const { code } = mask('x = "oops\neval(y);');
  assert.ok(code.includes('eval(y)'));
});
