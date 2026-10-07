#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { scanPaths } = require('../src/scanner');
const { severityRank, SEVERITIES } = require('../src/analyze');
const { rules } = require('../src/rules');
const { formatText, formatJson } = require('../src/report');

const USAGE = `Usage: bughunter [options] [path...]

Scans JavaScript/TypeScript files for common bugs and risky patterns.
Defaults to the current directory.

Options:
  --format <text|json>     Output format (default: text)
  --min-severity <level>   Hide findings below: ${SEVERITIES.join(' | ')} (default: info)
  --fail-on <level>        Exit 1 if any finding is at or above this level (default: medium)
  --disable <rules>        Comma-separated rule ids to skip
  --list-rules             Print all rules and exit
  -h, --help               Show this help

Suppress a finding inline with:
  // bughunter-disable-line [rule]
  // bughunter-disable-next-line [rule]`;

function fail(message) {
  console.error(`bughunter: ${message}\n\n${USAGE}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: 'string', default: 'text' },
      'min-severity': { type: 'string', default: 'info' },
      'fail-on': { type: 'string', default: 'medium' },
      disable: { type: 'string', default: '' },
      'list-rules': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  fail(err.message);
}
const { values, positionals } = args;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values['list-rules']) {
  for (const r of rules) console.log(`${r.id.padEnd(28)}${r.severity.padEnd(8)}${r.description}`);
  process.exit(0);
}

if (!['text', 'json'].includes(values.format)) fail(`unknown format "${values.format}"`);
for (const opt of ['min-severity', 'fail-on']) {
  if (!SEVERITIES.includes(values[opt])) fail(`--${opt} must be one of: ${SEVERITIES.join(', ')}`);
}
const disabledRules = values.disable.split(',').map((s) => s.trim()).filter(Boolean);
const knownIds = new Set(rules.map((r) => r.id));
for (const id of disabledRules) if (!knownIds.has(id)) fail(`unknown rule "${id}" (see --list-rules)`);

let result;
try {
  result = scanPaths(positionals.length ? positionals : ['.'], { disabledRules });
} catch (err) {
  if (err.code === 'ENOENT') fail(`no such file or directory: ${err.path}`);
  throw err;
}

const minRank = severityRank(values['min-severity']);
const findings = result.findings.filter((f) => severityRank(f.severity) >= minRank);

const output =
  values.format === 'json'
    ? formatJson(findings, result)
    : formatText(findings, result, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR });
console.log(output);
for (const file of result.skipped) console.error(`bughunter: skipped ${file} (over 1 MB)`);

const failRank = severityRank(values['fail-on']);
process.exit(findings.some((f) => severityRank(f.severity) >= failRank) ? 1 : 0);
