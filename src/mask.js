'use strict';

// Produces two same-length views of a JS/TS source file so rules can match
// against code without tripping over comments, strings or regex literals.
//   withStrings: comments and regex literal bodies blanked, string text kept
//   code:        comments, string/template text, regex bodies and JSX text all blanked
// \r and \n are preserved, so offsets and line numbers match the original.
//
// This is a single-pass lexer, not a parser. The one decision it has to guess
// is whether a `/` starts a regex or divides, so it tracks `exprStart`: true
// when the previous token cannot end an operand. Nesting (template `${}`,
// JSX `{}`, parens, braces) lives on an explicit stack, so depth is limited by
// memory rather than the call stack.

const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw',
  'new', 'else', 'do', 'yield', 'await', 'instanceof', 'default',
]);
const BLOCK_WORDS = new Set(['else', 'do']); // keywords that take a block, not an object literal
const HEADER_WORDS = new Set(['if', 'for', 'while', 'with']); // `kw (...)` is followed by a statement
const SPACE = /\s/;

// Stack frame kinds. BLOCK..JSX_CHILD are the frames a `}` can close.
const PAREN = 0;
const BLOCK = 1;
const OBJECT = 2;
const TEMPLATE = 3;
const JSX_ATTR = 4; // `{...}` inside an opening tag
const JSX_CHILD = 5; // `{...}` between tags
const ELEMENT = 6; // an open JSX element, waiting for its close tag
const ROOT = 7; // marks where a JSX attempt began, so a failed parse can roll back

// Modes of the JSX state machine.
const TAG = 0;
const ATTRS = 1;
const CHILDREN = 2;

const isLineEnd = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isHighSpace = (c) => c > 127 && SPACE.test(String.fromCharCode(c));
const isIdentStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36
  || (c > 127 && !isHighSpace(c));
const isWordCode = (c) => isIdentStart(c) || (c >= 48 && c <= 57);
const isJsxNameCode = (c) => isWordCode(c) || c === 45 || c === 58 || c === 46; // - : .

function decode(arr) {
  let out = '';
  for (let k = 0; k < arr.length; k += 8192) {
    out += String.fromCharCode.apply(null, arr.subarray(k, k + 8192));
  }
  return out;
}

