'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BIN, run, fixtureDir } = require('./cli-helpers');

test('a large report on a pipe arrives complete', () => {
  const dir = fixtureDir({ 'm.js': 'a==b\n'.repeat(3000) }); // ~580 KB of JSON
  const r = run(['--format', 'json', dir]);
  assert.equal(r.status, 0); // loose-equality is low, below the default --fail-on
  assert.ok(r.stdout.length > 200 * 1024, `only ${r.stdout.length} bytes`);
  assert.equal(JSON.parse(r.stdout).findings.length, 3000);
  const text = run([dir]).stdout;
  assert.match(text, /3000 findings/);
});

test('a reader that closes early does not make the CLI crash', async () => {
  const dir = fixtureDir({ 'm.js': 'a==b\n'.repeat(3000) });
  const child = spawn(process.execPath, [BIN, '--format', 'json', dir]);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(stderr, '');
});

test('a dangling symlink is an error: reported, scan continues, exit 2', () => {
  const dir = fixtureDir({ 'ok.js': 'eval(x);\n' });
  fs.symlinkSync('nope.js', path.join(dir, 'dangling.js'));
  const r = run([dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bughunter: .*dangling\.js: dangling symlink/);
  assert.match(r.stdout, /no-eval/); // the good file is still reported
  assert.doesNotMatch(r.stderr, /\n\s+at /); // no stack trace
});

test('a self-referencing symlink is reported, not fatal', () => {
  const dir = fixtureDir({ 'ok.js': 'eval(x);\n' });
  fs.symlinkSync('loop.js', path.join(dir, 'loop.js'));
  const r = run(['--format', 'json', dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /loop\.js: symlink loop/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.errors.length, 1);
  assert.equal(out.findings.length, 1);
});

test('a dangling symlink with an unrelated extension is ignored', () => {
  const dir = fixtureDir({ 'ok.js': 'module.exports = 1;\n' });
  fs.symlinkSync('nope.txt', path.join(dir, 'notes.txt'));
  assert.equal(run([dir]).status, 0);
});

test('a missing target exits 2 and the others are still scanned', () => {
  const dir = fixtureDir({ 'ok.js': 'eval(x);\n' });
  const r = run(['/definitely/not/here', dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bughunter: \/definitely\/not\/here: no such file or directory/);
  assert.match(r.stdout, /no-eval/);
});

test('special files given as targets are skipped with a warning', () => {
  const r = run(['/dev/null']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\/dev\/null: skipped \(not a regular file/);
});

test('an unreadable directory is reported and does not stop the scan', { skip: process.getuid && process.getuid() === 0 && 'root ignores permissions' }, () => {
  const dir = fixtureDir({ 'ok.js': 'eval(x);\n', 'locked/a.js': 'eval(y);\n', 'secret.js': 'eval(z);\n' });
  fs.chmodSync(path.join(dir, 'locked'), 0);
  fs.chmodSync(path.join(dir, 'secret.js'), 0);
  try {
    const r = run([dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /locked: permission denied \(EACCES\)/);
    assert.match(r.stderr, /secret\.js: permission denied \(EACCES\)/);
    assert.match(r.stdout, /ok\.js/);
  } finally {
    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  }
});

test('a file that crashes the analyzer is an error for that file only', () => {
  // Deeply nested templates overflow a recursive masker; either way other files must be scanned.
  const depth = 12000;
  const dir = fixtureDir({
    'a.js': `const x = ${'`${'.repeat(depth)}1${'}`'.repeat(depth)};\n`,
    'b.js': 'eval(x);\n',
  });
  const r = run([dir]);
  assert.ok([1, 2].includes(r.status), `exit ${r.status}`);
  assert.match(r.stdout, /b\.js/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('exit code 2 for an IO error beats exit code 1 for findings', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\n' });
  assert.equal(run([dir]).status, 1);
  assert.equal(run([dir, '/definitely/not/here']).status, 2);
});

test('symlinked files and directories are followed', () => {
  const dir = fixtureDir({ 'real/lib.js': 'eval(x);\n', 'other/ok.js': 'module.exports = 1;\n' });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'other', 'linked-dir'));
  fs.symlinkSync(path.join(dir, 'real', 'lib.js'), path.join(dir, 'other', 'linked-file.js'));
  const r = run(['--format', 'json', path.join(dir, 'other')]);
  const out = JSON.parse(r.stdout);
  // linked-dir/lib.js and linked-file.js are the same physical file, counted once
  assert.equal(out.findings.length, 1);
  assert.equal(out.filesScanned, 2);
  assert.equal(r.stderr, '');
});

test('symlink loops terminate', () => {
  const dir = fixtureDir({ 'a/x.js': 'eval(x);\n' });
  fs.symlinkSync('..', path.join(dir, 'a', 'up'));
  fs.symlinkSync('.', path.join(dir, 'a', 'self'));
  const r = run(['--format', 'json', dir]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.filesScanned, 1);
  assert.equal(out.findings.length, 1);
  assert.equal(out.errors.length, 0);
});

test('duplicate and overlapping arguments count each file once', () => {
  const dir = fixtureDir({ 'real/r.js': 'eval(1);\n' });
  const file = path.join(dir, 'real', 'r.js');
  for (const args of [[path.join(dir, 'real'), path.join(dir, 'real'), file], [dir, path.join(dir, 'real')], [file, file]]) {
    const out = JSON.parse(run(['--format', 'json', ...args]).stdout);
    assert.equal(out.filesScanned, 1, args.join(' '));
    assert.equal(out.findings.length, 1, args.join(' '));
  }
  assert.match(run([file, file]).stdout, /1 finding \(1 high\) in 1 file/);
});

test('extensions are matched case-insensitively and .mts/.cts are scanned', () => {
  const dir = fixtureDir({ 'A.JS': 'eval(1);\n', 'b.MTS': 'eval(2);\n', 'c.cts': 'eval(3);\n' });
  assert.equal(JSON.parse(run(['--format', 'json', dir]).stdout).filesScanned, 3);
});

test('--min-severity filters output but not the exit code', () => {
  const dir = fixtureDir({ 'low.js': 'var n = parseInt(x);\n', 'med.js': 'debugger;\n' });
  const low = path.join(dir, 'low.js');
  const med = path.join(dir, 'med.js');
  let r = run(['--min-severity', 'high', '--fail-on', 'low', low]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^0 findings in 1 file \(1 more below --min-severity not shown, including some at or above --fail-on\)/m);
  r = run(['--min-severity', 'high', med]);
  assert.equal(r.status, 1); // default --fail-on is medium
  assert.match(r.stdout, /1 more below --min-severity not shown/);
  r = run(['--min-severity', 'high', '--format', 'json', med]);
  assert.equal(JSON.parse(r.stdout).hidden, 1);
  // hidden findings below --fail-on still pass, and the note does not claim otherwise
  r = run(['--min-severity', 'high', low]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 more below --min-severity not shown\)/);
  assert.doesNotMatch(r.stdout, /including some/);
});

test('minified and bundled files are skipped unless --include-minified', () => {
  const dir = fixtureDir({
    'app.min.js': 'eval(x);\n',
    'bundle.js': `var a=1;${'a=1;'.repeat(2000)}eval(x);\n`, // one 8000-character line
    'ok.js': 'module.exports = 1;\n',
  });
  let r = run(['--format', 'json', dir]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.filesScanned, 1);
  assert.deepEqual(out.skipped.map((s) => [path.basename(s.file), s.reason]).sort(), [
    ['app.min.js', 'minified'],
    ['bundle.js', 'minified'],
  ]);
  assert.match(r.stderr, /^bughunter: skipped 2 minified\/bundled file\(s\): .*app\.min\.js.*bundle\.js.* \(use --include-minified to scan them\)$/m);
  assert.match(run([dir]).stdout, /in 1 file, 2 skipped/);
  r = run(['--include-minified', '--format', 'json', dir]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).filesScanned, 3);
  assert.equal(r.stderr, '');
});

test('a line of exactly 5000 characters is not minified', () => {
  const dir = fixtureDir({ 'a.js': `${' '.repeat(4990)}eval(x);\n` });
  assert.equal(JSON.parse(run(['--format', 'json', dir]).stdout).filesScanned, 1);
});

test('binary files are skipped with a reason', () => {
  const dir = fixtureDir({ 'bin.js': 'eval(x);\0\0\n', 'ok.js': 'module.exports = 1;\n' });
  const r = run(['--format', 'json', dir]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.filesScanned, 1);
  assert.equal(out.skipped[0].reason, 'binary');
  assert.match(r.stderr, /bin\.js: skipped \(binary file\)/);
});

test('files over 1 MB are skipped as too-large', () => {
  const dir = fixtureDir({ 'big.js': `${'// x\n'.repeat(250000)}eval(1);\n` });
  const r = run(['--format', 'json', dir]);
  assert.equal(JSON.parse(r.stdout).skipped[0].reason, 'too-large');
  assert.match(r.stderr, /big\.js: skipped \(over 1 MB\)/);
});

test('--help documents the exit codes and new options', () => {
  const out = run(['--help']).stdout;
  for (const word of ['sarif', '--include-minified', '--config', 'Exit codes', 'precedence']) assert.ok(out.includes(word), word);
});
