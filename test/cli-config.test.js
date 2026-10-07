'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, fixtureDir } = require('./cli-helpers');

const withConfig = (config, files = { 'a.js': 'eval(x);\ndebugger;\n' }) =>
  fixtureDir({ '.bughunterrc.json': typeof config === 'string' ? config : JSON.stringify(config), ...files });

test('.bughunterrc.json in the current directory is applied', () => {
  const dir = withConfig({ disable: ['no-eval'], minSeverity: 'high' });
  const r = run(['--format', 'json', '.'], { cwd: dir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.findings.length, 0);
  assert.equal(out.hidden, 1); // debugger, below minSeverity
  assert.equal(r.status, 1); // but still above failOn (medium)
});

test('failOn from the config sets the exit code', () => {
  const dir = withConfig({ failOn: 'high' }, { 'a.js': 'debugger;\n' });
  assert.equal(run(['.'], { cwd: dir }).status, 0);
  assert.equal(run(['--fail-on', 'medium', '.'], { cwd: dir }).status, 1); // flag wins
});

test('flags override the config file', () => {
  const dir = withConfig({ disable: ['no-eval'], minSeverity: 'high' });
  const r = run(['--disable', 'no-debugger', '--min-severity', 'info', '--format', 'json', '.'], { cwd: dir });
  assert.deepEqual(JSON.parse(r.stdout).findings.map((f) => f.rule), ['no-eval']);
});

test('--config reads an explicit file, and a missing one is an error', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\n', 'custom.json': '{"disable":["no-eval"]}' });
  assert.equal(run(['--config', path.join(dir, 'custom.json'), dir]).status, 0);
  const r = run(['--config', path.join(dir, 'missing.json'), dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read config .*missing\.json: ENOENT/);
});

test('exclude supports directory names, * and ** globs, relative to the scan root', () => {
  const dir = withConfig(
    { exclude: ['fixtures', '**/*.generated.js', 'lib/legacy/*.js', '*.spec.js'] },
    {
      'fixtures/a.js': 'eval(1);\n',
      'src/fixtures/b.js': 'eval(2);\n',
      'src/x.generated.js': 'eval(3);\n',
      'x.generated.js': 'eval(3);\n',
      'lib/legacy/c.js': 'eval(4);\n',
      'lib/legacy/deep/d.js': 'eval(5);\n', // not matched: `*` stays within one segment
      'lib/ok.js': 'eval(6);\n',
      'src/y.spec.js': 'eval(7);\n',
    }
  );
  const out = JSON.parse(run(['--format', 'json', '.'], { cwd: dir }).stdout);
  const files = out.findings.map((f) => f.file.replace(/\\/g, '/')).sort();
  assert.deepEqual(files, ['lib/legacy/deep/d.js', 'lib/ok.js']);
});

test('exclude does not apply to files named explicitly', () => {
  const dir = withConfig({ exclude: ['*.js'] }, { 'a.js': 'eval(1);\n' });
  assert.equal(run(['a.js'], { cwd: dir }).status, 1);
  assert.equal(run(['.'], { cwd: dir }).status, 0);
});

test('invalid config values exit 2 with a clear message', () => {
  const cases = [
    ['{not json', /invalid JSON/],
    ['[]', /expected a JSON object/],
    [{ failOn: 'urgent' }, /"failOn" must be one of/],
    [{ minSeverity: 3 }, /"minSeverity" must be one of/],
    [{ disable: 'no-eval' }, /"disable" must be an array/],
    [{ disable: ['nope'] }, /unknown rule "nope"/],
    [{ exclude: [1] }, /"exclude" must be an array/],
    [{ exclude: [''] }, /"exclude" must be an array/],
    [{ include: [] }, /unknown key "include"/],
  ];
  for (const [config, pattern] of cases) {
    const dir = withConfig(config);
    const r = run(['.'], { cwd: dir });
    assert.equal(r.status, 2, JSON.stringify(config));
    assert.match(r.stderr, pattern);
    assert.doesNotMatch(r.stderr, /Usage:/); // a short message, not the whole help
    assert.equal(r.stdout, '');
  }
});
