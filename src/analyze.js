'use strict';

const { mask } = require('./mask');
const { rules: allRules } = require('./rules');

const SEVERITIES = ['info', 'low', 'medium', 'high'];
const DIRECTIVE = /bughunter-disable-(next-line|line)\b([^\n]*)/;
const LINE_BREAK = /\r\n?|\n/;

function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

// Reads inline suppressions from comments (a directive inside a string literal is ignored):
//   foo(); // bughunter-disable-line no-eval
//   // bughunter-disable-next-line loose-equality, parseint-radix -- reason goes after "--"
// Returns { disabled: Map(line -> Set of rule ids, '*' = all), invalid: findings for unknown ids }.
// An unknown id never widens to "all rules": a typo must not hide more than intended.
function parseDirectives(rawLines, strLines, file) {
  const known = new Set(allRules.map((r) => r.id));
  const disabled = new Map();
  const invalid = [];
  const add = (line, ids) => {
    if (!disabled.has(line)) disabled.set(line, new Set());
    for (const id of ids) disabled.get(line).add(id);
  };
  rawLines.forEach((text, idx) => {
    const m = DIRECTIVE.exec(text);
    if (!m || !strLines[idx] || strLines[idx][m.index] !== ' ') return; // not inside a comment
    const listed = m[2].split(/--|\*\//)[0].split(/[\s,]+/).filter(Boolean);
    const unknown = listed.filter((id) => !known.has(id));
    const ids = listed.filter((id) => known.has(id));
    for (const id of unknown) {
      invalid.push({
        rule: 'invalid-directive',
        severity: 'low',
        file,
        line: idx + 1,
        column: m.index + 1,
        message: `Unknown rule "${id}" in bughunter-disable comment (see --list-rules; put a reason after "--")`,
      });
    }
    if (listed.length === 0) ids.push('*');
    add(m[1] === 'line' ? idx + 1 : idx + 2, ids);
  });
  return { disabled, invalid };
}

// TypeScript-only files cannot contain JSX, and `<T>expr` casts there look like JSX.
function allowsJsx(file) {
  return !/\.(?:d\.)?[cm]?ts$/i.test(file);
}

// `relFile` is the path relative to the scan root (the scanner supplies it); rules that exempt
// test code look at it so a checkout that lives under /home/me/test/ is not mistaken for tests.
function analyzeSource(text, { file = '<input>', relFile = file, disabledRules = [] } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const { withStrings, code } = mask(text, { jsx: allowsJsx(file) });

  const lineStarts = [0];
  const breaks = new RegExp(LINE_BREAK.source, 'g');
  let b;
  while ((b = breaks.exec(code)) !== null) lineStarts.push(b.index + b[0].length);

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

  const split = (s) => s.split(LINE_BREAK);
  const rawLines = split(text);
  const ctx = {
    file,
    relFile,
    raw: text,
    rawLines,
    str: withStrings,
    strLines: split(withStrings),
    code,
    codeLines: split(code),
    posOf,
  };

  const { disabled: inlineDisabled, invalid } = parseDirectives(rawLines, ctx.strLines, file);
  const skip = new Set(disabledRules);
  const findings = skip.has('invalid-directive') ? [] : invalid;

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
