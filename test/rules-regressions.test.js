'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');
const { rules } = require('../src/rules');

const lines = (src, rule, file = 'a.js') =>
  analyzeSource(src, { file }).filter((f) => f.rule === rule).map((f) => f.line);
const has = (src, rule, file) => lines(src, rule, file).length > 0;
const timed = (fn) => {
  const start = Date.now();
  fn();
  return Date.now() - start;
};

test('unreachable-code: multi-line JSX returned without parentheses is not dead code', () => {
  const jsx = (src) => lines(src, 'unreachable-code', 'T.jsx');
  assert.deepEqual(jsx('function T({title}) {\n  return <h1>\n    {title}\n  </h1>;\n}\n'), []);
  assert.deepEqual(jsx('function T() {\n  return <h1>\n    Hello\n  </h1>;\n}\n'), []);
  assert.deepEqual(jsx('function T() {\n  return <p>\n    Count: {n}\n  </p>;\n}\n'), []);
  assert.deepEqual(jsx('class A { render() {\n  return <div className="a">\n    {this.props.children}\n  </div>;\n} }\n'), []);
  assert.deepEqual(jsx('function T() {\n  return <>\n    {a}\n  </>;\n}\n'), []);
  assert.deepEqual(jsx('function T() {\n  return <div\n    a="1"\n  />;\n}\n'), []);
  assert.deepEqual(jsx('function T() {\n  return <a onClick={() => go(1 > 0)}>\n    <b>{x}</b>\n  </a>\n}\n'), []);
  // A closing tag or `/>` at the start of a line is never a statement.
  assert.deepEqual(jsx('function T() {\n  return;\n  </h1>;\n}\n'), []);
  // Real dead code after the element is still found, on the line after the closing tag.
  assert.deepEqual(jsx('function T() {\n  return <h1>\n    Hello\n  </h1>;\n  foo();\n}\n'), [5]);
  assert.deepEqual(jsx('function T() {\n  return <h1>\n    {a}\n  </h1>\n  foo();\n}\n'), [5]);
  assert.deepEqual(jsx('function T() {\n  return <br />;\n  foo();\n}\n'), [3]);
  // Plain statements are unaffected.
  assert.deepEqual(jsx('function f() {\n  return a < b;\n  foo();\n}\n'), [3]);
  // In TypeScript files `<T>x` is a cast, not JSX.
  assert.deepEqual(lines('function f() {\n  return <any>x;\n  foo();\n}\n', 'unreachable-code', 'a.ts'), [3]);
});

test('empty-catch: a JSX or string text line above is not a comment', () => {
  const mk = (text) =>
    `export const A = () => (\n  <div>\n${text}    <button onClick={() => { load().catch(() => {}); }}>go</button>\n  </div>\n);\n`;
  assert.equal(lines(mk(''), 'empty-catch', 'a.jsx').length, 1);
  assert.equal(lines(mk('    Reload data\n'), 'empty-catch', 'a.jsx').length, 1);
  assert.equal(lines('const s = `\n  text line\n`;\ntry { load(); } catch (e) {}\n', 'empty-catch').length, 1);
  assert.equal(lines('const s = "a\\\nb";\ntry { load(); } catch (e) {}\n', 'empty-catch').length, 1);
  // A real comment line above still explains the empty block.
  assert.equal(lines('// ignore: best effort\ntry { load(); } catch (e) {}\n', 'empty-catch').length, 0);
  assert.equal(lines('  <div>\n    // not a comment, JSX text\n    <a onClick={() => { load().catch(() => {}); }} />\n  </div>\n', 'empty-catch', 'a.jsx').length, 1);
  assert.equal(lines('/* best effort */\nload().catch(() => {});\n', 'empty-catch').length, 0);
});

