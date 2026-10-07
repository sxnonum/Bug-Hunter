'use strict';

// Produces two same-length views of a JS/TS source file so rules can match
// against code without tripping over comments, strings or regex literals.
//   withStrings: comments and regex literal bodies blanked, string text kept
//   code:        comments, string/template text and regex bodies all blanked
// Newlines are preserved, so offsets and line numbers match the original.

const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw',
  'new', 'else', 'do', 'yield', 'await', 'instanceof',
]);
const REGEX_PREV_CHARS = '(,=:[!&|?{;*%<>~^';
const WORD_CHAR = /[A-Za-z0-9_$]/;

function mask(src) {
  const n = src.length;
  const withStrings = src.split('');
  const code = src.split('');
  let prev = ''; // last significant character seen
  let prevWord = ''; // the identifier ending at `prev`, if any

  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) {
      if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
    }
  };

  const regexAllowed = () => {
    if (prev === '') return true;
    if (REGEX_PREV_CHARS.includes(prev)) return true;
    return prevWord !== '' && REGEX_PREV_WORDS.has(prevWord);
  };

  // Returns the index of the closing quote, or of the line break if unterminated.
  function scanQuoted(i, quote) {
    let j = i + 1;
    while (j < n && src[j] !== quote && src[j] !== '\n') {
      j += src[j] === '\\' ? 2 : 1;
    }
    return Math.min(j, n);
  }

  // Returns the index just past the closing slash and flags, or -1 if this
  // slash is not a regex literal after all.
  function scanRegex(i) {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const ch = src[j];
      if (ch === '\n') return -1;
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        blank(code, i + 1, j);
        blank(withStrings, i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  }

  function scanTemplate(i) {
    let j = i + 1;
    let textStart = j;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') {
        blank(code, textStart, j);
        return j + 1;
      }
      if (ch === '$' && src[j + 1] === '{') {
        blank(code, textStart, j);
        prev = '(';
        prevWord = '';
        j = scanCode(j + 2, true) + 1;
        textStart = j;
        continue;
      }
      j++;
    }
    blank(code, textStart, n);
    return n;
  }

  // Scans code starting at i. When untilBrace is set, stops at the unmatched
  // closing brace (the end of a template `${...}`) and returns its index.
  function scanCode(i, untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];

      if (c === '/' && d === '/') {
        let end = src.indexOf('\n', i);
        if (end < 0) end = n;
        blank(withStrings, i, end);
        blank(code, i, end);
        i = end;
        continue;
      }
      if (c === '/' && d === '*') {
        let end = src.indexOf('*/', i + 2);
        end = end < 0 ? n : end + 2;
        blank(withStrings, i, end);
        blank(code, i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        const close = scanQuoted(i, c);
        blank(code, i + 1, close);
        prev = c;
        prevWord = '';
        i = src[close] === c ? close + 1 : close;
        continue;
      }
      if (c === '`') {
        i = scanTemplate(i);
        prev = '`';
        prevWord = '';
        continue;
      }
      if (c === '/' && regexAllowed()) {
        const end = scanRegex(i);
        if (end > i) {
          prev = '0'; // a regex literal is a value; a following `/` divides
          prevWord = '';
          i = end;
          continue;
        }
      }
      if (WORD_CHAR.test(c)) {
        let j = i + 1;
        while (j < n && WORD_CHAR.test(src[j])) j++;
        prevWord = src.slice(i, j);
        prev = src[j - 1];
        i = j;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (untilBrace && depth === 0) return i;
        depth--;
      }
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
        prev = c;
        prevWord = '';
      }
      i++;
    }
    return n;
  }

  scanCode(0, false);
  return { withStrings: withStrings.join(''), code: code.join('') };
}

module.exports = { mask };
