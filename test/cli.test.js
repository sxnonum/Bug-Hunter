'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'bughunter.js');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('clean project exits 0', () => {
  const dir = fixtureDir({ 'a.js': 'module.exports = 1;\n' });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 findings in 1 file/);
});

test('findings at or above --fail-on exit 1 and are reported with locations', () => {
  const dir = fixtureDir({ 'a.js': 'ok();\neval(x);\n' });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2:1\s+high\s+no-eval/);
});

test('--fail-on and --min-severity control exit code and output', () => {
  const dir = fixtureDir({ 'a.js': 'if (a == b) {}\n' }); // low severity
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--fail-on', 'low').status, 1);
  assert.match(run(dir).stdout, /loose-equality/);
  assert.match(run(dir, '--min-severity', 'medium').stdout, /0 findings/);
});

test('--format json is machine readable', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\n' });
  const out = JSON.parse(run(dir, '--format', 'json').stdout);
  assert.equal(out.filesScanned, 1);
  assert.equal(out.findings[0].rule, 'no-eval');
});

test('--disable skips rules', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\n' });
  assert.equal(run(dir, '--disable', 'no-eval').status, 0);
});

test('node_modules and non-JS files are ignored', () => {
  const dir = fixtureDir({
    'node_modules/dep/index.js': 'eval(x);\n',
    'notes.txt': 'eval(x);\n',
    'src/ok.ts': 'export const a = 1;\n',
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /in 1 file/);
});

test('usage errors exit 2', () => {
  assert.equal(run('--format', 'xml').status, 2);
  assert.equal(run('--disable', 'nope').status, 2);
  assert.equal(run('--fail-on', 'bad').status, 2);
  assert.equal(run('/definitely/not/here').status, 2);
});

test('--list-rules and --help exit 0', () => {
  assert.match(run('--list-rules').stdout, /no-eval/);
  assert.match(run('--help').stdout, /Usage: bughunter/);
});
