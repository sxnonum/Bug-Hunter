'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');

const lines = (src, rule, file) =>
  analyzeSource(src, { file }).filter((f) => f.rule === rule).map((f) => f.line);
const has = (src, rule, file) => lines(src, rule, file).length > 0;

test('command-injection recognises the usual ways of calling exec', () => {
  for (const src of [
    'childProcess.execSync(`git checkout ${branch}`);',
    "require('child_process').execSync(`rm -rf ${dir}`);",
    "import * as proc from 'child_process'; proc.execSync(`ls ${d}`);",
    'const execAsync = promisify(exec); await execAsync(`git clone ${url}`);',
    "childProcess.exec('rm -rf ' + dir, cb);",
    'shell.exec(`git log ${ref}`);',
    'cp.exec(`ls ${d}`);',
  ]) {
    assert.ok(has(src, 'command-injection'), src);
  }
});

test('command-injection looks across lines and at more argument shapes', () => {
  assert.deepEqual(lines('execSync(\n  `git clone ${url} ${dir}`,\n  { stdio: "inherit" }\n);', 'command-injection'), [1]);
  assert.deepEqual(lines('ok();\nexecSync(`\n  git clone ${url}\n`);', 'command-injection'), [2]);
  assert.ok(has("exec(\n  'rm -rf ' + dir,\n  cb\n);", 'command-injection'));
  assert.ok(has("exec(cmd + ' ' + arg, cb);", 'command-injection'));
  assert.ok(has('exec(`rm -rf ` + dir);', 'command-injection'));
  assert.ok(has("exec('rm -rf '.concat(dir));", 'command-injection'));
});

test('command-injection leaves constants, bare variables and other receivers alone', () => {
  for (const src of [
    'exec(cmd, cb);',
    'exec("ls -la");',
    'exec(`ls -la`);',
    'exec("ls" + " -la");',
    're.exec(`${x}`);',
    "m = /a/.exec(str + 'x');",
    "other.exec('a' + b);",
    'execFile("ls", [dir]);',
    'const s = "exec(`ls ${dir}`)";',
    '// exec(`ls ${dir}`)',
  ]) {
    assert.ok(!has(src, 'command-injection'), src);
  }
});

test('insecure-random flags secret-named targets', () => {
  for (const src of [
    'const sessionId = Math.random().toString(36);',
    'const userToken = Math.random().toString(36);',
    'const resetToken = Math.random().toString(36).slice(2);',
    'const accessToken = Math.random().toString(16);',
    'const userPassword = Math.random().toString(36).slice(2, 10);',
    'const reset_token = Math.random().toString(36);',
    'const sessionId =\n  Math.random().toString(36);',
    'const o = { token: Math.random().toString(36) };',
    'this.nonce = ok ? 1 : Math.random();',
    'for (let i = 0; i < n; i++) salt[i] = Math.random() * 256 & 255;',
    "let token = ''; for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * chars.length)];",
    'function generateToken() {\n  return Math.random().toString(36).slice(2);\n}',
    'const makeNonce = () => Math.floor(Math.random() * 1e9);',
  ]) {
    assert.ok(has(src, 'insecure-random'), src);
  }
  assert.ok(has('const token: string = Math.random().toString(36);', 'insecure-random', 'a.ts'));
});

test('insecure-random leaves jitter, pool picks and unrelated keys alone', () => {
  for (const src of [
    'const jitter = Math.random() * 100;',
    'const inviteCode = Math.random().toString(36);',
    'const session = pool[Math.floor(Math.random() * pool.length)];',
    'const apiKey = keys[Math.floor(Math.random() * keys.length)];',
    'const sessionTimeout = base * (1 + Math.random() * 0.1);',
    'const opts = { token: cfg.token, backoff: Math.random() * 100 };',
    'const out = items.map(token => Math.random() < 0.5 ? token : null);',
    "console.log('salt = Math.random() is bad practice');",
    'token = getToken();\nschedule(Math.random());',
    'function pickToken(tokens) {\n  return tokens[Math.floor(Math.random() * tokens.length)];\n}',
    'function getDelay() {\n  return Math.random() * 100;\n}',
    'if (token == Math.random()) {}',
  ]) {
    assert.ok(!has(src, 'insecure-random'), src);
  }
});

