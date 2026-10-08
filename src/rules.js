'use strict';

const { isSecretName, nameWords } = require('./names');

// Each rule has { id, severity, description, check(ctx) } where check returns
// [{ line, column, message }] (1-based). `ctx` carries several views of the file:
//   file                 path as given (used to skip .d.ts declaration files)
//   relFile              path relative to the scan root (used to recognise test files)
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
// TypeScript-only files cannot hold JSX; `<T>expr` there is a cast.
const allowsJsx = (file) => !/\.[cm]?ts$/i.test(file);

// True when the source between a and b holds a comment (raw differs from the comment-blanked view).
function hasComment(raw, str, a, b) {
  for (let i = a; i < b; i++) {
    if (raw[i] !== str[i] && !/\s/.test(raw[i])) return true;
  }
  return false;
}

// A line that holds only a comment. Comments are blanked in the string-preserving view, but string,
// template and JSX text are not, so a text line there is never mistaken for a comment.
function isCommentLine(strLines, rawLines, idx) {
  return idx >= 0 && strLines[idx].trim() === '' && rawLines[idx].trim() !== '';
}

const SECRET_PATTERNS = [
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  // The digit-dash structure (xoxb-123456789012-...) keeps `xoxb-your-bot-token-here` out.
  { kind: 'Slack token', re: /\bxox[abprs]-\d+-[A-Za-z0-9-]{8,}/g },
];
// Documented dummy credentials: AWS's published `...EXAMPLE` key, `ghp_xxxx...`, `xoxb-your-token`.
const TOKEN_PLACEHOLDER = /example|your|[x*]{8,}/i;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
// scheme://user:password@host
const URL_CREDENTIALS = /:\/\/([^\s/:@'"`$<>{}()\\]*):([^\s/@'"`$<>{}()\\]{4,})@/g;
const PLACEHOLDER_PASSWORD =
  /^(?:(?:my|your|the)?(?:pass(?:w[o0]rd)?|pwd|secret|token|key)\d*|user(?:name)?|root|admin|x+|\*+)$/i;

// Test code carries fixture credentials, so the name-based check skips it (the format-based checks
// above still apply). It is judged by the path relative to the scan root, never by directories above
// it: a project checked out under ~/test/ is not a test file.
const TEST_FILE =
  /(?:^|[\\/])(?:tests?|__tests__|__mocks__|__fixtures__|fixtures?|mocks?|spec|e2e|cypress)[\\/]|\.(?:test|spec|cy|e2e|stories)\.[cm]?[jt]sx?$/i;

const SECRET_KEYWORDS = /pass|secret|token|key|credential|nonce|salt|csrf|otp|session|pw/i;
// name [: Type] (=|:) [process.env.X ||] 'value'; `name` may be quoted (JSON-style keys, obj['name']).
// Groups: 1 name, 2/3 quoted name, 4 env fallback prefix, 5 quote, 6 value.
const SECRET_ASSIGNMENT =
  /(?<![\w$])(?:([A-Za-z_$][\w$]*)|(['"])([\w$-]+)\2(?:\s*\])?)[?!]?(?:\s*:\s*[A-Za-z_$][\w$.<>[\]| ]{0,60}?)?\s*[:=](?!=)\s*((?:process\.env(?:\.[\w$]+|\[[^\]\n]*\])|import\.meta\.env\.[\w$]+)\s*(?:\|\||\?\?)\s*)?(['"`])([^'"`\n]{6,})\5/g;
const PLACEHOLDER_VALUE =
  /^(?:x+|\*+|\.+|-+|<.*>|\{\{.*\}\}|\$\{.*\}|%\w+%|(?:your|my)[_\- ].*|example.*|change[_-]?me|placeholder.*|dummy.*|redacted|none|null|undefined|pass(?:word)?|secret|token|api[_-]?key)$/i;
// Names that are exactly a password or secret may hold shorter values (`password = 'hunter2'`).
const EXACT_PASSWORD_NAMES = new Set(['password', 'passwd', 'pwd', 'pass', 'secret']);
const PASSWORD_LAST_WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret']);
// One part of a dotted, snake_case or kebab-case identifier: a lowercase word (with a short
// version digit), a Capitalized/UPPER word or a one- or two-digit number (app.session.v2).
const WORDLIKE = /^(?:[a-z]+\d?\d?|[A-Z][A-Za-z]*|\d{1,2})$/;
const CASE_TOKEN = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
const SENTENCE_WORDS = /^(?:the|is|are|a|an|and|or|not|to|for|of|you|your|enter|please|must|be|invalid|wrong|required|confirm|forgot|new|old|current|show|hide|min|max|at|least)$/i;

// camelCase / PascalCase words (`getAPIKey`, `InterpolationInJSX`) are made of mostly 3+ letter
// pieces; a random mix of upper and lower case letters is made of short ones.
function isCamelWord(word) {
  const tokens = word.match(CASE_TOKEN) || [];
  return tokens.join('') === word && tokens.filter((t) => t.length >= 3).length * 2 >= tokens.length;
}

// `keyboard cat`, `correct horse`: a short passphrase, not a label or a sentence.
function passphraseLike(value) {
  const words = value.split(/\s+/);
  if (words.length > 3 || /[^A-Za-z0-9' ]/.test(value) || /\b(?:pass\w*|secret|token|key|credential\w*)\b/i.test(value)) return false;
  if (/^[A-Z][a-z]+ [a-z]/.test(value)) return false; // Sentence case
  return !words.some((w) => SENTENCE_WORDS.test(w));
}

// Positive test: does the value have the shape of a credential? Routes, identifiers, enum labels,
// validation rules, translated words and plain dictionary-like words are labels, not secrets.
// `fallback`: the value follows `process.env.X ||`, where a plain lowercase word is still a leak.
// `passwordish`: the name ends in password/secret, which may hold a short passphrase.
function looksLikeSecretValue(value, { fallback = false, passwordish = false } = {}) {
  if (/\$\{|\[[^\]]*-[^\]]*\]/.test(value) || PLACEHOLDER_VALUE.test(value)) return false; // templates, regex classes
  if (/[^\x20-\x7e]|[|\\]|^(?:\.{1,2}|~)?\//.test(value)) return false; // non-ASCII words, `a|b` rules, paths, routes
  if (/\s/.test(value)) return passwordish && passphraseLike(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URLs are covered by the credentials-in-URL check
  const parts = value.split(/[._:/?-]+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => WORDLIKE.test(p))) return false; // app.session.v2, SOME_ENUM, a-b-c
  const word = parts.join('');
  if (!word) return false;
  if (/[^A-Za-z]/.test(word)) return true; // a digit or symbol among the letters
  if (/[a-z]/.test(word) && /[A-Z]/.test(word) && !isCamelWord(word)) return true; // random case
  return fallback && /^[a-z]+$/.test(word);
}

// Skip a candidate when the text before it shows it is the `?` branch of a ternary, a type or a declaration.
function isLabelContext(before) {
  const t = before.slice(-24).trimEnd();
  return t.endsWith('?') || /\b(?:type|interface|declare\s+(?:const|let|var))\s+$/.test(before.slice(-24));
}

// True when a base64 body (>= 40 chars) follows the PEM header at `from`, in the same string or
// comment. A bare header constant, `startsWith('-----BEGIN ...')` or a `${body}` template is no leak.
function hasKeyBody(raw, from) {
  const lines = raw.slice(from, from + 6000).replace(/\\+[rn]/g, '\n').split(/\r\n?|\n/);
  if (/['"`]/.test(lines[0])) return false; // the string ends right after the header
  let body = 0;
  for (const line of lines) {
    const t = line.replace(/^\s*(?:\/\/+|\*+|#+)?\s*['"`]?/, '').replace(/[\s'"`+,;)\\]+$/, '');
    if (t === '' || (body === 0 && /^[A-Za-z][\w-]*:/.test(t))) continue; // blank, or Proc-Type/DEK-Info
    if (!/^[A-Za-z0-9+/=]+$/.test(t) || /^x+$/i.test(t)) break; // END line, `${b64}`, XXXX placeholder, prose
    body += t.length;
    if (body >= 40) return true;
  }
  return false;
}

function secretFindings({ raw, str, strLines, codeLines, posOf, file, relFile }) {
  const out = [];
  // Token-shaped secrets are looked for in the raw text: a live credential committed in a comment is
  // still leaked. Placeholders from documentation are skipped.
  for (const { kind, re } of SECRET_PATTERNS) {
    out.push(...matchText(raw, posOf, re, (m) => (TOKEN_PLACEHOLDER.test(m[0]) ? null : `Possible hardcoded secret (${kind})`)));
  }

  out.push(
    ...matchText(raw, posOf, PRIVATE_KEY_HEADER, (m) =>
      hasKeyBody(raw, m.index + m[0].length) ? 'Possible hardcoded secret (private key)' : null
    )
  );

  if (raw.includes('://')) {
    out.push(
      ...matchText(raw, posOf, URL_CREDENTIALS, (m) => {
        if (PLACEHOLDER_VALUE.test(m[2]) || PLACEHOLDER_PASSWORD.test(m[2])) return null;
        // The URL must open a string (`'postgres://u:p@host'`) or start a word in a comment, not sit inside prose.
        let start = m.index;
        while (start > 0 && m.index - start < 20 && /[a-z0-9+.-]/i.test(raw[start - 1])) start--;
        if (start === m.index) return null;
        const comment = str[m.index] === ' ' && raw[m.index] !== ' ';
        const before = raw[start - 1] || '';
        const opens = comment ? start === 0 || /[\s('"`<]/.test(before) : /['"`]/.test(before);
        return opens ? 'Possible hardcoded secret (credentials embedded in a URL)' : null;
      })
    );
  }

  if (isDeclarationFile(file) || TEST_FILE.test(relFile)) return out; // `declare const token: "abc"` states a type
  const assignment = new RegExp(SECRET_ASSIGNMENT.source, 'g');
  strLines.forEach((line, idx) => {
    if (!SECRET_KEYWORDS.test(line)) return;
    let text = line;
    // Prettier puts a long value on the next line: `const password =\n  'value'`.
    const next = strLines[idx + 1];
    if (next !== undefined && /(?:[:=]|\|\||\?\?)\s*$/.test(text) && /^\s*(?:['"`]|process\.env|import\.meta)/.test(next)) {
      text += ' ' + next.trim();
    }
    assignment.lastIndex = 0;
    let m;
    while ((m = assignment.exec(text)) !== null) {
      if (codeLines[idx][m.index] !== text[m.index]) continue; // match starts inside a string
      const name = m[1] || m[3];
      if (!isSecretName(name) || isLabelContext(text.slice(0, m.index))) continue;
      const words = nameWords(name);
      const exact = words.length === 1 && EXACT_PASSWORD_NAMES.has(words[0]);
      if (m[6].length < (exact ? 6 : 8)) continue;
      const passwordish = PASSWORD_LAST_WORDS.has(words[words.length - 1]);
      if (!looksLikeSecretValue(m[6], { fallback: Boolean(m[4]), passwordish })) continue;
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

// Only the shell-spawning calls: exec, execSync (and the promisified spellings), not execFile*/execute*/execPath.
const EXEC_NAME = String.raw`exec(?:Sync|Async|P|Promise)?\s*\(`;
const EXEC_CALLEE = new RegExp(
  [
    String.raw`(?<![.\w$])` + EXEC_NAME,
    String.raw`(?<![\w$])(?:[cC]hild_?[pP]rocess|cp|proc|shell|sh)\s*\.\s*` + EXEC_NAME,
    String.raw`require\s*\(\s*['"](?:node:)?child_process['"]\s*\)\s*\.\s*` + EXEC_NAME,
  ].join('|'),
  'g'
);

// Source of the first argument of the call whose '(' is at `open`, plus whether it has a top-level '+'.
// There is no length cap (a long inline shell script is still a dynamic command); `budget.left` bounds
// the total work so many unclosed calls cannot make the rule quadratic.
function firstArgument(code, open, budget) {
  let depth = 0;
  let plus = false;
  for (let i = open; i < code.length; i++) {
    if (--budget.left < 0) return null;
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
// `</h1>` and `/>` can only close JSX; they are never statements.
const NOT_DEAD_START =
  /^(?:[}\])]|<\/|\/>|case\b|default\b|else\b|catch\b|finally\b|(?:async\s+)?function\b|interface\b|declare\b|type\s+[\w$]+\s*[=<])/;
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

// Where the JSX element that `return <tag ...>` starts at (start, col) ends: { line, semi }, or null.
// Children such as `{title}` or text lines would otherwise end the statement early and leave the
// closing tag, aligned with `return`, looking like dead code.
function jsxReturnEnd(codeLines, start, col) {
  let depth = 0; // open elements
  let inTag = false; // between '<' and its '>'
  let closing = false; // inside `</tag`
  let braces = 0; // inside {expression} (attributes or children)
  const last = Math.min(codeLines.length, start + 400);
  for (let i = start; i < last; i++) {
    const text = codeLines[i];
    for (let c = i === start ? col : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === '{') braces++;
      else if (ch === '}') {
        if (--braces < 0) return null;
      } else if (braces > 0) continue;
      else if (!inTag) {
        if (ch !== '<') continue;
        inTag = true;
        closing = text[c + 1] === '/';
      } else if (ch === '/' && text[c + 1] === '>') {
        inTag = false;
        c++;
        if (closing) return null;
        if (depth === 0) return jsxEndLine(text, c + 1, i);
      } else if (ch === '>') {
        inTag = false;
        if (closing) depth--;
        else depth++;
        if (depth <= 0) return jsxEndLine(text, c + 1, i);
      }
    }
  }
  return null;
}

// After the closing '>' of the outermost element: only `;` (or nothing) may follow.
function jsxEndLine(text, from, line) {
  const rest = text.slice(from).trim();
  if (rest === ';') return { line, semi: true };
  return rest === '' ? { line, semi: false } : null;
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

// ---- tls -----------------------------------------------------------------------------------

const TLS_MESSAGE = 'TLS certificate verification is disabled';
// A `NODE_TLS_REJECT_UNAUTHORIZED=0` inside a string counts only when the string is a shell/env
// assignment: it starts with it or follows `;` `&&` `|` (optionally after `export`/`env`/other VAR=x).
const SHELL_ASSIGNMENT_PREFIX = /(?:^|[;&|(]\s*)(?:(?:export|env|set|cross-env)\s+|\w+=\S*\s+)*$/;
// Strings handed to these are messages for a human, not commands.
const MESSAGE_CALLEE = /(?:\b(?:console|logger|log|process\.std(?:err|out))\s*\.\s*\w+|\.(?:log|warn|warning|error|info|debug|trace|write)|\b(?:Error|TypeError|RangeError|warn|warning|emitWarning|alert|print))\s*$/;

// `interface Opts { rejectUnauthorized: false }` and `type T = { rejectUnauthorized: false } | {...}` in
// TypeScript describe a type; they do not turn verification off.
function inTypeDeclaration(code, index) {
  let depth = 0;
  for (let i = index; i >= 0 && i > index - 4000; i--) {
    const ch = code[i];
    if (ch === '}') depth++;
    else if (ch === '{' && depth-- === 0) {
      const header = code.slice(Math.max(0, i - 200), i);
      return (
        /\b(?:interface|enum|class)\s+[\w$]+[^{};=]*$/.test(header) ||
        /\btype\s+[\w$]+[^={};]*=\s*(?:[^{};]*[|&]\s*)?$/.test(header) ||
        /[|&]\s*$/.test(header)
      );
    }
  }
  return false;
}

function tlsFindings({ file, str, code, posOf }) {
  const typed = /\.[cm]?tsx?$/i.test(file);
  // The key and assignment forms are looked for in code, so text in messages and docs is ignored.
  // A quoted key keeps its delimiter in the code view (the text between is blanked).
  const real = (index, quote) => (quote ? code[index] === quote : code[index] === str[index]);
  return [
    ...matchText(str, posOf, TLS_KEY, (m) => {
      if (!real(m.index, m[1])) return null;
      // `{ rejectUnauthorized: false }`, not `cond ? rejectUnauthorized : false`.
      const prev = str[skipSpaceBack(str, m.index - 1)];
      if (prev !== undefined && prev !== '{' && prev !== ',') return null;
      return typed && inTypeDeclaration(code, m.index) ? null : TLS_MESSAGE;
    }),
    ...matchText(str, posOf, TLS_ASSIGN, (m) => (real(m.index) ? TLS_MESSAGE : null)),
    ...matchText(str, posOf, TLS_ENV, (m) => {
      const message = 'TLS certificate verification is disabled globally';
      if (code[m.index] === str[m.index]) return message; // a property or variable, not text
      // Inside a string: find where it opens (its delimiter is kept in the code view).
      let open = m.index - 1;
      while (open >= 0 && m.index - open < 2000 && !(code[open] === str[open] && '\'"`'.includes(str[open]))) open--;
      if (open < 0 || m.index - open >= 2000) return null;
      // `'NODE_TLS_REJECT_UNAUTHORIZED'` is a whole key: `env['NODE_TLS_...'] = 0`, `{ 'NODE_TLS_...': '0' }`.
      if (open === m.index - 1 && /['"\]]/.test(m[0].slice('NODE_TLS_REJECT_UNAUTHORIZED'.length))) return message;
      if (!SHELL_ASSIGNMENT_PREFIX.test(str.slice(open + 1, m.index))) return null;
      // `console.warn('NODE_TLS_REJECT_UNAUTHORIZED=0 disables checks')` is advice, not a command.
      return MESSAGE_CALLEE.test(str.slice(Math.max(0, open - 40), open).replace(/\(\s*$/, '').trimEnd()) ? null : message;
    }),
  ];
}

// ---- dom ----------------------------------------------------------------------------

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

// The nearest non-blank code line above (dir -1) or below (dir 1) line `idx`, or ''.
function adjacentCode(lines, idx, dir) {
  for (let j = idx + dir; j >= 0 && j < lines.length && Math.abs(j - idx) <= 5; j += dir) {
    if (lines[j].trim() !== '') return lines[j];
  }
  return '';
}

// Index of the opening bracket matching the closing one at `close`, or -1 (scans at most 2000 chars).
function matchOpenBack(text, close) {
  let depth = 0;
  for (let i = close; i >= 0 && i > close - 2000; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if ((ch === '(' || ch === '[' || ch === '{') && --depth === 0) return i;
  }
  return -1;
}

// True when `before` ends with `typeof <operand>`: an identifier path with calls, indexes or
// parentheses (`typeof a.b(c)`, `typeof (x || y)`, `typeof require('x')`).
function endsWithTypeofOperand(before) {
  let i = before.length - 1;
  for (let steps = 0; steps < 50; steps++) {
    i = skipSpaceBack(before, i);
    if (i < 0) return false;
    const group = before[i] === ')' || before[i] === ']';
    if (group) {
      const open = matchOpenBack(before, i);
      if (open < 0) return false;
      i = open - 1;
    } else if (isWordChar(before[i])) {
      let j = i;
      while (j >= 0 && isWordChar(before[j])) j--;
      if (before.slice(j + 1, i + 1) === 'typeof') return true;
      i = j;
    } else return false;
    // Member access (`a.b`, `a?.b`) continues the operand; so does the callee in front of a group.
    const k = skipSpaceBack(before, i);
    if (k < 0) return false;
    if (before[k] === '.') i = before[k - 1] === '?' ? k - 2 : k - 1;
    else if (isWordChar(before[k]) && !group) return /(?:^|[^\w$])typeof$/.test(before.slice(0, k + 1));
    else if (!group || !(isWordChar(before[k]) || before[k] === ')' || before[k] === ']')) return false;
  }
  return false;
}

// 'string' | 'number' | 'boolean' when the text starts (atStart) or ends a literal of that type
// directly after/before an operator-ish boundary; null otherwise.
function literalKind(text, atEnd) {
  const literal = String.raw`("[^"]*"|'[^']*'|\x60[^\x60$]*\x60|-?\d[\w.]*|true|false)`;
  const re = atEnd
    ? new RegExp(String.raw`(?:^|[(,;=&|?:!{}\[]|\breturn)\s*${literal}\s*$`)
    : new RegExp(String.raw`^\s*${literal}\s*(?:[;,)\]}?:&|]|$)`);
  const m = re.exec(text);
  if (!m) return null;
  const v = m[1];
  if (v === 'true' || v === 'false') return 'boolean';
  return /^["'\x60]/.test(v) ? 'string' : 'number';
}

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
    description:
      '== and != coerce types; prefer === and !== (== null, == undefined, == void 0, typeof comparisons and same-type literal pairs are allowed)',
    check: ({ codeLines }) =>
      // Like eqeqeq "smart", plus `== undefined`: typeof comparisons, two literals of one type and
      // null/undefined checks are fine. An operand that wraps onto the next or previous line counts.
      matchLines(codeLines, /(?<![=!<>])(==|!=)(?!=)/, (m, text, idx) => {
        let lead = text.slice(0, m.index);
        let rest = text.slice(m.index + 2);
        if (lead.trim() === '') lead = adjacentCode(codeLines, idx, -1) + ' ' + lead;
        if (rest.trim() === '') rest = adjacentCode(codeLines, idx, 1);
        const before = lead.slice(-60);
        const after = rest.slice(0, 60);
        if (/^\s*(?:null|undefined)(?![\w$])|^\s*void\s+0(?![\w$])/.test(after)) return null;
        if (/(?:(?<![\w$.])(?:null|undefined)|\bvoid\s+0)\s*$/.test(before)) return null;
        if (/^\s*typeof(?![\w$])/.test(after) || endsWithTypeofOperand(lead)) return null;
        const left = literalKind(before, true);
        if (left && left === literalKind(after, false)) return null;
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
    check: ({ code, raw, str, rawLines, strLines, codeLines, posOf }) => {
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

      // Each optional piece owns its own whitespace, so no position can be matched in two ways.
      const tryRe = /(?<!\.)\bcatch\s*(?:\(\s*(?:[\w$]+\s*)?(?::[^)]{0,100})?\)\s*)?\{\s*\}/g;
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
        if (!explained(m.index, m.index + m[0].length, isCommentLine(strLines, rawLines, posOf(stmtStart).line - 2))) {
          out.push({ ...posOf(m.index), message: 'Empty catch block swallows errors' });
        }
      }

      // A return type annotation is words separated by single runs of spaces, so every position has one way to match.
      const handlerRe =
        /\.catch\s*\(\s*(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*\([^()]*\)|(?:\([^()]*\)(?:\s*:\s*[\w$<>[\].|]+(?:\s+[\w$<>[\].|]+)*)?|[\w$]+)\s*=>)\s*\{\s*\}\s*\)/g;
      while ((m = handlerRe.exec(code)) !== null) {
        if (resultIsUsed(code, Math.max(0, m.index - 500), m.index)) continue;
        // Walk up a chained statement (`promise\n  .then(...)\n  .catch(...)`) looking for a comment.
        let first = posOf(m.index).line - 1;
        let commentAbove = isCommentLine(strLines, rawLines, first - 1);
        while (first > 0 && codeLines[first].trimStart().startsWith('.')) {
          first--;
          while (first > 0 && codeLines[first].trim() === '') first--;
          if (isCommentLine(strLines, rawLines, first - 1)) commentAbove = true;
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
      const budget = { left: 4 * code.length + 100000 };
      let m;
      while ((m = re.exec(str)) !== null) {
        if (code[m.index] !== str[m.index]) continue; // inside a string
        const arg = firstArgument(code, m.index + m[0].length - 1, budget);
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
        const jsx = m[2] === 'return' && /^\s*<[A-Za-z_$>]/.test(rest) && allowsJsx(file);
        const end =
          (jsx && jsxReturnEnd(codeLines, i, m[0].length + rest.indexOf('<'))) ||
          statementEnd(codeLines, i, m[1].length);
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
        /\bparseInt\s*\(\s*(?:[^(),\s]|\([^()]*\))(?:[^(),]|\([^()]*\))*\)/,
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
    check: tlsFindings,
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
  {
    // Findings are produced by analyze.js while it reads bughunter-disable comments; the entry
    // exists so the rule is listed, can be disabled and appears in SARIF output.
    id: 'invalid-directive',
    severity: 'low',
    description: 'bughunter-disable comment naming a rule that does not exist',
    check: () => [],
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
// The statement start is kept per bracket: leaving a callback or object that sits inside an
// expression restores the start of that expression, so `return a.then(x => {\n ... }).catch(..)`
// still sees its `return`.
function resultIsUsed(code, from, to) {
  const stack = []; // { ch, outer }: bracket kind and the statement start in force outside it
  let start = from;
  for (let i = from; i < to; i++) {
    const ch = code[i];
    const top = stack.length ? stack[stack.length - 1].ch : undefined;
    if (ch === '(' || ch === '[') stack.push({ ch, outer: start });
    else if (ch === '{') {
      stack.push({ ch, outer: start, inExpression: top === '(' || top === '[' });
      start = i + 1;
    } else if (ch === ')' || ch === ']') {
      const closed = stack.pop();
      if (closed) start = closed.outer;
    } else if (ch === '}') {
      const closed = stack.pop();
      if (closed && closed.inExpression) start = closed.outer; // callback or object argument
      else start = i + 1; // end of a block
    } else if (ch === ';' && (!top || top === '{')) start = i + 1;
    else if (ch === '\n' && (!top || top === '{')) {
      const before = code[skipSpaceBack(code, i - 1)];
      const after = /^\s*(.)/.exec(code.slice(i + 1, i + 40));
      const joined = (before && '=+-*/%&|^,?:(.[<>'.includes(before)) || (after && '.?:+-*/%&|,)]}'.includes(after[1]));
      if (!joined) start = i + 1;
    }
  }
  const top = stack.length ? stack[stack.length - 1].ch : undefined;
  if (top === '(' || top === '[') return true;
  // Only the statement's own tokens count, not what sits inside its brackets (`a.then(x => y).catch(..)`).
  let flat = '';
  let depth = 0;
  for (let i = start; i < to; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += ch;
  }
  return /(?<![=!<>])=(?![=>])|\breturn\b|\byield\b|=>|[?:](?!\.)/.test(flat);
}

module.exports = { rules };
