'use strict';

const path = require('node:path');

function formatText(findings, { filesScanned }, { color = false } = {}) {
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
      ` in ${filesScanned} file${filesScanned === 1 ? '' : 's'}`
  );
  return lines.join('\n');
}

function formatJson(findings, { filesScanned, skipped }) {
  return JSON.stringify({ filesScanned, skipped, findings }, null, 2);
}

module.exports = { formatText, formatJson };
