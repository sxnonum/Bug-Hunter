'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');

const ids = (src, opts) => analyzeSource(src, opts).map((f) => f.rule);
const has = (src, rule) => ids(src).includes(rule);

test('no-eval flags eval and new Function but not methods or strings', () => {
  assert.ok(has('eval(input);', 'no-eval'));
  assert.ok(has('const f = new Function("a", body);', 'no-eval'));
  assert.ok(!has('page.eval(x);', 'no-eval'));
  assert.ok(!has('const s = "eval(x)"; // eval(y)', 'no-eval'));
});

test('no-debugger', () => {
  assert.ok(has('function f() {\n  debugger;\n}', 'no-debugger'));
  assert.ok(!has('const s = "debugger";', 'no-debugger'));
});

test('loose-equality allows the == null idiom', () => {
  assert.ok(has('if (a == b) {}', 'loose-equality'));
  assert.ok(has('if (a != 1) {}', 'loose-equality'));
  assert.ok(!has('if (a === b || a !== c) {}', 'loose-equality'));
  assert.ok(!has('if (a == null) {}', 'loose-equality'));
  assert.ok(!has('if (a >= 1 && b <= 2) {}', 'loose-equality'));
});

test('nan-comparison', () => {
  assert.ok(has('if (x === NaN) {}', 'nan-comparison'));
  assert.ok(has('if (NaN != x) {}', 'nan-comparison'));
  assert.ok(!has('if (Number.isNaN(x)) {}', 'nan-comparison'));
});

test('assignment-in-condition', () => {
  assert.ok(has('if (x = 5) {}', 'assignment-in-condition'));
  assert.ok(has('while (node = node.next) {}', 'assignment-in-condition'));
  assert.ok(!has('if (x == 5) {}', 'assignment-in-condition'));
  assert.ok(!has('if (x === 5) {}', 'assignment-in-condition'));
  assert.ok(!has('if (x <= 5) {}', 'assignment-in-condition'));
  assert.ok(!has('while ((m = re.exec(s))) {}', 'assignment-in-condition'));
});

test('empty-catch ignores blocks that contain a comment', () => {
  assert.ok(has('try { a(); } catch (e) {}', 'empty-catch'));
  assert.ok(has('try { a(); } catch {\n}', 'empty-catch'));
  assert.ok(has('p.catch(() => {});', 'empty-catch'));
  assert.ok(!has('try { a(); } catch (e) { /* ignore: best effort */ }', 'empty-catch'));
  assert.ok(!has('try { a(); } catch (e) { log(e); }', 'empty-catch'));
});

test('foreach-async', () => {
  assert.ok(has('items.forEach(async (i) => { await save(i); });', 'foreach-async'));
  assert.ok(!has('items.forEach((i) => save(i));', 'foreach-async'));
});

test('hardcoded-secret detects known formats and assignments without echoing the value', () => {
  const aws = 'AK' + 'IAABCDEFGHIJKLMNOP';
  const gh = 'gh' + 'p_' + 'a'.repeat(36);
  const [awsFinding] = analyzeSource(`const k = "${aws}";`);
  assert.equal(awsFinding.rule, 'hardcoded-secret');
  assert.ok(!awsFinding.message.includes(aws));
  assert.ok(has(`const t = "${gh}";`, 'hardcoded-secret'));
  assert.ok(has('const cfg = { password: "hunter2hunter2" };', 'hardcoded-secret'));
  assert.ok(has('const apiKey = "abcd1234efgh5678";', 'hardcoded-secret'));
  assert.ok(has('const k = "-----BEGIN RSA ' + 'PRIVATE KEY-----";', 'hardcoded-secret'));
});

test('hardcoded-secret skips env lookups, placeholders and messages', () => {
  assert.ok(!has('const apiKey = process.env.API_KEY;', 'hardcoded-secret'));
  assert.ok(!has('const password = "xxxxxxxxxx";', 'hardcoded-secret'));
  assert.ok(!has('const password = "<your password>";', 'hardcoded-secret'));
  assert.ok(!has('const tokenError = "Token must be at least 8 characters";', 'hardcoded-secret'));
  assert.ok(!has('const password = "short";', 'hardcoded-secret'));
});

