'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run, fixtureDir } = require('./cli-helpers');
const { rules } = require('../src/rules');

const LEVELS = new Set(['error', 'warning', 'note']);

test('--format sarif emits a valid SARIF 2.1.0 structure', () => {
  const dir = fixtureDir({
    'src/a.js': 'ok();\neval(x);\n', // high
    'src/b.js': 'if (a) {\n  debugger;\n}\n', // medium
    'src/c.js': 'var n = parseInt(x);\n', // low
    'my dir/d.js': '  // TODO: later\n', // info, and a space in the path
  });
  const r = run(['--format', 'sarif', 'src', 'my dir'], { cwd: dir });
  assert.equal(r.status, 1);
  const sarif = JSON.parse(r.stdout);
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  assert.equal(sarif.runs.length, 1);

  const [run0] = sarif.runs;
  assert.equal(run0.tool.driver.name, 'bughunter');
  assert.equal(run0.tool.driver.rules.length, rules.length);
  const expectedLevel = { high: 'error', medium: 'warning', low: 'note', info: 'note' };
  for (const [i, rule] of run0.tool.driver.rules.entries()) {
    assert.equal(rule.id, rules[i].id);
    assert.equal(typeof rule.shortDescription.text, 'string');
    assert.equal(rule.defaultConfiguration.level, expectedLevel[rules[i].severity]);
  }

  const byRule = Object.fromEntries(run0.results.map((x) => [x.ruleId, x]));
  assert.equal(byRule['no-eval'].level, 'error');
  assert.equal(byRule['no-debugger'].level, 'warning');
  assert.equal(byRule['parseint-radix'].level, 'note');
  assert.equal(byRule['todo-marker'].level, 'note');

  for (const res of run0.results) {
    assert.ok(LEVELS.has(res.level));
    assert.equal(typeof res.message.text, 'string');
    assert.equal(run0.tool.driver.rules[res.ruleIndex].id, res.ruleId);
    assert.equal(res.locations.length, 1);
    const loc = res.locations[0].physicalLocation;
    assert.ok(!loc.artifactLocation.uri.includes('\\'));
    assert.ok(!path.isAbsolute(loc.artifactLocation.uri));
    assert.ok(Number.isInteger(loc.region.startLine) && loc.region.startLine >= 1);
    assert.ok(Number.isInteger(loc.region.startColumn) && loc.region.startColumn >= 1);
  }
  const ev = byRule['no-eval'].locations[0].physicalLocation;
  assert.equal(ev.artifactLocation.uri, 'src/a.js');
  assert.deepEqual(ev.region, { startLine: 2, startColumn: 1 });
  assert.equal(byRule['no-debugger'].locations[0].physicalLocation.region.startLine, 2);
  assert.equal(byRule['no-debugger'].locations[0].physicalLocation.region.startColumn, 3);
  assert.equal(byRule['todo-marker'].locations[0].physicalLocation.artifactLocation.uri, 'my%20dir/d.js');
  assert.equal(run0.invocations[0].executionSuccessful, true);
});

test('sarif reports tool errors as notifications and honours --min-severity', () => {
  const dir = fixtureDir({ 'a.js': 'eval(x);\ndebugger;\n' });
  const r = run(['--format', 'sarif', '--min-severity', 'high', '.', 'missing-dir'], { cwd: dir });
  assert.equal(r.status, 2);
  const [run0] = JSON.parse(r.stdout).runs;
  assert.deepEqual(run0.results.map((x) => x.ruleId), ['no-eval']);
  assert.equal(run0.invocations[0].executionSuccessful, false);
  assert.match(run0.invocations[0].toolExecutionNotifications[0].message.text, /missing-dir/);
});

test('sarif for a clean project has an empty results array', () => {
  const dir = fixtureDir({ 'a.js': 'module.exports = 1;\n' });
  const r = run(['--format', 'sarif', '.'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).runs[0].results, []);
});
