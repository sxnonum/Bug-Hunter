'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask } = require('../src/mask');

const time = (src, opts) => {
  const t = process.hrtime.bigint();
  mask(src, opts);
  return Number(process.hrtime.bigint() - t) / 1e6;
};

test('unmatched `}` after many open `(` is linear, not quadratic', () => {
  assert.ok(time('('.repeat(100000) + '}'.repeat(100000)) < 1000);
  assert.ok(time('(\n}\n'.repeat(60000)) < 1000);
  assert.ok(time('f(}\n'.repeat(60000)) < 1000);
});

test('unmatched parens do not change what the next `}` and `)` do', () => {
  // `}` closes the block below the stray `(`; the `/` after it starts a regex
  assert.equal(mask('if (a) { f( }\n/x(/.test(s);\n').code, 'if (a) { f( }\n/  /.test(s);\n');
  // a `)` pairs with the nearest open `(`
  assert.equal(mask('if ((a) && b) /c(/.test(s);\n').code, 'if ((a) && b) /  /.test(s);\n');
});

test('doubling the input roughly doubles the time on pathological shapes', () => {
  const shapes = {
    'unmatched (': (k) => '('.repeat(k),
    'unmatched [': (k) => '['.repeat(k),
    'unmatched {': (k) => '{'.repeat(k),
    'unmatched }': (k) => '}'.repeat(k),
    'stray ) ]': (k) => ')]'.repeat(k),
    '< repeated': (k) => 'x=<a'.repeat(k),
    'elements repeated': (k) => 'x=<a<b>'.repeat(k),
    'backticks': (k) => '`'.repeat(k),
    'regex class': (k) => 'x=/['.repeat(k),
    'nested templates': (k) => '`${'.repeat(k),
    'generic arrows': (k) => 'const f = <T extends X>(x: T) => x;\n'.repeat(k),
    'unclosed elements': (k) => 'x = <div>\n'.repeat(k) + '</div>',
  };
  for (const [name, make] of Object.entries(shapes)) {
    const small = make(15000);
    const big = make(120000); // 8x the input
    mask(small); // warm up
    const t1 = Math.max(time(small), 2);
    const t2 = time(big);
    // linear predicts ~8x; quadratic predicts ~64x
    assert.ok(t2 < t1 * 30 + 200, `${name}: ${t1.toFixed(1)}ms -> ${t2.toFixed(1)}ms`);
  }
});
