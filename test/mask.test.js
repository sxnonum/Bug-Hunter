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

test('backslash-CRLF inside a string is one line continuation', () => {
  const crlf = mask('const m = "see eval(x) \\\r\nuse eval(y) here"; eval(user);\r\n').code;
  const lf = mask('const m = "see eval(x) \\\nuse eval(y) here"; eval(user);\n').code;
  assert.equal(crlf.replace(/\r/g, ''), lf);
  assert.equal(crlf.match(/eval/g).length, 1);
  assert.ok(crlf.includes('eval(user)'));
});

test('unterminated string stops at a bare CR', () => {
  const { code } = mask('x = "oops\reval(y);\r');
  assert.ok(code.includes('eval(y)'));
});

test('// comments end at CR, U+2028 and U+2029', () => {
  for (const eol of ['\r', ' ', ' ', '\r\n']) {
    const { code, withStrings } = mask(`x(); // eval(a)${eol}eval(b);${eol}`);
    assert.ok(!code.includes('eval(a)'), JSON.stringify(eol));
    assert.ok(code.includes('eval(b)'), JSON.stringify(eol));
    assert.ok(withStrings.includes('eval(b)'), JSON.stringify(eol));
  }
});

test('a string may contain U+2028 without ending', () => {
  const { code } = mask('x = "a eval(a)"; eval(b);');
  assert.ok(!code.includes('eval(a)'));
  assert.ok(code.includes('eval(b)'));
});

test('exotic whitespace does not count as a token before a regex', () => {
  for (const ws of [' ', '\f', '\v', '﻿', ' ', '　']) {
    const { code } = mask(`const re =${ws}/\`/;\neval(user);\n`);
    assert.ok(code.includes('eval(user)'), JSON.stringify(ws));
    assert.ok(!code.includes('`'), JSON.stringify(ws));
  }
});

test('a hashbang line is blanked in both views', () => {
  const src = "#!/usr/bin/env -S node --foo='x\neval(y);\n";
  const { code, withStrings } = mask(src);
  assert.equal(code, ' '.repeat(src.indexOf('\n')) + '\neval(y);\n');
  assert.equal(withStrings, code);
  assert.equal(mask('#!/usr/bin/env node\r\nx();').code, '                   \r\nx();');
});

test('#! is only a hashbang at offset 0', () => {
  assert.ok(mask('\n#!/x').code.includes('#'));
});

test('deeply nested templates do not overflow the stack', () => {
  const d = 20000;
  const src = 'const x = ' + '`${'.repeat(d) + '1' + '}`'.repeat(d) + ';\neval(y);\n';
  const { code } = mask(src);
  assert.equal(code.length, src.length);
  assert.ok(code.includes('eval(y)'));
});

test('unterminated template blanks to the end', () => {
  const { code } = mask('x = `abc ${y} eval(1)');
  assert.ok(code.includes('y'));
  assert.ok(!code.includes('eval'));
});