test('command-injection flags interpolated and concatenated commands only', () => {
  assert.ok(has('exec(`ls ${dir}`);', 'command-injection'));
  assert.ok(has('child_process.execSync("rm -rf " + dir);', 'command-injection'));
  assert.ok(!has('exec("ls -la");', 'command-injection'));
  assert.ok(!has('re.exec(`${x}`);', 'command-injection'));
  assert.ok(!has('execFile("ls", [dir]);', 'command-injection'));
});

test('unreachable-code', () => {
  assert.ok(has('function f() {\n  return 1;\n  cleanup();\n}', 'unreachable-code'));
  assert.ok(has('for (;;) {\n  break;\n  x();\n}', 'unreachable-code'));
  assert.deepEqual(
    analyzeSource('function f() {\n  throw new Error("x");\n\n  y();\n}').filter((f) => f.rule === 'unreachable-code').map((f) => f.line),
    [4]
  );
});

test('unreachable-code has no false positives on common shapes', () => {
  assert.ok(!has('function f(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}', 'unreachable-code'));
  assert.ok(!has('switch (x) {\n  case 1:\n    return 1;\n  case 2:\n    return 2;\n  default:\n    return 3;\n}', 'unreachable-code'));
  assert.ok(!has('if (a)\n  return 1;\nelse\n  return 2;', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return g();\n  function g() {}\n}', 'unreachable-code'));
  assert.ok(!has('function f() {\n  return {\n    a: 1,\n  };\n}', 'unreachable-code'));
  assert.ok(!has('if (a)\n  return 1;\nb();', 'unreachable-code'));
});

test('parseint-radix', () => {
  assert.ok(has('parseInt(value);', 'parseint-radix'));
  assert.ok(has('parseInt(a.b(c));', 'parseint-radix'));
  assert.ok(!has('parseInt(value, 10);', 'parseint-radix'));
  assert.ok(!has('parseInt(a.b(c, d), 10);', 'parseint-radix'));
});

test('insecure-random', () => {
  assert.ok(has('const sessionId = Math.random().toString(36);', 'insecure-random'));
  assert.ok(!has('const jitter = Math.random() * 100;', 'insecure-random'));
});

test('tls-verification-disabled', () => {
  assert.ok(has('https.request({ rejectUnauthorized: false });', 'tls-verification-disabled'));
  assert.ok(has('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";', 'tls-verification-disabled'));
  assert.ok(!has('https.request({ rejectUnauthorized: true });', 'tls-verification-disabled'));
});

test('dom-xss', () => {
  assert.ok(has('el.innerHTML = userInput;', 'dom-xss'));
  assert.ok(has('document.write(x);', 'dom-xss'));
  assert.ok(!has('el.textContent = userInput;', 'dom-xss'));
  assert.ok(!has('if (el.innerHTML === "") {}', 'dom-xss'));
});

test('todo-marker only counts real comments', () => {
  assert.ok(has('// TODO: fix this', 'todo-marker'));
  assert.ok(has('/* FIXME later */', 'todo-marker'));
  assert.ok(!has('const s = "// TODO not a comment";', 'todo-marker'));
});

test('findings carry file, position and are sorted', () => {
  const found = analyzeSource('ok();\n  eval(a);\nif (x == y) {}\n', { file: 'demo.js' });
  assert.deepEqual(
    found.map((f) => [f.file, f.line, f.column, f.rule]),
    [['demo.js', 2, 3, 'no-eval'], ['demo.js', 3, 7, 'loose-equality']]
  );
});

test('inline directives suppress findings', () => {
  assert.deepEqual(ids('eval(a); // bughunter-disable-line'), []);
  assert.deepEqual(ids('eval(a); // bughunter-disable-line no-eval'), []);
  assert.deepEqual(ids('// bughunter-disable-next-line no-eval\neval(a);'), []);
  assert.deepEqual(ids('eval(a); // bughunter-disable-line loose-equality'), ['no-eval']);
  assert.deepEqual(ids('// bughunter-disable-next-line no-eval\n\neval(a);'), ['no-eval']);
});

test('disabledRules option skips rules', () => {
  assert.deepEqual(ids('eval(a);', { disabledRules: ['no-eval'] }), []);
});

test('CRLF line endings give the same line numbers', () => {
  const found = analyzeSource('a();\r\nb();\r\neval(c);\r\n');
  assert.deepEqual(found.map((f) => f.line), [3]);
});
