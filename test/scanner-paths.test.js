'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtureDir } = require('./cli-helpers');

// scanPaths with analyzeSource replaced by a recorder, to see what the scanner hands the analyzer.
function scanRecording(targets, options) {
  const analyze = require('../src/analyze');
  const real = analyze.analyzeSource;
  const calls = [];
  analyze.analyzeSource = (text, opts) => {
    calls.push({ file: opts.file, relFile: opts.relFile, disabledRules: opts.disabledRules });
    return [];
  };
  const scannerPath = require.resolve('../src/scanner');
  delete require.cache[scannerPath];
  try {
    const { scanPaths } = require('../src/scanner');
    scanPaths(targets, options);
  } finally {
    analyze.analyzeSource = real;
    delete require.cache[scannerPath];
  }
  return calls;
}

test('relFile is relative to the scan root with forward slashes; explicit files get their basename', () => {
  const dir = fixtureDir({ 'src/a.js': 'a;\n', 'src/deep/b.ts': 'b;\n', 'c.js': 'c;\n' });
  const calls = scanRecording([dir], { disabledRules: ['no-eval'] });
  const rel = Object.fromEntries(calls.map((c) => [path.relative(dir, c.file), c.relFile]));
  assert.deepEqual(rel, { 'c.js': 'c.js', [path.join('src', 'a.js')]: 'src/a.js', [path.join('src', 'deep', 'b.ts')]: 'src/deep/b.ts' });
  assert.ok(calls.every((c) => c.disabledRules[0] === 'no-eval'));
  const explicit = scanRecording([path.join(dir, 'src', 'deep', 'b.ts')]);
  assert.deepEqual(explicit.map((c) => c.relFile), ['b.ts']);
});

test('relFile of a file reached through a symlink uses the path it was reached by', () => {
  const dir = fixtureDir({ 'real/x.js': 'x;\n' });
  fs.mkdirSync(path.join(dir, 'root'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'root', 'link'));
  const calls = scanRecording([path.join(dir, 'root')]);
  assert.deepEqual(calls.map((c) => c.relFile), ['link/x.js']);
});
