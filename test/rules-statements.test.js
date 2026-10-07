'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');

const lines = (src, rule, file) =>
  analyzeSource(src, { file }).filter((f) => f.rule === rule).map((f) => f.line);
const has = (src, rule, file) => lines(src, rule, file).length > 0;
const timed = (fn) => {
  const start = Date.now();
  fn();
  return Date.now() - start;
};

test('no-debugger only flags the statement', () => {
  assert.deepEqual(lines('function f() { debugger; }', 'no-debugger'), [1]);
  assert.deepEqual(lines('function f() {\n  debugger\n}', 'no-debugger'), [2]);
  assert.deepEqual(lines('if (x) debugger;', 'no-debugger'), [1]);
  assert.deepEqual(lines('function y(L,se){debugger;return 1}', 'no-debugger'), [1]);
  assert.ok(!has('chrome.debugger.attach({ tabId }, "1.3", () => {});', 'no-debugger'));
  assert.ok(!has('const kinds = {\n  debugger: "DebuggerStatement",\n};', 'no-debugger'));
  assert.ok(!has('class Ctx { debugger() { return this._d; } }', 'no-debugger'));
  assert.ok(!has('context.debugger();', 'no-debugger'));
  assert.ok(!has('const o = { debugger };', 'no-debugger'));
  assert.ok(!has('const s = "debugger;";', 'no-debugger'));
});

