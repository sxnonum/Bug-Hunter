'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'bughunter.js');

// Runs the CLI with stdout and stderr as pipes. `cwd` matters for the config file lookup.
function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd });
}

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

module.exports = { BIN, run, fixtureDir };
