'use strict';

const { isSecretName } = require('./names');

// Each rule has { id, severity, description, check(ctx) } where check returns
// [{ line, column, message }] (1-based). `ctx` carries several views of the file:
//   file                 path (used to skip .d.ts declaration files)
//   raw / rawLines       original text
//   str / strLines       comments blanked, string contents kept
//   code / codeLines     comments, strings and regex bodies blanked
//   posOf(offset)        offset in `code`/`str` -> { line, column }

function matchLines(lines, re, message) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  lines.forEach((text, idx) => {
    g.lastIndex = 0;
    let m;
    while ((m = g.exec(text)) !== null) {
      const msg = typeof message === 'function' ? message(m, text, idx) : message;
      if (msg) out.push({ line: idx + 1, column: m.index + 1, message: msg });
      if (m[0] === '') g.lastIndex++;
    }
  });
  return out;
}

// Same as matchLines but over the whole text, so a match may span lines.
function matchText(text, posOf, re, message) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    const msg = typeof message === 'function' ? message(m) : message;
    if (msg) out.push({ ...posOf(m.index), message: msg });
    if (m[0] === '') g.lastIndex++;
  }
  return out;
}

// Index of the bracket closing the one at `open`, or -1 (bounded so odd input stays linear).
function matchClose(text, open, limit = 4000) {
  let depth = 0;
  const end = Math.min(text.length, open + limit);
  for (let i = open; i < end; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

// Index of the last non-whitespace char at or before `i` (-1 if none).
function skipSpaceBack(text, i) {
  while (i >= 0 && /\s/.test(text[i])) i--;
  return i;
}

const isDeclarationFile = (file) => /\.d\.[cm]?ts$/i.test(file);

// True when the source between a and b holds a comment (raw differs from the comment-blanked view).
function hasComment(raw, str, a, b) {
  for (let i = a; i < b; i++) {
    if (raw[i] !== str[i] && !/\s/.test(raw[i])) return true;
  }
  return false;
}

// A line that holds only a comment (blank in the code view, not blank in the original).
function isCommentLine(codeLines, rawLines, idx) {
  return idx >= 0 && codeLines[idx].trim() === '' && rawLines[idx].trim() !== '';
}

const SECRET_PATTERNS = [
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
];
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
// `pem.startsWith('-----BEGIN PRIVATE KEY-----')` and the like only look for the header.
const HEADER_CHECK_BEFORE =
  /(?:\b(?:startsWith|endsWith|includes|indexOf|match|test|replace|search|split)\s*\(\s*|[=!]==?\s*|\bcase\s+)['"`]$/;
const PLACEHOLDER_BODY = /^(?:\\+[rn]|\s)*(?:x{3,}|\*{3,}|\.{3}|<)/i;
// scheme://user:password@host
const URL_CREDENTIALS = /:\/\/([^\s/:@'"`$<>{}()\\]*):([^\s/@'"`$<>{}()\\]{4,})@/g;
const PLACEHOLDER_PASSWORD = /^(?:pass(?:word)?|user(?:name)?|secret|root|admin|x+|\*+)$/i;

// Fixture credentials in test files are noise; the format-based patterns above still apply there.
const TEST_FILE = /(?:^|[\\/])(?:tests?|__tests__|__mocks__|fixtures?|spec)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const SECRET_KEYWORDS = /pass|secret|token|key|credential|nonce|salt|csrf|otp|session/i;
// name [: Type] (=|:) [process.env.X ||] 'value'; `name` may be quoted (JSON-style keys).
const SECRET_ASSIGNMENT =
  /(?<![\w$])(?:([A-Za-z_$][\w$]*)|(['"])([\w$-]+)\2)[?!]?(?:\s*:\s*[A-Za-z_$][\w$.<>[\]| ]{0,60}?)?\s*[:=](?!=)\s*(?:(?:process\.env(?:\.[\w$]+|\[[^\]\n]*\])|import\.meta\.env\.[\w$]+)\s*(?:\|\||\?\?)\s*)?(['"`])([^'"`\n]{8,})\4/g;
const PLACEHOLDER_VALUE =
  /^(?:x+|\*+|\.+|-+|<.*>|\{\{.*\}\}|\$\{.*\}|%\w+%|(?:your|my)[_\- ].*|example.*|change[_-]?me|placeholder.*|dummy.*|redacted|none|null|undefined|pass(?:word)?|secret|token|api[_-]?key)$/i;

// Values that are labels, identifiers, paths or URLs rather than a credential.
function looksLikeSecretValue(value) {
  if (/\s|\$\{|\[[^\]]*-[^\]]*\]/.test(value) || PLACEHOLDER_VALUE.test(value)) return false; // prose, templates, regex classes
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URLs are covered by the credentials-in-URL check
  if (/\d/.test(value)) return true;
  // No digits: enum labels (WHITESPACE), snake/kebab/dotted names, camelCase and Capitalized words.
  if (/^[A-Za-z_$.:/?-]+$/.test(value) && /[A-Z_$.:/?-]/.test(value)) return false;
  return true;
}

// Skip a candidate when the text before it shows it is the `?` branch of a ternary, a type or a declaration.
function isLabelContext(before) {
  const t = before.slice(-24).trimEnd();
  return t.endsWith('?') || /\b(?:type|interface|declare\s+(?:const|let|var))\s+$/.test(before.slice(-24));
}

function secretFindings({ str, strLines, codeLines, posOf, file }) {
  const out = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    out.push(...matchText(str, posOf, re, `Possible hardcoded secret (${kind})`));
  }

  out.push(
    ...matchText(str, posOf, PRIVATE_KEY_HEADER, (m) => {
      if (HEADER_CHECK_BEFORE.test(str.slice(Math.max(0, m.index - 40), m.index))) return null;
      if (PLACEHOLDER_BODY.test(str.slice(m.index + m[0].length, m.index + m[0].length + 24))) return null;
      return 'Possible hardcoded secret (private key)';
    })
  );

  if (str.includes('://')) {
    out.push(
      ...matchText(str, posOf, URL_CREDENTIALS, (m) => {
        if (PLACEHOLDER_VALUE.test(m[2]) || PLACEHOLDER_PASSWORD.test(m[2])) return null;
        // The URL must open a string (`'postgres://u:p@host'`), not sit inside prose.
        let start = m.index;
        while (start > 0 && m.index - start < 20 && /[a-z0-9+.-]/i.test(str[start - 1])) start--;
        return start < m.index && /['"`]/.test(str[start - 1] || '')
          ? 'Possible hardcoded secret (credentials embedded in a URL)'
          : null;
      })
    );
  }

  if (isDeclarationFile(file) || TEST_FILE.test(file)) return out; // `declare const token: "abc"` states a type
  const assignment = new RegExp(SECRET_ASSIGNMENT.source, 'g');
  strLines.forEach((text, idx) => {
    if (!SECRET_KEYWORDS.test(text)) return;
    assignment.lastIndex = 0;
    let m;
    while ((m = assignment.exec(text)) !== null) {
      if (codeLines[idx][m.index] !== text[m.index]) continue; // match starts inside a string
      if (!isSecretName(m[1] || m[3]) || isLabelContext(text.slice(0, m.index))) continue;
      if (!looksLikeSecretValue(m[5])) continue;
      out.push({
        line: idx + 1,
        column: m.index + 1,
        message: 'Possible hardcoded credential; load it from the environment or a secret store',
      });
    }
  });
  return out;
}

// ---- no-eval -------------------------------------------------------------------------------

const EVAL_CALL =
  /(?<![.\w$])eval\s*\(|(?<![.\w$])(?:window|globalThis|self|global)\s*\.\s*eval\s*\(|\(\s*0\s*,\s*eval\s*\)/g;
const FUNCTION_CONSTRUCTOR =
  /(?<![.\w$])(?:new\s+)?(?:(?:window|globalThis|self|global)\s*\.\s*)?Function\s*\(/g;
const MEMBER_MODIFIERS = /(?:^|[\s{};,*])(?:async|static|public|private|protected|readonly|abstract|override|get|set)$/;
// A string literal in the code view: quotes around blanked text.
const STRING_LITERAL = /"[ \t]*"|'[ \t]*'|`\s*`/g;

// `eval` introduced as a name (function eval, method eval(...) {, interface member), not called.
function isEvalDeclaration(code, index, openParen) {
  if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, index - 30), index))) return true;
  if (code[openParen] !== '(') return false;
  const close = matchClose(code, openParen);
  if (close < 0) return false;
  let next = close + 1;
  while (next < code.length && /\s/.test(code[next])) next++;
  if (code[next] === '{') return true;
  if (code[next] !== ':') return false;
  const prev = skipSpaceBack(code, index - 1);
  return prev < 0 || '{};'.includes(code[prev]) || MEMBER_MODIFIERS.test(code.slice(Math.max(0, prev - 12), prev + 1));
}

function evalFindings({ code, posOf }) {
  const out = [];
  let m;
  const evalRe = new RegExp(EVAL_CALL.source, 'g');
  while ((m = evalRe.exec(code)) !== null) {
    const bare = m[0].startsWith('eval');
    if (bare && isEvalDeclaration(code, m.index, m.index + m[0].length - 1)) continue;
    out.push({ ...posOf(m.index), message: 'eval() runs arbitrary code; avoid it' });
  }
  const fnRe = new RegExp(FUNCTION_CONSTRUCTOR.source, 'g');
  while ((m = fnRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    // `Function('return 1')`, with or without `new`, only ever runs the literal in front of you.
    if (close > 0 && code.slice(open + 1, close).replace(STRING_LITERAL, '').replace(/[\s,]/g, '') === '') continue;
    out.push({ ...posOf(m.index), message: 'Function() is eval in disguise; avoid it' });
  }
  return out;
}

// ---- command-injection ---------------------------------------------------------------------

const EXEC_CALLEE = new RegExp(
  [
    /(?<![.\w$])exec(?:Sync|Async|P|Promise)?\s*\(/.source,
    /(?<![\w$])(?:[cC]hild_?[pP]rocess|cp|proc|shell|sh)\s*\.\s*exec\w*\s*\(/.source,
    /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)\s*\.\s*exec\w*\s*\(/.source,
  ].join('|'),
  'g'
);

// Source of the first argument of the call whose '(' is at `open`, plus whether it has a top-level '+'.
function firstArgument(code, open) {
  let depth = 0;
  let plus = false;
  const end = Math.min(code.length, open + 2000);
  for (let i = open; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) return { text: code.slice(open + 1, i), plus };
    } else if (depth === 1) {
      if (ch === ',') return { text: code.slice(open + 1, i), plus };
      if (ch === '+') plus = true;
    }
  }
  return null;
}

function isDynamicCommand({ text, plus }) {
  const arg = text.trim();
  if (/^`[^`]*\$\{/.test(arg)) return true;
  const rest = arg.replace(STRING_LITERAL, '');
  if (!/[\w$]/.test(rest) || !STRING_LITERAL.test(arg)) return false;
  STRING_LITERAL.lastIndex = 0;
  return plus || /^(?:"[ \t]*"|'[ \t]*'|`\s*`)\s*\.\s*concat\s*\(/.test(arg);
}

// ---- unreachable-code ----------------------------------------------------------------------

const JUMP = /^(\s*)(return|throw|break|continue)(?![\w$])/;
const OPERATOR_END = /(?:(?<![+-])[+-]|[*/%&|^,?:=.<~]|=>|\b(?:in|of|instanceof|typeof|new|void|await|delete))$/;
const CONTINUATION_START = /^(?:[.?:+\-*/%&|,;{(\[`]|=>)/;
const NOT_DEAD_START =
  /^(?:[}\])]|case\b|default\b|else\b|catch\b|finally\b|(?:async\s+)?function\b|interface\b|declare\b|type\s+[\w$]+\s*[=<])/;
// A braceless `if (x)` / `else` / `for (...)` / `do` line: the jump below it is its body.
const BRACELESS_HEADER = /^(?:\}\s*)?(?:(?:else\s+if|if|for|while|with)\b.*\)|else|do)\s*$/;

// The block kinds at the start of each line: 'type' inside interface/class/enum/type-alias bodies.
function blockKinds(codeLines) {
  const kinds = [];
  const stack = [];
  let header = '';
  for (const text of codeLines) {
    kinds.push(stack.length ? stack[stack.length - 1] : 'other');
    for (const ch of text) {
      if (ch === '{') {
        stack.push(/\b(?:interface|class|enum)\b|\btype\s+[\w$]+[^=]*=\s*$/.test(header) ? 'type' : 'other');
        header = '';
      } else if (ch === '}') {
        stack.pop();
        header = '';
      } else if (ch === ';') header = '';
      else header = (header + ch).slice(-200);
    }
    header = (header + ' ').slice(-200);
  }
  return kinds;
}

// Where the statement starting at (start, col) ends: { line, semi }, or null when unclear.
function statementEnd(codeLines, start, col) {
  let depth = 0;
  let inTemplate = false; // a template literal open at the end of a line continues the statement
  const last = Math.min(codeLines.length, start + 40);
  for (let i = start; i < last; i++) {
    const text = codeLines[i];
    if (i > start && text.trim() === '') continue; // comment or blank line inside the statement
    for (let c = i === start ? col : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === '`') inTemplate = !inTemplate;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth < 0) return null;
      } else if (ch === ';' && depth === 0) {
        return text.slice(c + 1).trim() === '' ? { line: i, semi: true } : null;
      }
    }
    if (depth > 0 || inTemplate) continue;
    if (OPERATOR_END.test(text.trimEnd())) continue;
    let j = i + 1;
    while (j < codeLines.length && codeLines[j].trim() === '') j++;
    if (j < codeLines.length && CONTINUATION_START.test(codeLines[j].trim())) continue;
    return { line: i, semi: false };
  }
  return null;
}

// ---- insecure-random -----------------------------------------------------------------------

const RANDOM_CALL = /(?<![.\w$])Math\s*\.\s*random\s*\(/g;
const RANDOM_LOOKBACK = 200;
const LINE_JOINERS = '=+-*/%&|^?:(.[<>';
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return']);

const isWordChar = (c) => /[\w$]/.test(c);

// Start of the `a.b[i]` expression ending just before `end`.
function pathStart(code, end) {
  let i = end;
  while (i > 0) {
    const ch = code[i - 1];
    if (ch === ']') {
      const open = code.lastIndexOf('[', i - 1);
      if (open < 0 || i - open > 40) break;
      i = open;
    } else if (isWordChar(ch) || ch === '.') i--;
    else break;
  }
  return i;
}

// The assignment whose '=' is at `eq`: { name, offset, compound } when its target is a plain path.
function assignmentAt(code, eq) {
  const prev = code[eq - 1];
  if (code[eq + 1] === '=' || (prev && '=!<>'.includes(prev))) return null; // comparison
  const compound = Boolean(prev && '+-*/%&|^?'.includes(prev));
  let end = skipSpaceBack(code, compound ? eq - 2 : eq - 1) + 1;
  const annotation = /:\s*[\w$<>[\]|. ]*$/.exec(code.slice(Math.max(0, end - 60), end));
  if (annotation) end = skipSpaceBack(code, end - annotation[0].length - 1) + 1;
  if (code[end - 1] === '?' || code[end - 1] === '!') end--;
  const start = pathStart(code, end);
  if (start === end) return null;
  return { name: code.slice(start, end), offset: start, compound, eq };
}

// For `x = (a, b) => ...` returns the index of the '=' in front of the arrow parameters, else -1.
function arrowAssignment(code, arrow) {
  let j = skipSpaceBack(code, arrow - 1);
  if (code[j] === ')') {
    let depth = 0;
    for (; j >= 0 && j > arrow - 200; j--) {
      if (code[j] === ')') depth++;
      else if (code[j] === '(' && --depth === 0) break;
    }
    if (depth !== 0) return -1;
    j--;
  } else {
    while (j >= 0 && isWordChar(code[j])) j--;
  }
  j = skipSpaceBack(code, j);
  if (code.slice(j - 4, j + 1) === 'async') j = skipSpaceBack(code, j - 5);
  return code[j] === '=' ? j : -1;
}

// Name of the function whose body contains `index` (brace-wise), when it is easy to tell.
function enclosingFunctionName(code, index) {
  let depth = 0;
  let open = -1;
  for (let i = index; i >= 0 && i > index - 1500; i--) {
    if (code[i] === '}') depth++;
    else if (code[i] === '{' && depth-- === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const header = code.slice(Math.max(0, open - 200), open).trimEnd();
  const params = String.raw`\s*(?:<[^>(]*>)?\s*\([^()]*\)\s*(?::\s*[^{=]*)?$`;
  const m =
    new RegExp(String.raw`function\s*\*?\s*([\w$]+)` + params).exec(header) ||
    new RegExp(String.raw`([\w$]+)\s*[:=]\s*(?:async\s+)?function\b[^()]*` + params).exec(header) ||
    new RegExp(String.raw`(?:^|[\s,{};*])([\w$]+)` + params).exec(header) ||
    /([\w$]+)\s*[:=]\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*(?::[^=]*)?=>$/.exec(header);
  return m && !CONTROL_WORDS.has(m[1]) ? m[1] : null;
}

// The security-sensitive target a Math.random() call at `p` feeds, or null.
function randomTarget(code, p) {
  const floor = Math.max(0, p - RANDOM_LOOKBACK);
  let bracket = -1; // leftmost '[' between the assignment and the call
  for (let i = p - 1; i >= floor; i--) {
    const ch = code[i];
    if (ch === '[') bracket = i;
    else if (ch === '\n') {
      const before = code[skipSpaceBack(code, i - 1)];
      const after = /^\s*(.)/.exec(code.slice(i + 1, i + 40));
      if (!LINE_JOINERS.includes(before) && !(after && '.?:'.includes(after[1]))) return returnTarget(code, i, p);
    } else if (ch === ';' || ch === ',' || ch === '{' || ch === '}') return returnTarget(code, i, p);
    else if (ch === '>' && code[i - 1] === '=') {
      const eq = arrowAssignment(code, i - 1);
      if (eq < 0) return null;
      i = eq + 1; // continue as if the '=' of `name = (…) =>` had been met first
    } else if (ch === '=') {
      const target = assignmentAt(code, i);
      if (!target || !isSecretName(target.name)) return null;
      // `token = chars[Math.floor(Math.random() * n)]` picks from a pool; `token += …` builds a value.
      if (bracket >= 0 && !target.compound && /^\s*[\w$.]+\s*$/.test(code.slice(i + 1, bracket))) return null;
      return target;
    } else if (ch === ':') {
      let j = skipSpaceBack(code, i - 1);
      const end = j + 1;
      while (j >= 0 && isWordChar(code[j])) j--;
      const owner = code[skipSpaceBack(code, j)];
      if (end > j + 1 && (owner === '{' || owner === ',')) {
        const name = code.slice(j + 1, end);
        return isSecretName(name) ? { name, offset: j + 1 } : null;
      }
    }
  }
  return null;
}

// `return Math.random()…` inside a function named like a secret generator (generateToken, makeNonce).
function returnTarget(code, boundary, p) {
  const head = code.slice(boundary + 1, p);
  const ret = /^\s*return\s+/.exec(head);
  if (!ret) return null;
  if (/^[\w$.]+\s*\[/.test(head.slice(ret[0].length))) return null; // pool pick
  const name = enclosingFunctionName(code, boundary);
  return name && isSecretName(name) ? { name, offset: p } : null;
}

// ---- tls / dom ----------------------------------------------------------------------------

const FALSE_VALUE = String.raw`(?:false|0|!1)(?![\w$.])`;
const TLS_KEY = new RegExp(String.raw`(['"]?)rejectUnauthorized\1\s*:\s*${FALSE_VALUE}`, 'g');
const TLS_ASSIGN = new RegExp(
  String.raw`(?:\.rejectUnauthorized|\[\s*(['"])rejectUnauthorized\1\s*\])\s*=(?!=)\s*${FALSE_VALUE}`,
  'g'
);
const TLS_ENV = /NODE_TLS_REJECT_UNAUTHORIZED['"\]]*\s*[:=](?!=)\s*['"`]?0(?![\w.])/g;

const HTML_ASSIGN = /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*/g;
// A literal with no interpolation: `el.innerHTML = ''` cannot inject anything.
const CONSTANT_STRING = /^(?:"[^"]*"|'[^']*'|`[^`$]*`)\s*(?:[;,)}\n]|$)/;

const rules = [
  {
    id: 'no-eval',
    severity: 'high',
    description: 'eval() and new Function() execute arbitrary strings as code',
    check: evalFindings,
  },
  {
    id: 'no-debugger',
    severity: 'medium',
    description: 'debugger statements left in code',
    check: ({ codeLines }) =>
      matchLines(codeLines, /(?<![.\w$])debugger(?![\w$])/, (m, text) => {
        // Only the statement: not a property key, method, member access or shorthand.
        const after = text.slice(m.index + m[0].length).trimStart();
        if (after !== '' && after[0] !== ';' && after[0] !== '}') return null;
        const before = text.slice(0, m.index).trimEnd();
        const statement =
          before === '' ||
          /(?:[;)}]|\b(?:else|do|try|finally))$/.test(before) ||
          (/[{:]$/.test(before) && after[0] === ';') ||
          /(?:\)|\belse|\btry|\bfinally|\bdo)\s*\{$/.test(before);
        return statement ? 'Leftover debugger statement' : null;
      }),
  },
  {
    id: 'loose-equality',
    severity: 'low',
    description: '== and != coerce types; prefer === and !==',
    check: ({ codeLines }) =>
      // eqeqeq "smart": typeof comparisons, two literals and null/undefined checks are fine.
      matchLines(codeLines, /(?<![=!<>])(==|!=)(?!=)/, (m, text) => {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        const after = text.slice(m.index + 2, m.index + 62);
        if (/^\s*(?:null|undefined)(?![\w$])|^\s*void\s+0(?![\w$])/.test(after)) return null;
        if (/(?:(?<![\w$.])(?:null|undefined)|\bvoid\s+0)\s*$/.test(before)) return null;
        if (/^\s*typeof(?![\w$])/.test(after) || /\btypeof(?:\s+|\s*\()[\w$.[\]' "]*\)?\s*$/.test(before)) return null;
        const literal = String.raw`(?:"[^"]*"|'[^']*'|\x60[^\x60$]*\x60|-?\d[\w.]*|true|false)`;
        if (
          new RegExp(String.raw`(?:^|[(,;=&|?:!{}\[]|\breturn)\s*${literal}\s*$`).test(before) &&
          new RegExp(String.raw`^\s*${literal}\s*(?:[;,)\]}?:&|]|$)`).test(after)
        ) {
          return null;
        }
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
        (m, text) => {
          // `if (a = 1, b)` is a sequence expression: the assignment is a deliberate side effect.
          const open = m.index + m[0].indexOf('(');
          let depth = 0;
          const end = Math.min(text.length, open + 2000);
          for (let i = open; i < end; i++) {
            const ch = text[i];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') {
              if (--depth === 0) break;
            } else if (ch === ',' && depth === 1) return null;
          }
          return 'Assignment inside a condition; did you mean ===? (wrap in extra parentheses if intended)';
        }
      ),
  },
  {
    id: 'empty-catch',
    severity: 'medium',
    description: 'Errors are caught and silently discarded',
    check: ({ code, raw, str, rawLines, codeLines, posOf }) => {
      const out = [];
      // A comment inside the block, trailing after it or on the line above the statement means
      // the author meant to ignore the error.
      const explained = (start, end, commentAbove) => {
        if (hasComment(raw, str, start, end)) return true;
        let i = end;
        while (i < raw.length && ';,) \t'.includes(raw[i])) i++;
        if (raw[i] === '/' && (raw[i + 1] === '/' || raw[i + 1] === '*') && str[i] === ' ') return true;
        return commentAbove;
      };

      const tryRe = /(?<!\.)\bcatch\s*(?:\(\s*[\w$]*\s*(?::[^)]{0,100})?\))?\s*\{\s*\}/g;
      let m;
      while ((m = tryRe.exec(code)) !== null) {
        // The statement is the `try`: step over the `}` in front of `catch` back to its `try {`.
        let stmtStart = m.index;
        let k = skipSpaceBack(code, m.index - 1);
        if (code[k] === '}') {
          let depth = 0;
          for (; k >= 0 && k > m.index - 5000; k--) {
            if (code[k] === '}') depth++;
            else if (code[k] === '{' && --depth === 0) break;
          }
          k = skipSpaceBack(code, k - 1);
          if (k >= 2 && code.slice(k - 2, k + 1) === 'try') stmtStart = k - 2;
        }
        if (!explained(m.index, m.index + m[0].length, isCommentLine(codeLines, rawLines, posOf(stmtStart).line - 2))) {
          out.push({ ...posOf(m.index), message: 'Empty catch block swallows errors' });
        }
      }

      const handlerRe =
        /\.catch\s*\(\s*(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*\([^()]*\)|(?:\([^()]*\)(?:\s*:\s*[\w$<>[\].| ]+)?|[\w$]+)\s*=>)\s*\{\s*\}\s*\)/g;
      while ((m = handlerRe.exec(code)) !== null) {
        if (resultIsUsed(code, Math.max(0, m.index - 500), m.index)) continue;
        // Walk up a chained statement (`promise\n  .then(...)\n  .catch(...)`) looking for a comment.
        let first = posOf(m.index).line - 1;
        let commentAbove = isCommentLine(codeLines, rawLines, first - 1);
        while (first > 0 && codeLines[first].trimStart().startsWith('.')) {
          first--;
          while (first > 0 && codeLines[first].trim() === '') first--;
          if (isCommentLine(codeLines, rawLines, first - 1)) commentAbove = true;
        }
        if (!explained(m.index, m.index + m[0].length, commentAbove)) {
          out.push({ ...posOf(m.index), message: 'Empty .catch() handler swallows errors' });
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
    check: secretFindings,
  },
  {
    id: 'command-injection',
    severity: 'high',
    description: 'Shell command built from interpolated or concatenated strings',
    check: ({ str, code, posOf }) => {
      const out = [];
      const re = new RegExp(EXEC_CALLEE.source, 'g');
      let m;
      while ((m = re.exec(str)) !== null) {
        if (code[m.index] !== str[m.index]) continue; // inside a string
        const arg = firstArgument(code, m.index + m[0].length - 1);
        if (arg && isDynamicCommand(arg)) {
          out.push({
            ...posOf(m.index),
            message: 'Shell command built from dynamic input; use execFile/spawn with an argument array',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'unreachable-code',
    severity: 'medium',
    description: 'Statements after return/throw/break/continue never run',
    check: ({ codeLines, file }) => {
      const out = [];
      if (isDeclarationFile(file)) return out;
      let kinds = null;
      const nextLine = (from) => {
        let j = from;
        while (j < codeLines.length && codeLines[j].trim() === '') j++;
        return j;
      };
      for (let i = 0; i < codeLines.length; i++) {
        const m = JUMP.exec(codeLines[i]);
        if (!m) continue;
        const rest = codeLines[i].slice(m[0].length);
        // `return?(value): T;`, `throw: T` and `return() {}` declare members, they do not jump.
        if (/^\s*[?:]/.test(rest) || /^\s*\([^()]*\)\s*(?::[^;{}]*)?\{/.test(rest)) continue;
        if (/^\s*\(/.test(rest)) {
          if (/^\s*\([^()]*\)\s*:/.test(rest)) continue;
          kinds = kinds || blockKinds(codeLines);
          if (kinds[i] === 'type') continue;
        }
        const prev = prevLine(codeLines, i);
        if (prev >= 0 && indent(codeLines[prev]) < m[1].length && BRACELESS_HEADER.test(codeLines[prev].trim())) continue;
        const end = statementEnd(codeLines, i, m[1].length);
        if (!end) continue;
        const j = nextLine(end.line + 1);
        if (j >= codeLines.length || indent(codeLines[j]) !== m[1].length) continue;
        const trimmed = codeLines[j].trim();
        if (NOT_DEAD_START.test(trimmed)) continue;
        if (!end.semi && CONTINUATION_START.test(trimmed)) continue;
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
    check: ({ code, posOf }) => {
      const out = [];
      const seen = new Set();
      const re = new RegExp(RANDOM_CALL.source, 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        const target = randomTarget(code, m.index);
        if (!target || seen.has(target.offset)) continue;
        seen.add(target.offset);
        out.push({
          ...posOf(target.offset),
          message: 'Math.random() is predictable; use crypto.randomBytes() or crypto.randomUUID()',
        });
      }
      return out;
    },
  },
  {
    id: 'tls-verification-disabled',
    severity: 'high',
    description: 'TLS certificate verification turned off',
    check: ({ str, posOf }) => [
      ...matchText(str, posOf, TLS_KEY, (m) => {
        // `{ rejectUnauthorized: false }`, not `cond ? rejectUnauthorized : false`.
        const prev = str[skipSpaceBack(str, m.index - 1)];
        return prev === undefined || prev === '{' || prev === ',' ? 'TLS certificate verification is disabled' : null;
      }),
      ...matchText(str, posOf, TLS_ASSIGN, 'TLS certificate verification is disabled'),
      ...matchText(str, posOf, TLS_ENV, 'TLS certificate verification is disabled globally'),
    ],
  },
  {
    id: 'dom-xss',
    severity: 'medium',
    description: 'Assigning HTML strings to the DOM',
    check: ({ code, codeLines, posOf }) => [
      ...matchText(code, posOf, HTML_ASSIGN, (m) =>
        CONSTANT_STRING.test(code.slice(m.index + m[0].length, m.index + m[0].length + 400))
          ? null
          : 'Assigning to innerHTML/outerHTML can enable XSS; prefer textContent'
      ),
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

function indent(text) {
  return text.length - text.trimStart().length;
}

// Index of the last non-blank line before `i` (-1 if none).
function prevLine(lines, i) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  return j;
}

// True when the `.catch(...)` ending a chain at `to` feeds a value: it is assigned, returned,
// part of an argument list or array, or the branch of a ternary. `from` is some earlier point.
function resultIsUsed(code, from, to) {
  const stack = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const ch = code[i];
    const top = stack[stack.length - 1];
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '{') {
      stack.push(ch);
      start = i + 1;
    } else if (ch === ')' || ch === ']') stack.pop();
    else if (ch === '}') {
      stack.pop();
      if (!stack.length || stack[stack.length - 1] === '{') start = i + 1;
    } else if (ch === ';' && (!top || top === '{')) start = i + 1;
    else if (ch === '\n' && (!top || top === '{')) {
      const before = code[skipSpaceBack(code, i - 1)];
      const after = /^\s*(.)/.exec(code.slice(i + 1, i + 40));
      const joined = (before && '=+-*/%&|^,?:(.[<>'.includes(before)) || (after && '.?:+-*/%&|,)]}'.includes(after[1]));
      if (!joined) start = i + 1;
    }
  }
  const top = stack[stack.length - 1];
  if (top === '(' || top === '[') return true;
  return /(?<![=!<>])=(?![=>])|\breturn\b|\byield\b|=>|[?:](?!\.)/.test(code.slice(start, to));
}

module.exports = { rules };
