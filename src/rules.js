'use strict';

// Each rule has { id, severity, description, check(ctx) } where check returns
// [{ line, column, message }] (1-based). `ctx` carries several views of the file:
//   raw / rawLines       original text
//   strLines             comments blanked, string contents kept
//   code / codeLines     comments, strings and regex bodies blanked
//   posOf(offset)        offset in `code` -> { line, column }

function matchLines(lines, re, message) {
  const out = [];
  lines.forEach((text, idx) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text)) !== null) {
      const msg = typeof message === 'function' ? message(m, text, idx) : message;
      if (msg) out.push({ line: idx + 1, column: m.index + 1, message: msg });
      if (m[0] === '') g.lastIndex++;
    }
  });
  return out;
}

const SECRET_PATTERNS = [
  { kind: 'AWS access key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];
const SECRET_ASSIGNMENT =
  /[\w$]*(?:password|passwd|secret|api[_-]?key|token|private[_-]?key)[\w$]*['"]?\s*[:=]\s*(['"`])([^'"`\n]{8,})\1/i;
const PLACEHOLDER_VALUE = /^(?:x+|\*+|<.*>|\$\{.*\}|your[_\- ].*|example.*|changeme|placeholder.*|redacted)$/i;

const rules = [
  {
    id: 'no-eval',
    severity: 'high',
    description: 'eval() and new Function() execute arbitrary strings as code',
    check: ({ codeLines }) => [
      ...matchLines(codeLines, /(?<![.\w$])eval\s*\(/, 'eval() runs arbitrary code; avoid it'),
      ...matchLines(codeLines, /\bnew\s+Function\s*\(/, 'new Function() is eval in disguise; avoid it'),
    ],
  },
  {
    id: 'no-debugger',
    severity: 'medium',
    description: 'debugger statements left in code',
    check: ({ codeLines }) =>
      matchLines(codeLines, /\bdebugger\b/, 'Leftover debugger statement'),
  },
  {
    id: 'loose-equality',
    severity: 'low',
    description: '== and != coerce types; prefer === and !==',
    check: ({ codeLines }) =>
      matchLines(codeLines, /(?<![=!<>])(==|!=)(?!=)/, (m, text) => {
        const before = text.slice(0, m.index);
        const after = text.slice(m.index + 2);
        if (/^\s*null\b/.test(after) || /\bnull\s*$/.test(before)) return null; // `x == null` idiom
        return `Use ${m[1]}= instead of ${m[1]} to avoid type coercion`;
      }),
  },
  {
    id: 'nan-comparison',
    severity: 'high',
    description: 'Comparing against NaN is always false (or always true for !=)',
    check: ({ codeLines }) =>
      matchLines(
        codeLines,
        /[=!]==?\s*NaN\b|\bNaN\s*[=!]==?/,
        'Nothing equals NaN; use Number.isNaN(value)'
      ),
  },
  {
    id: 'assignment-in-condition',
    severity: 'medium',
    description: 'Assignment where a comparison was probably intended',
    check: ({ codeLines }) =>
      matchLines(
        codeLines,
        /\b(?:if|while)\s*\(\s*[\w$.[\]]+\s*=(?![=>])/,
        'Assignment inside a condition; did you mean ===? (wrap in extra parentheses if intended)'
      ),
  },
  {
    id: 'empty-catch',
    severity: 'medium',
    description: 'Errors are caught and silently discarded',
    check: ({ code, raw, posOf }) => {
      const out = [];
      const patterns = [
        [/\bcatch\s*(?:\(\s*[\w$]*\s*\))?\s*\{\s*\}/g, 'Empty catch block swallows errors'],
        [/\.catch\s*\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)?\s*=>\s*\{\s*\}\s*\)/g, 'Empty .catch() handler swallows errors'],
      ];
      for (const [re, message] of patterns) {
        let m;
        while ((m = re.exec(code)) !== null) {
          // A comment inside the block means the author meant to ignore the error.
          if (/\/\/|\/\*/.test(raw.slice(m.index, m.index + m[0].length))) continue;
          out.push({ ...posOf(m.index), message });
        }
      }
      return out;
    },
  },
  {
    id: 'foreach-async',
    severity: 'high',
    description: 'forEach does not await async callbacks',
    check: ({ codeLines }) =>
      matchLines(
        codeLines,
        /\.forEach\s*\(\s*async\b/,
        'forEach ignores the promises returned by an async callback; use for...of or Promise.all(map())'
      ),
  },
  {
    id: 'hardcoded-secret',
    severity: 'high',
    description: 'Credentials committed in source code',
    check: ({ strLines }) => {
      const out = [];
      for (const { kind, re } of SECRET_PATTERNS) {
        out.push(...matchLines(strLines, re, `Possible hardcoded secret (${kind})`));
      }
      out.push(
        ...matchLines(strLines, SECRET_ASSIGNMENT, (m) => {
          const value = m[2];
          if (/\s/.test(value) || PLACEHOLDER_VALUE.test(value)) return null;
          return 'Possible hardcoded credential; load it from the environment or a secret store';
        })
      );
      return out;
    },
  },
  {
    id: 'command-injection',
    severity: 'high',
    description: 'Shell command built from interpolated or concatenated strings',
    check: ({ strLines }) =>
      matchLines(
        strLines,
        /(?<![.\w$])(?:(?:child_process|cp)\.)?exec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|(?:'[^']*'|"[^"]*")\s*\+)/,
        'Shell command built from dynamic input; use execFile/spawn with an argument array'
      ),
  },
  {
    id: 'unreachable-code',
    severity: 'medium',
    description: 'Statements after return/throw/break/continue never run',
    check: ({ codeLines }) => {
      const out = [];
      const terminator = /^(\s*)(?:return\b.*|throw\b.*|break|continue)(?:\s+[\w$]+)?;\s*$/;
      const balanced = (s) => {
        for (const [open, close] of ['()', '[]', '{}']) {
          if (s.split(open).length !== s.split(close).length) return false;
        }
        return true;
      };
      for (let i = 0; i < codeLines.length; i++) {
        const m = terminator.exec(codeLines[i]);
        if (!m || !balanced(codeLines[i])) continue;
        let j = i + 1;
        while (j < codeLines.length && codeLines[j].trim() === '') j++;
        if (j >= codeLines.length) continue;
        const next = codeLines[j];
        const trimmed = next.trim();
        if (next.length - next.trimStart().length !== m[1].length) continue;
        if (/^(?:[}\])]|case\b|default\b|else\b|catch\b|finally\b|function\b)/.test(trimmed)) continue;
        out.push({ line: j + 1, column: m[1].length + 1, message: `Unreachable code after statement on line ${i + 1}` });
      }
      return out;
    },
  },
  {
    id: 'parseint-radix',
    severity: 'low',
    description: 'parseInt called without a radix',
    check: ({ codeLines }) =>
      matchLines(
        codeLines,
        /\bparseInt\s*\(\s*(?:[^(),]|\([^()]*\))+\)/,
        'parseInt without a radix; pass 10 (or use Number())'
      ),
  },
  {
    id: 'insecure-random',
    severity: 'medium',
    description: 'Math.random() used for security-sensitive values',
    check: ({ strLines }) =>
      matchLines(
        strLines,
        /\b(?:token|secret|password|passwd|session|nonce|salt|api_?key|csrf|otp)\w*\s*[:=][^;\n]*Math\.random\s*\(/i,
        'Math.random() is predictable; use crypto.randomBytes() or crypto.randomUUID()'
      ),
  },
  {
    id: 'tls-verification-disabled',
    severity: 'high',
    description: 'TLS certificate verification turned off',
    check: ({ strLines }) => [
      ...matchLines(strLines, /rejectUnauthorized\s*:\s*false/, 'TLS certificate verification is disabled'),
      ...matchLines(strLines, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, 'TLS certificate verification is disabled globally'),
    ],
  },
  {
    id: 'dom-xss',
    severity: 'medium',
    description: 'Assigning HTML strings to the DOM',
    check: ({ codeLines }) => [
      ...matchLines(codeLines, /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/, 'Assigning to innerHTML/outerHTML can enable XSS; prefer textContent'),
      ...matchLines(codeLines, /\bdocument\.write(?:ln)?\s*\(/, 'document.write can enable XSS; avoid it'),
    ],
  },
  {
    id: 'todo-marker',
    severity: 'info',
    description: 'TODO/FIXME/HACK/XXX comments',
    check: ({ rawLines, strLines }) =>
      matchLines(rawLines, /(?:\/\/|\/\*|^\s*\*)\s*(TODO|FIXME|HACK|XXX)\b/, (m, text, idx) => {
        // Only count it if the marker really sits in a comment, not inside a string.
        const pos = text.indexOf(m[1], m.index);
        return strLines[idx] && strLines[idx][pos] === ' ' ? `${m[1]} comment` : null;
      }),
  },
];

module.exports = { rules };
