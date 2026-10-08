'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./analyze');

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 5000;
const MINIFIED_NAME = /\.min\.[cm]?js$/i;
const LINE_BREAK = /[\r\n]/g;

// True if any line (broken at \r, \n or \r\n) is longer than `max` characters. One pass over
// the text: an unanchored `[^\r\n]{5001}` regex retries at every offset and is quadratic.
function hasLongLine(text, max = MAX_LINE_CHARS) {
  let start = 0;
  for (;;) {
    LINE_BREAK.lastIndex = start;
    const m = LINE_BREAK.exec(text);
    const end = m ? m.index : text.length;
    if (end - start > max) return true;
    if (!m) return false;
    start = end + 1;
  }
}

const isScannable = (name) => EXTENSIONS.has(path.extname(name).toLowerCase());

// "EACCES: permission denied, open 'x'" -> "permission denied (EACCES)"
function describe(err) {
  const m = /^[A-Z0-9_]+: ([^,]+)/.exec(err.message || '');
  const text = m ? m[1] : String((err && err.message) || err);
  return err.code ? `${text} (${err.code})` : text;
}

// Exclude globs: `*` matches within one path segment, `**` across segments, `?` one character.
// A pattern without a slash matches a file or directory name anywhere; one with a slash is
// anchored at the scan root. A matching directory is pruned along with everything below it.
function compileExclude(pattern) {
  const p = pattern.replace(/^\.?\//, '').replace(/\/+$/, '');
  const source = p.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (tok) => {
    if (tok === '**/') return '(?:.*/)?';
    if (tok === '**') return '.*';
    if (tok === '*') return '[^/]*';
    if (tok === '?') return '[^/]';
    return `\\${tok}`;
  });
  return { regex: new RegExp(`^${source}$`), anchored: p.includes('/') };
}

function scanPaths(targets, { disabledRules = [], includeMinified = false, exclude = [] } = {}) {
  const excludes = exclude.map(compileExclude);
  const findings = [];
  const skipped = [];
  const errors = [];
  const seenFiles = new Set(); // real paths, so overlapping arguments and symlinks count once
  const seenDirs = new Set(); // real paths, which also breaks symlink loops
  const minifiedSkips = new Map(); // real path -> skipped entry, so a later explicit argument can still scan it
  const deferred = []; // symlinks found while walking; followed only after every real file was seen
  let filesScanned = 0;

  const fail = (file, err) => errors.push({ file, message: typeof err === 'string' ? err : describe(err) });
  const isExcluded = (rel, name) => excludes.some((e) => e.regex.test(e.anchored ? rel : name));

  // `explicit` = named on the command line: never skipped as minified, only for size or content.
  function scanFile(file, relFile, explicit) {
    try {
      const real = fs.realpathSync(file);
      if (seenFiles.has(real)) return;
      const earlier = minifiedSkips.get(real);
      if (earlier) {
        if (!explicit) return;
        minifiedSkips.delete(real);
        skipped.splice(skipped.indexOf(earlier), 1);
      }
      seenFiles.add(real);
      const checkMinified = !includeMinified && !explicit;
      if (checkMinified && MINIFIED_NAME.test(file)) {
        skipMinified(file, real);
        return;
      }
      if (fs.statSync(real).size > MAX_FILE_BYTES) {
        skipped.push({ file, reason: 'too-large' });
        return;
      }
      const buf = fs.readFileSync(real);
      if (buf.includes(0)) {
        skipped.push({ file, reason: 'binary' });
        return;
      }
      const text = buf.toString('utf8');
      if (checkMinified && hasLongLine(text)) {
        skipMinified(file, real);
        return;
      }
      for (const f of analyzeSource(text, { file, relFile, disabledRules })) findings.push(f);
      filesScanned++;
    } catch (err) {
      fail(file, err);
    }
  }

  function skipMinified(file, real) {
    const entry = { file, reason: 'minified' };
    skipped.push(entry);
    minifiedSkips.set(real, entry);
    seenFiles.delete(real);
  }

  // Symlinks are not followed here but queued (see `deferred`), so a real file always wins over
  // an alias of it, whatever order the directories come in.
  function walkDir(dir, rel) {
    let entries;
    try {
      const real = fs.realpathSync(dir);
      if (seenDirs.has(real)) return;
      seenDirs.add(real);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      fail(dir, err);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (IGNORED_DIRS.has(entry.name) || isExcluded(entryRel, entry.name)) continue;
      if (entry.isSymbolicLink()) {
        deferred.push({ full, entryRel, name: entry.name });
        continue;
      }
      visit(full, entryRel, entry.name, entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other');
    }
  }

  function visit(full, entryRel, name, kind) {
    if (kind === 'dir') walkDir(full, entryRel);
    else if (isScannable(name)) {
      if (kind === 'file') scanFile(full, entryRel, false);
      else skipped.push({ file: full, reason: 'not-a-regular-file' });
    }
  }

  function followSymlink({ full, entryRel, name }) {
    let kind;
    try {
      const st = fs.statSync(full);
      kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    } catch (err) {
      const broken = err.code === 'ENOENT' || err.code === 'ELOOP';
      // A broken link whose name is not a source file (.env, LICENSE, a README) cannot hide source code.
      if (!broken) fail(full, err);
      else if (isScannable(name)) fail(full, err.code === 'ELOOP' ? 'symlink loop' : 'dangling symlink');
      return;
    }
    visit(full, entryRel, name, kind);
  }

  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      const dangling = err.code === 'ENOENT' && fs.lstatSync(target, { throwIfNoEntry: false });
      fail(target, dangling ? 'dangling symlink' : err);
      continue;
    }
    if (stat.isDirectory()) walkDir(target, '');
    else if (stat.isFile()) scanFile(target, path.basename(target), true);
    else skipped.push({ file: target, reason: 'not-a-regular-file' });
  }
  // Second pass: follow the symlinks found above (and any found through them, in turn).
  for (let i = 0; i < deferred.length; i++) followSymlink(deferred[i]);
  return { findings, filesScanned, skipped, errors };
}

module.exports = { scanPaths, hasLongLine };