// `jsx` is false for .ts/.mts/.cts files, where `<T>x` is a type assertion.
function mask(src, { jsx = true } = {}) {
  const n = src.length;
  const orig = new Uint16Array(n);
  for (let k = 0; k < n; k++) orig[k] = src.charCodeAt(k);
  const ws = orig.slice(); // withStrings
  const cd = orig.slice(); // code

  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) {
      if (orig[k] !== 10 && orig[k] !== 13) arr[k] = 32;
    }
  };

  const stack = [];
  let exprStart = true; // a regex (or JSX element) may start here
  let unsure = false; // exprStart only because a `}` might have closed a block
  let prevCh = 0; // char code of the last significant character
  let prevWord = ''; // the word ending at prevCh, if the last token was a word
  let wordProp = false; // that word followed a `.`, so it is a property name
  let dot = false; // the last token was `.`
  let regexFailEnd = 0; // a regex scan that failed at this index; earlier candidates fail fast
  let jsxWaste = 0; // characters spent on JSX attempts that failed
  const jsxLimit = 4 * n + 100000;

  function tok(es, ch) {
    exprStart = es;
    unsure = false;
    prevCh = ch;
    prevWord = '';
    dot = false;
  }

  function lineEnd(i) {
    while (i < n && !isLineEnd(src.charCodeAt(i))) i++;
    return i;
  }

  // Returns the index of the closing quote, or of the line break if unterminated.
  function scanQuoted(i, quote) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === quote || c === 10 || c === 13) break;
      if (c === 92) {
        j += src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? 3 : 2;
        continue;
      }
      j++;
    }
    return Math.min(j, n);
  }

  // Returns the index just past the closing slash and flags, or -1 if this
  // slash is not a regex literal after all.
  function scanRegex(i) {
    if (i < regexFailEnd) return -1;
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isLineEnd(c) || (c === 96 && unsure)) break;
      if (c === 92) {
        if (isLineEnd(src.charCodeAt(j + 1))) break;
        j += 2;
        continue;
      }
      if (c === 91) inClass = true;
      else if (c === 93) inClass = false;
      else if (c === 47 && !inClass) {
        blank(cd, i + 1, j);
        blank(ws, i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        return j;
      }
      j++;
    }
    regexFailEnd = Math.min(j, n);
    return -1;
  }

  // Scans template text from i (just past the backtick or the closing brace of
  // a `${}`). Returns where code resumes: after `${`, or after the closing backtick.
  function scanTemplate(i) {
    let j = i;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 96) {
        blank(cd, i, j);
        tok(false, 96);
        return j + 1;
      }
      if (c === 36 && src.charCodeAt(j + 1) === 123) {
        blank(cd, i, j);
        stack.push({ k: TEMPLATE });
        tok(true, 123);
        return j + 2;
      }
      j++;
    }
    blank(cd, i, n);
    tok(false, 96);
    return n;
  }

  // Is the `{` being read a block (so the matching `}` ends a statement)
  // rather than an object literal?
  function opensBlock() {
    if (prevCh === 0) return true;
    if (prevWord !== '') return wordProp || BLOCK_WORDS.has(prevWord) || !REGEX_PREV_WORDS.has(prevWord);
    return prevCh === 59 || prevCh === 123 || prevCh === 125 || prevCh === 41 || prevCh === 62; // ; { } ) >
  }

  // ---- JSX ----

  // Where the last `</name` occurs, or -1. An opening tag whose name is never
  // closed later cannot be an element (typically a generic arrow `<T extends X>(...)`),
  // so it fails at once instead of scanning its "children" to the end of the file.
  let closers = null;
  function lastCloser(name) {
    if (closers === null) {
      closers = new Map();
      const re = /<\/\s*([\w$.:\u0080-\uffff-]*)/g;
      let m;
      while ((m = re.exec(src)) !== null) closers.set(m[1], m.index);
    }
    const at = closers.get(name);
    return at === undefined ? -1 : at;
  }

  // j is just past the `>` of an outermost opening tag. Does `(params) =>` or
  // `(params): Type =>` follow, as it does for `<T extends X>(x: T) => x`?
  function genericArrowAt(j) {
    while (j < n && (src.charCodeAt(j) === 32 || (src.charCodeAt(j) >= 9 && src.charCodeAt(j) <= 13))) j++;
    if (src.charCodeAt(j) !== 40) return false;
    const limit = Math.min(n, j + 500);
    let depth = 0;
    for (; j < limit; j++) {
      const c = src.charCodeAt(j);
      if (c === 34 || c === 39) j = scanQuoted(j, c);
      else if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
    }
    if (depth !== 0) return false;
    j++;
    while (j < n && (src.charCodeAt(j) === 32 || (src.charCodeAt(j) >= 9 && src.charCodeAt(j) <= 13))) j++;
    if (src.charCodeAt(j) === 61 && src.charCodeAt(j + 1) === 62) return true;
    if (src.charCodeAt(j) !== 58) return false;
    const end = Math.min(n, j + 300);
    for (j++; j < end; j++) { // a return type, up to the arrow
      const c = src.charCodeAt(j);
      if (c === 61) return src.charCodeAt(j + 1) === 62;
      if (c === 59 || c === 123 || c === 125 || (c === 60 && src.charCodeAt(j + 1) === 47)) return false;
    }
    return false;
  }

  // k is at the `<` of a TSX type-argument list (`<Table<Row> rows={r}>`).
  // Returns the index just past the matching `>`, or -1 if it is not one.
  function jsxTypeArgs(k) {
    const limit = Math.min(n, k + 1000);
    let depth = 0;
    for (let j = k; j < limit; j++) {
      const c = src.charCodeAt(j);
      if (c === 60) depth++;
      else if (c === 62) {
        if (--depth === 0) return j + 1;
      }
      else if (c === 61 && src.charCodeAt(j + 1) === 62) j++; // `=>` in a function type
      else if (c === 34 || c === 39) j = scanQuoted(j, c);
      else if (!(isWordCode(c) || c === 32 || (c >= 9 && c <= 13) || isHighSpace(c)
          || c === 44 || c === 46 || c === 124 || c === 38 || c === 91 || c === 93
          || c === 63 || c === 58 || c === 59 || c === 40 || c === 41 || c === 123 || c === 125)) return -1;
    }
    return -1;
  }

  function jsxEnterCode() {
    tok(true, 123);
  }

  // The element that began at the innermost ROOT could not be parsed: restore
  // the text it touched and carry on lexing after its `<`, as an operator.
  function jsxFail(p) {
    let r = stack.length - 1;
    while (stack[r].k !== ROOT) r--;
    jsxWaste += Math.min(p, n) - stack[r].i;
    if (jsxWaste > jsxLimit) r = stack.findIndex((f) => f.k === ROOT);
    const from = stack[r].i;
    const to = Math.min(p + 1, n);
    ws.set(orig.subarray(from, to), from);
    cd.set(orig.subarray(from, to), from);
    stack.length = r;
    tok(false, 60);
    return from + 1;
  }

  function jsxDone(j) {
    stack.pop(); // ROOT
    tok(false, 62);
    return j;
  }

  function jsxSkipSpace(j) {
    for (;;) {
      const c = src.charCodeAt(j);
      if (c === 32 || (c >= 9 && c <= 13) || isHighSpace(c)) j++;
      else if (c === 47 && src.charCodeAt(j + 1) === 42) {
        let end = src.indexOf('*/', j + 2);
        end = end < 0 ? n : end + 2;
        blank(ws, j, end);
        blank(cd, j, end);
        j = end;
      } else if (c === 47 && src.charCodeAt(j + 1) === 47) {
        const end = lineEnd(j);
        blank(ws, j, end);
        blank(cd, j, end);
        j = end;
      } else return j;
    }
  }

  function jsxName(j) {
    while (j < n && isJsxNameCode(src.charCodeAt(j))) j++;
    return j;
  }

  // Runs the JSX state machine from j until it needs the code lexer (a `{expr}`),
  // finishes the outermost element, or fails. Returns the next index for the lexer.
  function jsxRun(j, mode) {
    for (;;) {
      if (mode === TAG) { // j is at the `<`
        let k = jsxName(j + 1);
        stack.push({ k: ELEMENT, name: src.slice(j + 1, k) });
        if (k > j + 1 && src.charCodeAt(k) === 60) {
          k = jsxTypeArgs(k);
          if (k < 0) return jsxFail(j + 1);
        }
        j = k;
        mode = ATTRS;
      } else if (mode === ATTRS) {
        j = jsxSkipSpace(j);
        if (j >= n) return jsxFail(n);
        const c = src.charCodeAt(j);
        if (c === 62) { // >
          const open = stack[stack.length - 1];
          if (lastCloser(open.name) < j
              || (stack[stack.length - 2].k === ROOT && genericArrowAt(j + 1))) return jsxFail(j);
          mode = CHILDREN;
          j++;
        } else if (c === 47 && src.charCodeAt(j + 1) === 62) { // />
          stack.pop();
          j += 2;
          if (stack[stack.length - 1].k === ROOT) return jsxDone(j);
          mode = CHILDREN;
        } else if (c === 123) { // {...spread}
          stack.push({ k: JSX_ATTR });
          jsxEnterCode();
          return j + 1;
        } else if (isIdentStart(c)) {
          j = jsxSkipSpace(jsxName(j));
          if (src.charCodeAt(j) !== 61) continue; // boolean attribute
          j = jsxSkipSpace(j + 1);
          const q = src.charCodeAt(j);
          if (q === 34 || q === 39) {
            const close = src.indexOf(src[j], j + 1);
            if (close < 0) return jsxFail(n);
            blank(cd, j + 1, close);
            j = close + 1;
          } else if (q === 123) {
            stack.push({ k: JSX_ATTR });
            jsxEnterCode();
            return j + 1;
          } else return jsxFail(j);
        } else return jsxFail(j);
      } else { // CHILDREN
        let k = j;
        while (k < n) {
          const c = src.charCodeAt(k);
          if (c === 60 || c === 123) break;
          k++;
        }
        if (k >= n) return jsxFail(n);
        blank(cd, j, k);
        if (src.charCodeAt(k) === 123) {
          stack.push({ k: JSX_CHILD });
          jsxEnterCode();
          return k + 1;
        }
        const d = src.charCodeAt(k + 1);
        if (d === 47) { // closing tag
          const nameStart = jsxSkipSpace(k + 2);
          const nameEnd = jsxName(nameStart);
          const m = jsxSkipSpace(nameEnd);
          if (src.charCodeAt(m) !== 62 || src.slice(nameStart, nameEnd) !== stack[stack.length - 1].name) {
            return jsxFail(m);
          }
          stack.pop();
          j = m + 1;
          if (stack[stack.length - 1].k === ROOT) return jsxDone(j);
        } else if (d === 62 || isIdentStart(d)) { // nested element
          j = k;
          mode = TAG;
        } else return jsxFail(k);
      }
    }
  }

  // ---- code ----

  // Scans code from i to the end of the source.
  function lex(i) {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || (c >= 9 && c <= 13) || isHighSpace(c)) { i++; continue; }

      if (c === 47) { // /
        const d = src.charCodeAt(i + 1);
        if (d === 47) {
          const end = lineEnd(i);
          blank(ws, i, end);
          blank(cd, i, end);
          i = end;
          continue;
        }
        if (d === 42) {
          let end = src.indexOf('*/', i + 2);
          end = end < 0 ? n : end + 2;
          blank(ws, i, end);
          blank(cd, i, end);
          i = end;
          continue;
        }
        if (exprStart) {
          const end = scanRegex(i);
          if (end > i) {
            tok(false, 48); // a regex literal is a value; a following `/` divides
            i = end;
            continue;
          }
        }
        tok(true, c);
        i++;
        continue;
      }
      if (c === 34 || c === 39) {
        const close = scanQuoted(i, c);
        blank(cd, i + 1, close);
        tok(false, c);
        i = src.charCodeAt(close) === c ? close + 1 : close;
        continue;
      }
      if (c === 96) {
        i = scanTemplate(i + 1);
        continue;
      }
      if (isWordCode(c)) {
        let j = i + 1;
        while (j < n && isWordCode(src.charCodeAt(j))) j++;
        const word = src.slice(i, j);
        wordProp = dot;
        exprStart = !dot && REGEX_PREV_WORDS.has(word);
        unsure = false;
        prevCh = src.charCodeAt(j - 1);
        prevWord = word;
        dot = false;
        i = j;
        continue;
      }

      switch (c) {
        case 40: // (
          // np: the nearest frame below that is not a paren, so `}` finds it in O(1)
          stack.push({
            k: PAREN,
            header: prevWord !== '' && !wordProp && HEADER_WORDS.has(prevWord),
            np: stack.length === 0 ? -1 : stack[stack.length - 1].k === PAREN ? stack[stack.length - 1].np : stack.length - 1,
          });
          tok(true, c);
          break;
        case 41: { // )
          const top = stack[stack.length - 1];
          let header = false;
          if (top !== undefined && top.k === PAREN) {
            stack.pop();
            header = top.header;
          }
          tok(header, c); // a regex may follow the `)` of `if (...)`, not of `f(...)`
          break;
        }
        case 123: // {
          stack.push({ k: opensBlock() ? BLOCK : OBJECT });
          tok(true, c);
          break;
        case 125: { // }
          let k = stack.length - 1;
          if (k >= 0 && stack[k].k === PAREN) k = stack[k].np; // drop unmatched parens
          const frame = k >= 0 && stack[k].k <= JSX_CHILD ? stack[k] : null;
          if (frame !== null) stack.length = k;
          if (frame === null || frame.k === BLOCK) {
            tok(true, c); // statement position: a regex may follow
            unsure = true;
          } else if (frame.k === OBJECT) tok(false, c);
          else if (frame.k === TEMPLATE) { i = scanTemplate(i + 1); continue; }
          else { i = jsxRun(i + 1, frame.k === JSX_ATTR ? ATTRS : CHILDREN); continue; }
          break;
        }
        case 43: // +
        case 45: // -
          if (src.charCodeAt(i + 1) === c) { // ++ and -- end an operand
            i++;
            tok(false, c);
          } else tok(true, c);
          break;
        case 33: // ! is a prefix operator, or TS non-null after an operand
          tok(exprStart, c);
          break;
        case 60: // <
          if (jsx && exprStart && jsxWaste <= jsxLimit
              && (src.charCodeAt(i + 1) === 62 || isIdentStart(src.charCodeAt(i + 1)))) {
            stack.push({ k: ROOT, i });
            i = jsxRun(i, TAG);
            continue;
          }
          tok(false, c);
          break;
        case 62: // > only starts an expression as the end of `=>`
          tok(prevCh === 61, c);
          break;
        case 46: // .
          tok(false, c);
          dot = true;
          break;
        case 91: // [
        case 44: // ,
        case 59: // ;
        case 61: // =
        case 58: // :
        case 63: // ?
        case 38: // &
        case 124: // |
        case 42: // *
        case 37: // %
        case 126: // ~
        case 94: // ^
          tok(true, c);
          break;
        default:
          tok(false, c);
      }
      i++;
    }
    return n;
  }

  let i = 0;
  if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // #! hashbang
    i = lineEnd(0);
    blank(ws, 0, i);
    blank(cd, 0, i);
  }
  for (;;) {
    i = lex(i);
    if (!stack.some((f) => f.k === ROOT)) break;
    i = jsxFail(n); // an unclosed element: give up on it and re-lex
  }
  return { withStrings: decode(ws), code: decode(cd) };
}

module.exports = { mask };
