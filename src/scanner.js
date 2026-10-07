'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./analyze');

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
const MAX_FILE_BYTES = 1024 * 1024;

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(path.join(target, entry.name));
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield path.join(target, entry.name);
    }
  }
}

function scanPaths(targets, { disabledRules = [] } = {}) {
  const findings = [];
  const skipped = [];
  let filesScanned = 0;
  for (const target of targets) {
    for (const file of walk(target)) {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        skipped.push(file);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      findings.push(...analyzeSource(text, { file, disabledRules }));
      filesScanned++;
    }
  }
  return { findings, filesScanned, skipped };
}

module.exports = { scanPaths };
