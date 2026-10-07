#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { scanPaths } = require('../src/scanner');
const { severityRank, SEVERITIES } = require('../src/analyze');
const { rules } = require('../src/rules');
const { formatText, formatJson, formatSarif } = require('../src/report');

const FORMATS = ['text', 'json', 'sarif'];
const DEFAULT_CONFIG = '.bughunterrc.json';
const CONFIG_KEYS = ['disable', 'minSeverity', 'failOn', 'exclude'];

const USAGE = `Usage: bughunter [options] [path...]

Scans JavaScript/TypeScript files for common bugs and risky patterns.
Defaults to the current directory.

Options:
  --format <${FORMATS.join('|')}>  Output format (default: text)
  --min-severity <level>   Hide findings below: ${SEVERITIES.join(' | ')} (default: info)
  --fail-on <level>        Exit 1 if any finding is at or above this level (default: medium)
                           Counts every finding, including ones hidden by --min-severity
  --disable <rules>        Comma-separated rule ids to skip
  --include-minified       Also scan minified/bundled files (skipped by default)
  --config <path>          Read options from a JSON file (default: ./${DEFAULT_CONFIG} if present)
  --list-rules             Print all rules and exit
  -h, --help               Show this help

Config file keys: disable (rule ids), minSeverity, failOn, exclude (globs such as
"fixtures" or "**/*.generated.js", relative to each scanned directory). Flags override it.

Exit codes:
  0  no findings at or above --fail-on
  1  findings at or above --fail-on
  2  usage error, or a file/directory could not be scanned (takes precedence over 1)

Suppress a finding inline with:
  // bughunter-disable-line [rule]
  // bughunter-disable-next-line [rule]`;

class ConfigError extends Error {}

function fail(message, { usage = true } = {}) {
  console.error(`bughunter: ${message}${usage ? `\n\n${USAGE}` : ''}`);
  process.exit(2);
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        format: { type: 'string' },
        'min-severity': { type: 'string' },
        'fail-on': { type: 'string' },
        disable: { type: 'string' },
        config: { type: 'string' },
        'include-minified': { type: 'boolean', default: false },
        'list-rules': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    return fail(err.message);
  }
}

function checkRuleIds(ids, where) {
  const known = new Set(rules.map((r) => r.id));
  for (const id of ids) if (!known.has(id)) throw new ConfigError(`${where}: unknown rule "${id}" (see --list-rules)`);
}

function checkSeverity(value, where) {
  if (!SEVERITIES.includes(value)) throw new ConfigError(`${where} must be one of: ${SEVERITIES.join(', ')}`);
}

function loadConfig(file, required) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !required) return {};
    throw new ConfigError(`cannot read config ${file}: ${err.code || err.message}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${file}: ${err.message}`);
  }
  const where = `${file}: `;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(`${where}expected a JSON object`);
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) throw new ConfigError(`${where}unknown key "${key}" (expected ${CONFIG_KEYS.join(', ')})`);
  }
  for (const key of ['disable', 'exclude']) {
    const v = config[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === 'string' && s))) {
      throw new ConfigError(`${where}"${key}" must be an array of non-empty strings`);
    }
  }
  if (config.disable) checkRuleIds(config.disable, `${where}"disable"`);
  if (config.minSeverity !== undefined) checkSeverity(config.minSeverity, `${where}"minSeverity"`);
  if (config.failOn !== undefined) checkSeverity(config.failOn, `${where}"failOn"`);
  return config;
}

// Returns the exit code. Output goes through process.stdout.write and the process is left to
// end on its own: calling process.exit() here would cut off a large report on a pipe.
function main() {
  const { values, positionals } = parseCliArgs();

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values['list-rules']) {
    for (const r of rules) console.log(`${r.id.padEnd(28)}${r.severity.padEnd(8)}${r.description}`);
    return 0;
  }

  let config;
  try {
    config = loadConfig(values.config || DEFAULT_CONFIG, Boolean(values.config));
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, { usage: false });
    throw err;
  }

  const format = values.format ?? 'text';
  const minSeverity = values['min-severity'] ?? config.minSeverity ?? 'info';
  const failOn = values['fail-on'] ?? config.failOn ?? 'medium';
  if (!FORMATS.includes(format)) fail(`unknown format "${format}"`);
  for (const [opt, value] of [['min-severity', minSeverity], ['fail-on', failOn]]) {
    if (!SEVERITIES.includes(value)) fail(`--${opt} must be one of: ${SEVERITIES.join(', ')}`);
  }
  const disabledRules =
    values.disable === undefined ? config.disable || [] : values.disable.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    checkRuleIds(disabledRules, '--disable');
  } catch (err) {
    return fail(err.message);
  }

  const result = scanPaths(positionals.length ? positionals : ['.'], {
    disabledRules,
    includeMinified: values['include-minified'],
    exclude: config.exclude || [],
  });

  // --min-severity only filters what is printed; the exit code looks at every finding.
  const minRank = severityRank(minSeverity);
  const failRank = severityRank(failOn);
  const shown = result.findings.filter((f) => severityRank(f.severity) >= minRank);
  const hidden = result.findings.length - shown.length;
  const hiddenFailing = result.findings.some((f) => severityRank(f.severity) < minRank && severityRank(f.severity) >= failRank);

  let output;
  if (format === 'json') output = formatJson(shown, result, { hidden });
  else if (format === 'sarif') output = formatSarif(shown, result);
  else {
    output = formatText(shown, result, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, hidden, hiddenFailing });
  }
  process.stdout.write(`${output}\n`);

  for (const e of result.errors) console.error(`bughunter: ${e.file}: ${e.message}`);
  const reasons = {
    'too-large': 'over 1 MB',
    binary: 'binary file',
    'not-a-regular-file': 'not a regular file or directory',
  };
  let minified = 0;
  for (const s of result.skipped) {
    if (s.reason === 'minified') minified++;
    else console.error(`bughunter: ${s.file}: skipped (${reasons[s.reason] || s.reason})`);
  }
  if (minified) {
    console.error(`bughunter: skipped ${minified} minified/bundled file(s) (use --include-minified to scan them)`);
  }

  if (result.errors.length) return 2;
  return result.findings.some((f) => severityRank(f.severity) >= failRank) ? 1 : 0;
}

// A reader that closes early (`| head -1`) is not an error worth reporting.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err;
});

try {
  process.exitCode = main();
} catch (err) {
  console.error(`bughunter: internal error: ${(err && err.stack) || err}`);
  process.exitCode = 2;
}