test('command-injection: execFile*, execute* and friends do not spawn a shell', () => {
  const cmd = (src) => has(src, 'command-injection');
  assert.ok(!cmd("const cp = require('child_process');\ncp.execFileSync(__dirname + '/cli.js', ['--version']);"));
  assert.ok(!cmd('cp.execFileSync(`${binDir}/protoc`, [\'--version\']);'));
  assert.ok(!cmd("childProcess.execFile(dir + '/x', []);"));
  assert.ok(!cmd("require('child_process').execFileSync(dir + '/x');"));
  assert.ok(!cmd('sh.execute(`run ${x}`);'));
  assert.ok(!cmd("proc.executeQuery('a' + b);"));
  assert.ok(!cmd("shell.execPath('a' + b);"));
  assert.ok(cmd("cp.exec('ls ' + dir);"));
  assert.ok(cmd('cp.execSync(`ls ${dir}`);'));
  assert.ok(cmd("childProcess.execAsync('ls ' + dir);"));
  assert.ok(cmd("require('child_process').exec('ls ' + dir);"));
  assert.ok(cmd('execSync(`ls ${dir}`);'));
});

test('command-injection: a long first argument is still examined', () => {
  const script = 'echo "step"; sleep 1\n'.repeat(200);
  assert.ok(script.length > 4000);
  assert.ok(has('execSync(`cd ${dir}\n' + script + '`);', 'command-injection'));
  assert.ok(has('execSync("' + 'a'.repeat(3000) + '" + dir);', 'command-injection'));
  assert.ok(has('execSync(`' + script + '${dir}`, { stdio: "inherit" });', 'command-injection'));
  assert.ok(!has('execSync(`' + script + '`);', 'command-injection'));
  assert.ok(!has('execSync("' + 'a'.repeat(3000) + '");', 'command-injection'));
  // Unclosed calls cannot make the scan quadratic.
  assert.ok(timed(() => analyzeSource('exec(\n'.repeat(60000))) < 2000);
});

test('empty-catch: a used result stays used across multi-line callbacks and objects', () => {
  const ec = (src) => has(src, 'empty-catch');
  assert.ok(!ec('function load() {\n  return fetch(url).then(res => {\n    cache.set(url, res);\n    return res;\n  }).catch(() => {});\n}'));
  assert.ok(!ec('async function f() {\n  const data = await load().then((x) => {\n    return x.data;\n  }).catch(() => {});\n}'));
  assert.ok(!ec('function f() {\n  return run({\n    cwd,\n    env,\n  }).catch(() => {});\n}'));
  assert.ok(!ec('const w = cond ? this.evaluate(a, {\n  b,\n  c,\n}).catch(() => {}) : Promise.resolve();'));
  assert.ok(!ec('const promise = page.on("x", () => {\n  a();\n}).catch(() => {});\nthis.add(promise);'));
  assert.ok(!ec('const p = f(function () {\n  g();\n}).catch(() => {});'));
  // As a plain statement the swallowed error is still reported, with or without nested callbacks.
  assert.ok(ec('function f() {\n  fetch(url).then(res => {\n    ok();\n  }).catch(() => {});\n}'));
  assert.ok(ec('async function f() {\n  await this._channel.close({ ...options, wasClean: true }).catch(() => {\n  });\n}'));
  assert.ok(ec('if (x) {\n  y();\n}\nfs.unlink(p).catch(() => {});'));
  assert.ok(ec('function f() {\n  return 1;\n}\nfs.unlink(p, {\n  a,\n}).catch(() => {});'));
});

test('loose-equality: typeof of a call or parenthesised expression is a typeof check', () => {
  const le = (src) => has(src, 'loose-equality');
  assert.ok(!le("if (typeof getValue() == 'function') {}"));
  assert.ok(!le("if (typeof (a || b) == 'string') {}"));
  assert.ok(!le("if (typeof require('x') != 'undefined') {}"));
  assert.ok(!le("if (typeof a.b(c) == 'string') {}"));
  assert.ok(!le('if (typeof (sch = this.x) == "string") {}'));
  assert.ok(!le("if (typeof a[0].b == 'string') {}"));
  assert.ok(!le("if (typeof a?.b?.() == 'string') {}"));
  assert.ok(!le("if (typeof f(g(1), [2])  == 'string') {}"));
  // Not typeof: the operand is something else.
  assert.ok(le("if (f(x) == 'string') {}"));
  assert.ok(le("if (typeof a + b == 'string') {}"));
  assert.ok(le("if ((a || b) == c) {}"));
  assert.ok(le('if (new Foo(typeof x) == y) {}'));
});

