'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mask } = require('../src/mask');

// Both views must be the same length as the input, keep every \r and \n in
// place, and never invent characters: code is withStrings with more blanked,
// and withStrings is the source with some characters blanked.
function check(src, label, opts) {
  const { code, withStrings } = mask(src, opts);
  assert.equal(code.length, src.length, `${label}: code length`);
  assert.equal(withStrings.length, src.length, `${label}: withStrings length`);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n' || c === '\r') {
      assert.ok(code[i] === c && withStrings[i] === c, `${label}: line break at ${i}`);
    } else {
      assert.ok(withStrings[i] === c || withStrings[i] === ' ', `${label}: withStrings changed ${i}`);
      assert.ok(code[i] === withStrings[i] || code[i] === ' ', `${label}: code changed ${i}`);
    }
  }
}

const SNIPPETS = [
  '',
  '#!/usr/bin/env node\n',
  '#!',
  'a / b // c\r\nd /* e\r\nf */ g\r',
  'x = "a\\\r\nb"; y = \'c\\\nd\';',
  'x = `a${`b${c}`}d` + /re[/]/g;',
  'x = "unterminated\r\ny = 1;',
  'x = `unterminated ${ y',
  'x = /unterminated',
  'x = <a b="c" d={e}>f{g}</a>; y = <>h</>;',
  'x = <a>{b <c>d</c>}',
  'x = <a b=\'c',
  'x = <a><b></a>',
  'if (a) /x/.test(b); for (;;) /y/g; } /z/',
  'a b // c d e\ff g﻿h',
  '😀 = "😀" // 😀\n',
  '\ud83d',
  '(((([[[{{{ ))) ]]] }}}',
  '}}}) ]] ${ `',
];

test('length and line breaks are preserved on tricky snippets', () => {
  for (const s of SNIPPETS) {
    check(s, JSON.stringify(s), { jsx: true });
    check(s, JSON.stringify(s), { jsx: false });
  }
});

test('length and line breaks are preserved on pseudo-random token soup', () => {
  const toks = ['<', '>', '/', '</', '/>', '{', '}', '(', ')', '`', '${', '"', "'", '\\', '\r\n', '\n', '\r',
    ' ', 'a', 'b', ' ', '=', '=>', '!', '//', '/*', '*/', '[', ']', '+', '++', 'return', 'if', 'else',
    '.', '?.', ' ', '<a>', '</a>', '<>', '</>', 'x='];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 3000; t++) {
    let s = '';
    for (let k = 1 + Math.floor(rnd() * 25); k > 0; k--) s += toks[Math.floor(rnd() * toks.length)];
    check(s, JSON.stringify(s), { jsx: t % 2 === 0 });
  }
});

function* sources(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 12) yield* sources(p, depth + 1); } else if (/\.(?:[cm]?js|jsx|tsx?)$/.test(e.name)) yield p;
  }
}

test('length and line breaks are preserved on installed JS/TS files', (t) => {
  const root = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
  if (!fs.existsSync(root)) { t.skip('no global node_modules'); return; }
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 2e6) continue;
    const { code, withStrings } = mask(text, { jsx: !/\.(?:d\.)?[cm]?ts$/.test(file) });
    assert.equal(code.length, text.length, file);
    assert.equal(withStrings.length, text.length, file);
    const breaks = (s) => s.replace(/[^\r\n]/g, '');
    assert.equal(breaks(code), breaks(text), file);
    assert.equal(breaks(withStrings), breaks(text), file);
  }
});
