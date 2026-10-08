'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask } = require('../src/mask');

const code = (src, opts) => mask(src, opts).code;

test('regex after the header of if/for/while/with is a regex', () => {
  for (const head of ['if (ok)', 'for(;;)', 'for (const k in o)', 'while (a)', 'with (o)', 'else if (b)']) {
    const c = code(`${head} /\`'"/.test(s);\neval(user);\n`);
    assert.ok(c.includes('eval(user)'), head);
    assert.ok(!/[`'"]/.test(c), head);
  }
});

test('regex after a block-closing brace, + and -', () => {
  assert.ok(!code("function f(){}\n/'/.test(s); eval(u);").includes("'"));
  assert.ok(code("function f(){}\n/'/.test(s); eval(u);").includes('eval(u)'));
  assert.ok(code("const src = '(' + /'/.source + ')'; eval(u);").includes('eval(u)'));
  assert.ok(code("x = a - /'/.lastIndex; eval(u);").includes('eval(u)'));
  assert.ok(code("x = a + +/'/.lastIndex; eval(u);").includes('eval(u)'));
});

test('division after ), ], ++, -- and plain identifiers stays division', () => {
  assert.equal(code('f(x) / 2 / y; eval(1) / 2'), 'f(x) / 2 / y; eval(1) / 2');
  assert.equal(code('i++ / 2 / 3'), 'i++ / 2 / 3');
  assert.equal(code('a[0] / b / c'), 'a[0] / b / c');
  assert.equal(code('(a) / b / c'), '(a) / b / c');
  assert.equal(code('i-- / 2 / 3'), 'i-- / 2 / 3');
  assert.equal(code('if (p) { q } z = a / b / c'), 'if (p) { q } z = a / b / c');
});

test('a call to a function named like a keyword property is not a statement header', () => {
  assert.equal(code('x.if(a) / 2 / b'), 'x.if(a) / 2 / b');
  assert.equal(code('elif(a) / 2 / b'), 'elif(a) / 2 / b');
});

test('TS non-null assertion is not a prefix operator', () => {
  const c = code('const pct = this.done! / this.total!; // never use eval(x)\n');
  assert.ok(!c.includes('eval'));
  assert.equal(code('a! / b! / c'), 'a! / b! / c');
  assert.equal(code('a[0]! / b / c'), 'a[0]! / b / c');
  assert.equal(code('f()! / b / c'), 'f()! / b / c');
  const t = code('const l = `${this.done! / this.total!}% (${this.done}/${this.total})`;\neval(user);\n');
  assert.ok(t.includes('eval(user)'));
});

test('! before a regex is a prefix operator', () => {
  assert.ok(!code("if (!/'/.test(s)) eval(u);").includes("'"));
  assert.ok(code("if (!/'/.test(s)) eval(u);").includes('eval(u)'));
  assert.ok(!code("x = a !== /'/.source;").includes("'"));
});

test('keywords used as property names do not allow a regex', () => {
  const src = 'const r = c.in / c.total; if (a == b) {} const t = d / e;\n';
  assert.equal(code(src), src);
  for (const kw of ['in', 'of', 'new', 'delete', 'return', 'typeof', 'void', 'throw', 'case', 'await', 'yield']) {
    assert.equal(code(`x.${kw} / 2 / y`), `x.${kw} / 2 / y`, kw);
    assert.equal(code(`x?.${kw} / 2 / y`), `x?.${kw} / 2 / y`, kw);
  }
  assert.ok(!code("x = typeof /'/;").includes("'"));
  assert.ok(!code("x = {}; return /'/;").includes("'"));
});

test('< does not start a regex; => does', () => {
  const c = code('x = a </ 2; eval(1); y = b /3/ c;');
  assert.ok(c.includes('eval(1)'));
  assert.ok(!code("f = x => /'/.test(x);").includes("'"));
  assert.equal(code('x = a > b / c / d'), 'x = a > b / c / d');
});

test('a backtick in a doubtful regex means division, in a sure one still a regex', () => {
  // after a `)`-headed block the slash is ambiguous; the backtick says it is not a regex
  const doubtful = code('x = function () {}\n/ 2 + `t` / 3;\neval(u);\n');
  assert.ok(doubtful.includes('eval(u)'));
  assert.ok(code('x = /`/;\neval(u);\n').includes('eval(u)'));
  assert.ok(!code('x = /`/;\neval(u);\n').includes('`'));
});

test('regex scanning stays linear on unterminated candidates', () => {
  for (const unit of ['(/[', 'x = /[', '} /[', '=/\\']) {
    const src = unit.repeat(64000) + '\n';
    const t = process.hrtime.bigint();
    mask(src);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1500, `${JSON.stringify(unit)} took ${ms}ms`);
  }
});

test('a large single-line minified file masks quickly', () => {
  const src = 'var a=function(b){return b.replace(/\\s+/g,"")+"x"+`t${b/2}`};'.repeat(20000);
  const t = process.hrtime.bigint();
  mask(src);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);
});

test('regex flags and classes', () => {
  assert.equal(code('x = /a[/\\]]b/gi.test(s);'), 'x = /       /gi.test(s);');
  assert.equal(code('x = /a\\/b/u;'), 'x = /    /u;');
});

test('a regex may follow `default`, but `.default` divides', () => {
  const m = (s) => mask(s).code;
  assert.equal(m('export default /a(b/.test(s);\n'), 'export default /   /.test(s);\n');
  assert.equal(m('const h = x.default / 2 / 3;\n'), 'const h = x.default / 2 / 3;\n');
  assert.equal(m('const h = x?.default / 2 / 3;\n'), 'const h = x?.default / 2 / 3;\n');
  assert.equal(m('switch (v) { default: /a(/.test(s); }\n'), 'switch (v) { default: /  /.test(s); }\n');
});