test('loose-equality: an operand wrapped onto the next or previous line counts', () => {
  const le = (src) => has(src, 'loose-equality');
  assert.ok(!le('if (\n  opts.someVeryLongPropertyName.anotherVeryLongPropertyName.yetAnotherPropertyName ==\n  null\n) {}'));
  assert.ok(!le('if (a !=\n  undefined) {}'));
  assert.ok(!le('if (typeof long.chain ==\n  "undefined") {}'));
  assert.ok(!le('if (a\n  == null) {}'));
  assert.ok(!le('if (undefined\n  != a) {}'));
  assert.ok(!le('if (a ==\n  typeof b) {}'));
  assert.ok(!le('if (a ==\n\n  void 0) {}'));
  assert.ok(le('if (a ==\n  b) {}'));
  assert.ok(le('if (aVeryLongName ==\n  someOtherName) {}'));
  assert.ok(le('if (a !=\n  1) {}'));
});

test('loose-equality: literal pairs are exempt only when both have the same type', () => {
  const le = (src) => has(src, 'loose-equality');
  assert.ok(!le('x = 1 == 1;'));
  assert.ok(!le('x = "a" != "b";'));
  assert.ok(!le('x = true == false;'));
  assert.ok(le('x = 1 == "1";'));
  assert.ok(le('x = true == 1;'));
  assert.ok(le('x = "1" != 1;'));
  const [rule] = rules.filter((r) => r.id === 'loose-equality');
  assert.match(rule.description, /null/);
  assert.match(rule.description, /undefined/);
  assert.match(rule.description, /typeof/);
  assert.match(rule.description, /same-type literal/);
});

test('tls-verification-disabled: messages, docs and type declarations are not configuration', () => {
  const tls = (src, file) => has(src, 'tls-verification-disabled', file);
  assert.ok(!tls("throw new Error('self-signed certificate; pass { rejectUnauthorized: false } to ignore (unsafe)');"));
  assert.ok(!tls("console.warn('NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks');"));
  assert.ok(!tls('console.warn("do not set agent.rejectUnauthorized = false in production");'));
  assert.ok(!tls('console.log("Run with NODE_TLS_REJECT_UNAUTHORIZED=0 to skip checks");'));
  assert.ok(!tls('const help = `Set NODE_TLS_REJECT_UNAUTHORIZED=0 to ignore certificate errors`;'));
  assert.ok(!tls('const help = `Example:\n  https.get(url, { rejectUnauthorized: false })`;'));
  assert.ok(!tls("process.stderr.write('NODE_TLS_REJECT_UNAUTHORIZED=0 is unsafe\\n');"));
  assert.ok(!tls("throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is set');"));
  assert.ok(!tls('// https.get(url, { rejectUnauthorized: false })'));
  assert.ok(!tls('interface Opts { rejectUnauthorized: false }', 'a.ts'));
  assert.ok(!tls('type T = { rejectUnauthorized: false } | { rejectUnauthorized: true; ca: string };', 'a.ts'));
  assert.ok(!tls('class A {\n  rejectUnauthorized: false;\n}', 'a.ts'));
});