test('insecure-random is linear on lines full of secret-looking keys', () => {
  const start = Date.now();
  analyzeSource('var c={' + Array.from({ length: 20000 }, (_, i) => `session${i}:${i},`).join('') + '};\n');
  analyzeSource('token=1,'.repeat(100000) + '\n');
  analyzeSource('x=Math.random();'.repeat(50000));
  analyzeSource('token=Math.random(),'.repeat(20000));
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start}ms`);
});

test('tls-verification-disabled handles ternaries and the assignment form', () => {
  assert.ok(!has('const o = { strictSsl: secureEndpoint ? !!options.rejectUnauthorized : false };', 'tls-verification-disabled'));
  assert.ok(!has('const p = c ? rejectUnauthorized : false;', 'tls-verification-disabled'));
  assert.ok(!has('https.request({ rejectUnauthorized: true });', 'tls-verification-disabled'));
  assert.ok(!has("if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {}", 'tls-verification-disabled'));
  assert.ok(!has('opts.rejectUnauthorized == false;', 'tls-verification-disabled'));
  assert.ok(has('https.globalAgent.options.rejectUnauthorized = false;', 'tls-verification-disabled'));
  assert.ok(has('opts.rejectUnauthorized = false;', 'tls-verification-disabled'));
  assert.ok(has("agent['rejectUnauthorized'] = false;", 'tls-verification-disabled'));
});

test('tls-verification-disabled sees equivalent spellings', () => {
  for (const src of [
    "spawn('node', ['a.js'], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });",
    "process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';",
    'process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;',
    "const o = { 'rejectUnauthorized': false };",
    'https.request({ rejectUnauthorized:\n  false });',
    'const o = { ...base, rejectUnauthorized: 0 };',
    'const o = { rejectUnauthorized: !1 };',
  ]) {
    assert.ok(has(src, 'tls-verification-disabled'), src);
  }
});

test('no-eval skips declarations and constant Function bodies', () => {
  assert.ok(!has('declare function eval(x: string): any;', 'no-eval', 'a.ts'));
  assert.ok(!has('class Repl { eval(code: string) { return vm.runInContext(code, this.ctx); } }', 'no-eval', 'a.ts'));
  assert.ok(!has('const repl = {\n  async eval(code) { return run(code); },\n};', 'no-eval'));
  assert.ok(!has('interface Repl { eval(code: string): unknown; }', 'no-eval', 'a.ts'));
  assert.ok(!has('const dynamicImport = new Function("module", "return import(module)");', 'no-eval'));
  assert.ok(!has("cached = Function('return async function () {}')().constructor;", 'no-eval'));
  assert.ok(!has("const g = new window.Function('return 1');", 'no-eval'));
  assert.ok(!has('page.eval(x);', 'no-eval'));
  assert.ok(!has('const s = "window.eval(x)"; // eval(y)', 'no-eval'));
  assert.ok(has('const r = cond ? eval(a) : b;', 'no-eval'));
  assert.ok(has('const f = new Function("a", body);', 'no-eval'));
  assert.ok(has('const f = new Function("a" + b);', 'no-eval'));
});

test('no-eval sees indirect eval, global receivers and Function without new', () => {
  for (const src of [
    '(0, eval)(code);',
    'window.eval(code);',
    'globalThis.eval(code);',
    'self.eval(code);',
    "const f = Function('a', body);",
    'const g = new window.Function(code);',
    "const h = new\n  Function('a', body);",
  ]) {
    assert.ok(has(src, 'no-eval'), src);
  }
  assert.deepEqual(lines('ok();\nconst h = new\n  Function(a, body);', 'no-eval'), [2]);
});

test('dom-xss ignores constant strings', () => {
  assert.ok(!has('el.innerHTML = "";', 'dom-xss'));
  assert.ok(!has("el.innerHTML = '<b>hi</b>';", 'dom-xss'));
  assert.ok(!has('el.innerHTML = `<b>hi</b>`;', 'dom-xss'));
  assert.ok(!has("el.innerHTML =\n  '<b>hi</b>';", 'dom-xss'));
  assert.ok(has('el.innerHTML = x;', 'dom-xss'));
  assert.ok(has("el.innerHTML = '<b>' + x + '</b>';", 'dom-xss'));
  assert.ok(has('el.innerHTML = `<b>${x}</b>`;', 'dom-xss'));
  assert.ok(has('el.innerHTML += x;', 'dom-xss'));
  assert.ok(has('el.innerHTML =\n  y;', 'dom-xss'));
});
