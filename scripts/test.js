'use strict';

// Runs every test/*.test.js with the node:test runner. Plain readdir instead of a shell glob, so
// it behaves the same on every platform and never picks up helpers (test/cli-helpers.js) or fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
  .map((e) => path.join(dir, e.name))
  .sort();

if (!files.length) {
  console.error('no test files found in test/');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (r.error) {
  console.error(`cannot run tests: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
