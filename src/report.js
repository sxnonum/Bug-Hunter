'use strict';

const path = require('node:path');
const { rules } = require('./rules');
const { version } = require('../package.json');

const SARIF_LEVEL = { high: 'error', medium: 'warning', low: 'note', info: 'note' };

// `hidden` = findings removed by --min-severity; `hiddenFailing` says whether any of them
// is at or above --fail-on (and so still decides the exit code).
function formatText(findings, { filesScanned, skipped = [] }, { color = false, hidden = 0, hiddenFailing = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const sevColor = { high: 31, medium: 33, low: 36, info: 90 };
  const lines = [];
  let current = null;
  for (const f of findings) {
    if (f.file !== current) {
      if (current !== null) lines.push('');
      lines.push(paint(4, path.relative(process.cwd(), f.file) || f.file));
      current = f.file;
    }
    const where = `${f.line}:${f.column}`.padEnd(8);
    lines.push(`  ${where}${paint(sevColor[f.severity], f.severity.padEnd(7))}${f.rule.padEnd(26)}${f.message}`);
  }
  if (findings.length) lines.push('');
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const breakdown = ['high', 'medium', 'low', 'info']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  lines.push(
    `${findings.length} finding${findings.length === 1 ? '' : 's'}` +
      (breakdown ? ` (${breakdown})` : '') +
      ` in ${filesScanned} file${filesScanned === 1 ? '' : 's'}` +
      (skipped.length ? `, ${skipped.length} skipped` : '') +
      (hidden ? ` (${hidden} more below --min-severity not shown${hiddenFailing ? ', including some at or above --fail-on' : ''})` : '')
  );
  return lines.join('\n');
}

function formatJson(findings, { filesScanned, skipped, errors = [] }, { hidden = 0 } = {}) {
  return JSON.stringify({ filesScanned, skipped, errors, hidden, findings }, null, 2);
}

// SARIF 2.1.0, as understood by GitHub code scanning and most CI viewers.
function formatSarif(findings, { errors = [] }) {
  const toUri = (file) => {
    const rel = path.relative(process.cwd(), path.resolve(file)) || file;
    return rel.split(path.sep).map(encodeURIComponent).join('/');
  };
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'bughunter',
            version,
            rules: rules.map((r) => ({
              id: r.id,
              shortDescription: { text: r.description },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: errors.length === 0,
            toolExecutionNotifications: errors.map((e) => ({
              level: 'error',
              message: { text: `${e.file}: ${e.message}` },
            })),
          },
        ],
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIndex.get(f.rule),
          level: SARIF_LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: toUri(f.file) },
                region: { startLine: f.line, startColumn: f.column },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

module.exports = { formatText, formatJson, formatSarif };
