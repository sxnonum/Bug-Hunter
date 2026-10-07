'use strict';

const { mask } = require('./mask');
const { rules: allRules } = require('./rules');

const SEVERITIES = ['info', 'low', 'medium', 'high'];
const DIRECTIVE = /bughunter-disable-(next-line|line)\b([^\n]*)/;

function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

// Maps line number -> Set of rule ids ('*' = all) disabled by inline comments:
//   foo(); // bughunter-disable-line no-eval
//   // bughunter-disable-next-line loose-equality, parseint-radix
function parseDirectives(rawLines) {
  const known = new Set(allRules.map((r) => r.id));
  const disabled = new Map();
  const add = (line, ids) => {
    if (!disabled.has(line)) disabled.set(line, new Set());
    for (const id of ids) disabled.get(line).add(id);
  };
  rawLines.forEach((text, idx) => {
    const m = DIRECTIVE.exec(text);
    if (!m) return;
    const named = (m[2].match(/[a-z][\w-]*/g) || []).filter((id) => known.has(id));
    const ids = named.length ? named : ['*'];
    add(m[1] === 'line' ? idx + 1 : idx + 2, ids);
  });
  return disabled;
}

function analyzeSource(text, { file = '<input>', disabledRules = [] } = {}) {
  const { withStrings, code } = mask(text);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);

  const posOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };

  const split = (s) => s.split(/\r?\n/);
  const rawLines = split(text);
  const ctx = {
    file,
    raw: text,
    rawLines,
    strLines: split(withStrings),
    code,
    codeLines: split(code),
    posOf,
  };

  const inlineDisabled = parseDirectives(rawLines);
  const skip = new Set(disabledRules);
  const findings = [];

  for (const rule of allRules) {
    if (skip.has(rule.id)) continue;
    for (const f of rule.check(ctx)) {
      const off = inlineDisabled.get(f.line);
      if (off && (off.has('*') || off.has(rule.id))) continue;
      findings.push({ rule: rule.id, severity: rule.severity, file, ...f });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return findings;
}

module.exports = { analyzeSource, severityRank, SEVERITIES };
