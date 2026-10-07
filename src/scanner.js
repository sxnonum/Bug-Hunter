'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('./analyze');

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 5000;
const MINIFIED_NAME = /\.min\.[cm]?js$/i;
const LONG_LINE = new RegExp(`[^\\r\\n]{${MAX_LINE_CHARS + 1}}`);

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
  let filesScanned = 0;

  const fail = (file, err) => errors.push({ file, message: typeof err === 'string' ? err : describe(err) });
  const isExcluded = (rel, name) => excludes.some((e) => e.regex.test(e.anchored ? rel : name));

  function scanFile(file) {
    try {
      const real = fs.realpathSync(file);
      if (seenFiles.has(real)) return;
      seenFiles.add(real);
      if (!includeMinified && MINIFIED_NAME.test(file)) {
        skipped.push({ file, reason: 'minified' });
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
      if (!includeMinified && LONG_LINE.test(text)) {
        skipped.push({ file, reason: 'minified' });
        return;
      }
      for (const f of analyzeSource(text, { file, disabledRules })) findings.push(f);
      filesScanned++;
    } catch (err) {
      fail(file, err);
    }
  }

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
    // Real files and directories first, so they win over symlinks to them when de-duplicating.
    entries.sort((a, b) => a.isSymbolicLink() - b.isSymbolicLink() || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (IGNORED_DIRS.has(entry.name) || isExcluded(entryRel, entry.name)) continue;
      let kind = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        } catch (err) {
          const broken = err.code === 'ENOENT' || err.code === 'ELOOP';
          // A broken link with some other extension (a README, a lockfile) cannot hide source code.
          if (!broken) fail(full, err);
          else if (isScannable(entry.name) || !path.extname(entry.name)) {
            fail(full, err.code === 'ELOOP' ? 'symlink loop' : 'dangling symlink');
          }
          continue;
        }
      }
      if (kind === 'dir') walkDir(full, entryRel);
      else if (isScannable(entry.name)) {
        if (kind === 'file') scanFile(full);
        else skipped.push({ file: full, reason: 'not-a-regular-file' });
      }
    }
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
    else if (stat.isFile()) scanFile(target);
    else skipped.push({ file: target, reason: 'not-a-regular-file' });
  }
  return { findings, filesScanned, skipped, errors };
}

module.exports = { scanPaths };
