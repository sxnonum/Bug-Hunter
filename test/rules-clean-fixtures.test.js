'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanPaths } = require('../src/scanner');
const { severityRank } = require('../src/analyze');

const FIXTURES = path.join(__dirname, 'fixtures', 'clean');

// Idiomatic code that once triggered false positives (or could): it must stay clean at medium and up.
test('test/fixtures/clean has no findings at medium or higher', () => {
  // Scan a copy: fixture credentials are deliberately ignored under test/ paths, and the copy keeps
  // that shortcut from hiding a regression in the secret rule.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-clean-'));
  try {
    fs.cpSync(FIXTURES, dir, { recursive: true });
    const { findings, filesScanned } = scanPaths([dir]);
    assert.equal(filesScanned, fs.readdirSync(FIXTURES).length);
    const serious = findings.filter((f) => severityRank(f.severity) >= severityRank('medium'));
    assert.deepEqual(
      serious.map((f) => `${path.basename(f.file)}:${f.line} ${f.rule}`),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