test('tls-verification-disabled: real configuration is still found', () => {
  const tls = (src, file) => has(src, 'tls-verification-disabled', file);
  assert.ok(tls('https.get(u, { rejectUnauthorized: false });'));
  assert.ok(tls('agent.rejectUnauthorized = false;'));
  assert.ok(tls("opts['rejectUnauthorized'] = false;"));
  assert.ok(tls("const o = { 'rejectUnauthorized': false };"));
  assert.ok(tls("const o = { \"rejectUnauthorized\": 0 };"));
  assert.ok(tls("process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"));
  assert.ok(tls("process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;"));
  assert.ok(tls("const e = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };"));
  assert.ok(tls("execSync('NODE_TLS_REJECT_UNAUTHORIZED=0 node x.js');"));
  assert.ok(tls("const cmd = 'cd app && NODE_TLS_REJECT_UNAUTHORIZED=0 node y.js';"));
  assert.ok(tls("spawn('sh', ['-c', 'echo hi; NODE_TLS_REJECT_UNAUTHORIZED=0 node y']);"));
  assert.ok(tls("exec('export NODE_TLS_REJECT_UNAUTHORIZED=0 && npm test');"));
  assert.ok(tls("const o = { env: { 'NODE_TLS_REJECT_UNAUTHORIZED': '0' } };"));
  // Inside a TypeScript file an object literal is still configuration.
  assert.ok(tls('const o = { rejectUnauthorized: false };', 'a.ts'));
  assert.ok(tls('const o: Opts = { agent: { rejectUnauthorized: false } };', 'a.ts'));
  assert.ok(tls('class A {\n  opts = { rejectUnauthorized: false };\n}', 'a.ts'));
});

test('empty-catch: annotated handlers and catch clauses are matched in linear time', () => {
  assert.ok(timed(() => analyzeSource('.catch((e): ' + ' '.repeat(4000) + 'x\n')) < 200);
  assert.ok(timed(() => analyzeSource('catch (' + ' '.repeat(4000) + 'x\n')) < 200);
  assert.ok(timed(() => analyzeSource('catch' + ' '.repeat(4000) + 'x\n')) < 200);
  assert.ok(timed(() => analyzeSource('.catch((e): a' + ' b'.repeat(2000) + '\n')) < 200);
  assert.ok(timed(() => analyzeSource('parseInt(' + ' '.repeat(4000) + '\n')) < 200);
  // Behaviour is unchanged.
  assert.ok(has('p.catch((e: Error)   => {});', 'empty-catch', 'a.ts'));
  assert.ok(has('p.catch((e): Promise<void> => {});', 'empty-catch', 'a.ts'));
  assert.ok(has('try { a(); } catch    {}', 'empty-catch'));
  assert.ok(has('try { a(); } catch ( e )  {}', 'empty-catch'));
  assert.ok(has('try { a(); } catch (e: unknown)\n{}', 'empty-catch', 'a.ts'));
  assert.ok(has('try { a(); } catch {\n}', 'empty-catch'));
  assert.ok(has('parseInt( x )', 'parseint-radix'));
  assert.ok(!has('parseInt( x, 10)', 'parseint-radix'));
});

test('no rule is slow on adversarial lines', () => {
  const fillers = [' ', 'a', '(', '[', '{', '=', "'", '"', '`', ',', ':', '.', '<', '/', '*'];
  const prefixes = [
    '', 'catch', '.catch(', '.catch((e): ', 'if (', 'parseInt(', 'password =', "'password'", 'obj[', 'exec(',
    'return <a>', 'typeof (', 'x ==', 'rejectUnauthorized', 'NODE_TLS_REJECT_UNAUTHORIZED=', '-----BEGIN PRIVATE KEY-----',
    "'a://u", 'xoxb-1-', '// ',
  ];
  let worst = 0;
  for (const pre of prefixes) {
    for (const f of fillers) {
      const run = f.repeat(5000);
      for (const src of [pre + run, run + pre, `${pre}${run}\n${pre}${run.slice(0, 200)}`]) {
        worst = Math.max(worst, timed(() => analyzeSource(src)));
      }
    }
  }
  assert.ok(worst < 400, `slowest case took ${worst}ms`);
});
