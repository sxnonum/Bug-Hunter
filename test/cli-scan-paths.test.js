'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BIN, run, fixtureDir } = require('./cli-helpers');

const json = (r) => JSON.parse(r.stdout);

test('a minified file named on the command line is scanned', () => {
  const dir = fixtureDir({ 'app.min.js': 'eval(x);\n', 'icons.js': `eval(x);\nvar i = "${'a'.repeat(6000)}";\n` });
  for (const name of ['app.min.js', 'icons.js']) {
    const r = run(['--format', 'json', path.join(dir, name)]);
    assert.equal(r.status, 1, name);
    assert.equal(json(r).filesScanned, 1, name);
    assert.ok(json(r).findings.some((f) => f.rule === 'no-eval'), name);
    assert.equal(r.stderr, '', name);
  }
  // ... also when it is reached through a symlink, and when a directory containing it comes first
  fs.symlinkSync('app.min.js', path.join(dir, 'lnk.js'));
  assert.equal(json(run(['--format', 'json', path.join(dir, 'lnk.js')])).filesScanned, 1);
  const r = run(['--format', 'json', dir, path.join(dir, 'app.min.js')]);
  assert.equal(json(r).filesScanned, 1);
  assert.equal(json(r).skipped.length, 1); // only icons.js, skipped while walking the directory
  assert.match(r.stderr, /skipped 1 minified\/bundled file\(s\): .*icons\.js/);
});

test('minified files found in a directory are still skipped, and the names are listed (first 5)', () => {
  const files = { 'ok.js': 'module.exports = 1;\n' };
  for (let i = 1; i <= 7; i++) files[`m${i}.min.js`] = 'a;\n';
  const dir = fixtureDir(files);
  const r = run([dir]);
  assert.equal(r.status, 0);
  const line = r.stderr.split('\n').find((l) => l.includes('minified/bundled'));
  assert.match(line, /skipped 7 minified\/bundled file\(s\): /);
  for (let i = 1; i <= 5; i++) assert.ok(line.includes(`m${i}.min.js`), `m${i}`);
  assert.ok(!line.includes('m6.min.js') && line.includes('...'), line);
  assert.match(line, /\(use --include-minified to scan them\)$/);
});

test('explicit files over 1 MB or binary are skipped with a stderr line, and the text summary counts skips', () => {
  const dir = fixtureDir({ 'big.js': `${'// x\n'.repeat(250000)}eval(1);\n`, 'bin.js': 'eval(x);\0\n', 'ok.js': 'var a = 1;\n' });
  const r = run([path.join(dir, 'big.js'), path.join(dir, 'bin.js'), path.join(dir, 'ok.js')]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /big\.js: skipped \(over 1 MB\)/);
  assert.match(r.stderr, /bin\.js: skipped \(binary file\)/);
  assert.match(r.stdout, /^0 findings in 1 file, 2 skipped$/m);
  assert.match(run([path.join(dir, 'ok.js')]).stdout, /^0 findings in 1 file$/m); // nothing skipped, no suffix
});

test('a real file is reported under its real path, whatever the directory order', () => {
  const dir = fixtureDir({ 'lib/x.js': 'eval(1);\n', 'z/real.js': 'eval(2);\n' });
  fs.mkdirSync(path.join(dir, 'app'));
  fs.symlinkSync('../lib', path.join(dir, 'app', 'lib'));
  fs.symlinkSync('../z/real.js', path.join(dir, 'app', 'link.js'));
  for (const targets of [['.'], ['app', 'lib', 'z'], ['lib', 'app', 'z']]) {
    const r = run(['--format', 'json', ...targets], { cwd: dir });
    const files = json(r).findings.map((f) => f.file.replace(/^\.\//, '')).sort();
    assert.deepEqual(files, ['lib/x.js', 'z/real.js'], targets.join(' '));
    assert.equal(json(r).filesScanned, 2);
    assert.equal(r.stderr, '');
  }
});

test('an alias is still scanned when the real file is not part of the scan', () => {
  const dir = fixtureDir({ 'lib/x.js': 'eval(1);\n' });
  fs.mkdirSync(path.join(dir, 'app'));
  fs.symlinkSync('../lib', path.join(dir, 'app', 'lib'));
  const out = json(run(['--format', 'json', 'app'], { cwd: dir }));
  assert.deepEqual(out.findings.map((f) => f.file), ['app/lib/x.js']);
});

test('symlink loops through the second pass still terminate', () => {
  const dir = fixtureDir({ 'a/x.js': 'eval(1);\n' });
  fs.symlinkSync('..', path.join(dir, 'a', 'up'));
  fs.symlinkSync('../a', path.join(dir, 'a', 'back'));
  const out = json(run(['--format', 'json', dir]));
  assert.equal(out.filesScanned, 1);
  assert.equal(out.errors.length, 0);
});

test('dangling symlinks only matter when the name is a scannable source file', () => {
  const dir = fixtureDir({ 'ok.js': 'var a = 1;\n' });
  for (const name of ['.env', 'LICENSE', 'Makefile', 'README.md', 'cfg.json']) fs.symlinkSync('nowhere', path.join(dir, name));
  const r = run([dir]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  fs.symlinkSync('nowhere', path.join(dir, 'gone.ts'));
  const r2 = run([dir]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /gone\.ts: dangling symlink/);
  assert.doesNotMatch(r2.stderr, /\.env|LICENSE|Makefile/);
});

test('a leading UTF-8 BOM in the config file is ignored', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\n', 'c/a.js': 'eval(x);\n' });
  fs.writeFileSync(path.join(dir, '.bughunterrc.json'), '﻿{"disable":["no-eval"]}');
  const r = run(['--format', 'json', '.'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(json(r).findings.length, 0);
  fs.writeFileSync(path.join(dir, 'bom.json'), '﻿{"failOn":"high"}\n');
  const r2 = run(['--config', 'bom.json', '--disable', 'no-debugger', 'c'], { cwd: dir });
  assert.equal(r2.status, 1);
  assert.doesNotMatch(r2.stderr, /invalid JSON/);
  // a BOM in the middle is still an error
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"failOn":﻿"high"}');
  assert.equal(run(['--config', 'bad.json', 'c'], { cwd: dir }).status, 2);
});

test('a report that cannot be written exits 2 with a one-line message, no stack trace', { skip: !fs.existsSync('/dev/full') }, () => {
  const dir = fixtureDir({ 'a.js': 'var a = 1;\n' }); // clean tree: exit 1 would be wrong
  for (const format of ['text', 'json', 'sarif']) {
    const fd = fs.openSync('/dev/full', 'w');
    let r;
    try {
      r = spawnSync(process.execPath, [BIN, '--format', format, dir], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(r.status, 2, format);
    assert.match(r.stderr, /^bughunter: cannot write output: ENOSPC$/m, format);
    assert.doesNotMatch(r.stderr, /\n\s+at |throw/, format);
  }
});