test('unreachable-code skips TypeScript members and declaration files', () => {
  const iterator =
    'interface Iterator<T> {\n    next(): IteratorResult<T>;\n    return?(value?: any): IteratorResult<T>;\n    throw?(e?: any): IteratorResult<T>;\n}\n';
  assert.ok(!has(iterator, 'unreachable-code', 'a.ts'));
  assert.ok(!has('interface F {\n    return?: ReturnType | undefined;\n    arguments?: readonly ArgumentType[] | undefined;\n}', 'unreachable-code', 'a.ts'));
  assert.ok(!has('interface I {\n  return(value: any): R;\n  throw(e: any): R;\n}', 'unreachable-code', 'a.ts'));
  assert.ok(!has('declare class G {\n  return(v): R;\n  throw(e): R;\n}', 'unreachable-code', 'a.ts'));
  assert.ok(!has('type T = {\n  return: number;\n  throw: string;\n};', 'unreachable-code', 'a.ts'));
  assert.ok(!has('const o = {\n  return() { stop(); },\n  next() { go(); },\n};', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return 1;\n  g();\n}', 'unreachable-code', 'a.d.ts'));
  // A real jump inside a method of a class is still found.
  assert.deepEqual(lines('class A {\n  m() {\n    return(1);\n    cleanup();\n  }\n}', 'unreachable-code'), [4]);
});

test('unreachable-code treats hoisted functions as live, and braceless bodies as bodies', () => {
  assert.ok(!has('function f() {\n  return g();\n  function g() {}\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return g();\n  async function g() {}\n}', 'unreachable-code'));
  assert.ok(!has('if (a)\n  return 1;\n  return 2;', 'unreachable-code'));
  assert.ok(!has('while (a)\n  break;\n  b();', 'unreachable-code'));
});

test('unreachable-code works without semicolons and across lines', () => {
  assert.deepEqual(lines('function f() {\n  return 1\n  cleanup()\n}', 'unreachable-code'), [3]);
  assert.deepEqual(lines('function f() {\n  throw new Error("x")\n  cleanup()\n}', 'unreachable-code'), [3]);
  assert.deepEqual(lines('for (;;) {\n  break\n  x()\n}', 'unreachable-code'), [3]);
  assert.deepEqual(lines('function f() {\n  throw new Error(\n    "boom"\n  );\n  cleanup();\n}', 'unreachable-code'), [5]);
  assert.deepEqual(lines('function f() {\n  return g(\n    a,\n    b\n  );\n  cleanup();\n}', 'unreachable-code'), [6]);
  assert.deepEqual(lines('function f() {\n  return `a${b}`\n  cleanup()\n}', 'unreachable-code'), [3]);
  assert.deepEqual(lines('function f() {\n  return a\n    .b()\n  cleanup()\n}', 'unreachable-code'), [4]);
});

test('unreachable-code does not mistake continued statements for dead code', () => {
  assert.ok(!has('function f() {\n  return a\n    .b()\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return a +\n  b\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return a\n  + b\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return a &&\n  // keep the guard\n  b\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return a\n  ;\n}', 'unreachable-code'));
  assert.ok(!has('function f()\n{\n  return function g()\n  {\n    x();\n  };\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return `\n  text ${a}\n  `;\n}', 'unreachable-code'));
  assert.ok(!has('switch (x) {\n  case 1:\n    return 1\n  case 2:\n    return 2\n  default:\n    return 3\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  if (a) return 1\n  return 2\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return\n    x\n}', 'unreachable-code'));
});

test('assignment-in-condition skips comma (sequence) conditions', () => {
  assert.ok(!has('if (f = 1, y && t) return t;', 'assignment-in-condition'));
  assert.ok(!has('if (y = 0, t) op = [op[0] & 2, t.value];', 'assignment-in-condition'));
  assert.ok(!has('function t(r){var e;if(e=r.x,e>0)return e}', 'assignment-in-condition'));
  assert.ok(!has('while (a = next(), a.ok) {}', 'assignment-in-condition'));
  // A comma that is only inside a call is not a sequence.
  assert.ok(has('if (x = f(1, 2)) {}', 'assignment-in-condition'));
  assert.ok(has('if (x = 5) {}', 'assignment-in-condition'));
  assert.ok(has('while (node = node.next) {}', 'assignment-in-condition'));
});

test('empty-catch accepts explanatory comments around the block', () => {
  assert.ok(!has('// Best-effort cleanup; failure here is fine.\nawait unlink(path).catch(() => {});', 'empty-catch'));
  assert.ok(!has('// optional dependency\ntry {\n  mod = require("optional");\n} catch (e) {}', 'empty-catch'));
  assert.ok(!has('try { fs.closeSync(fd); } catch (e) {} // already closed', 'empty-catch'));
  assert.ok(!has('try { a(); } catch (e) {\n  // ignore\n}', 'empty-catch'));
  assert.ok(!has('promise\n  .then(run)\n  // not critical\n  .catch(() => {});', 'empty-catch'));
  assert.ok(!has('// ignore errors\npromise\n  .then(run)\n  .catch(() => {});', 'empty-catch'));
  assert.ok(has('foo();\ntry { a(); } catch (e) {}', 'empty-catch'));
  assert.ok(has('// done\nfoo();\ntry { a(); } catch (e) {}', 'empty-catch'));
});

test('empty-catch ignores handlers whose result is used', () => {
  assert.ok(!has('const stats = await fs.stat(p).catch(() => {});', 'empty-catch'));
  assert.ok(!has('stats = fs.stat(p).catch(() => {});', 'empty-catch'));
  assert.ok(!has('function f() {\n  return fs.stat(p).catch(() => {});\n}', 'empty-catch'));
  assert.ok(!has('const g = () => fs.stat(p).catch(() => {});', 'empty-catch'));
  assert.ok(!has('await Promise.all(ps.map((p) => p.catch(() => {})));', 'empty-catch'));
  assert.ok(!has('const all = [a.catch(() => {}), b.catch(() => {})];', 'empty-catch'));
  assert.ok(has('await fs.unlink(p).catch(() => {});', 'empty-catch'));
  assert.ok(has('x = 1;\nfs.unlink(p).catch(() => {});', 'empty-catch'));
  assert.ok(has('x = 1\nfs.unlink(p).catch(() => {})', 'empty-catch'));
});

test('empty-catch understands TypeScript annotations and function handlers', () => {
  assert.ok(has('try { a(); } catch (e: unknown) {}', 'empty-catch', 'a.ts'));
  assert.ok(has('try { a(); } catch (e: any) {\n}', 'empty-catch', 'a.ts'));
  assert.ok(has('p.catch(function () {});', 'empty-catch'));
  assert.ok(has('p.catch(function (e) {});', 'empty-catch'));
  assert.ok(has('p.catch(function named(e) {});', 'empty-catch'));
  assert.ok(has('p.catch((e: Error) => {});', 'empty-catch', 'a.ts'));
  assert.ok(has('p.catch(async () => {});', 'empty-catch'));
  assert.ok(has('p.catch(e => {});', 'empty-catch'));
  assert.ok(!has('p.catch(function (e) { log(e); });', 'empty-catch'));
  assert.ok(!has('try { a(); } catch (e: unknown) { log(e); }', 'empty-catch', 'a.ts'));
  assert.ok(!has('x.catch(e)', 'empty-catch'));
});

test('loose-equality follows eqeqeq "smart"', () => {
  assert.ok(!has("if (typeof x == 'string' && typeof y != \"undefined\") {}", 'loose-equality'));
  assert.ok(!has("if ('undefined' == typeof module) {}", 'loose-equality'));
  assert.ok(!has('if (typeof a == typeof b) {}', 'loose-equality'));
  assert.ok(!has('if (typeof(x)=="function") {}', 'loose-equality'));
  assert.ok(!has('if (a == undefined) {}', 'loose-equality'));
  assert.ok(!has('if (a != void 0) {}', 'loose-equality'));
  assert.ok(!has('if (undefined == a) {}', 'loose-equality'));
  assert.ok(!has('if (1 == 1) {}', 'loose-equality'));
  assert.ok(!has('if ("a" != "b") {}', 'loose-equality'));
  assert.ok(has('if (a == b) {}', 'loose-equality'));
  assert.ok(has('if (a.length == 0) {}', 'loose-equality'));
  assert.ok(has('if (0x22A5 == codePoint) {}', 'loose-equality'));
  assert.ok(has("if (x == 'a') {}", 'loose-equality'));
});

test('rules stay fast on very long lines', () => {
  const eq = Array.from({ length: 20000 }, (_, i) => `typeof e${i}=="function"&&a${i}==b${i};`).join('');
  assert.ok(timed(() => analyzeSource(eq + '\n')) < 2000);
  assert.ok(timed(() => analyzeSource('a==1,'.repeat(100000) + '\n')) < 2000);
  assert.ok(timed(() => analyzeSource('try{a()}catch(e){}'.repeat(30000))) < 2000);
  assert.ok(timed(() => analyzeSource('x.catch(' + ' '.repeat(40000) + 'y)')) < 1000);
  assert.ok(timed(() => analyzeSource('short();\n'.repeat(200000))) < 3000);
  assert.ok(timed(() => analyzeSource('if(a=b,c)x();'.repeat(20000))) < 2000);
});
