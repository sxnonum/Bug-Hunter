'use strict';

const fs = require('node:fs');

let fast;
// Optional dependency: fall back to the built-in implementation when it is missing.
try {
  fast = require('fast-impl');
} catch (e) {}

// Best-effort cleanup; failure here is fine.
function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

function closeQuietly(fd) {
  try { fs.closeSync(fd); } catch (e) {} // already closed
}

async function cleanup(file) {
  // Try to unlink, but ignore errors.
  await fs.promises.unlink(file).catch(() => {});
  const stats = await fs.promises.stat(file).catch(() => {});
  if (stats) return stats.size;
  return fs.promises
    .readFile(file)
    .catch(function () {});
}

async function lookup(names) {
  return Promise.all(names.map((n) => which(n).catch(() => {})));
}

module.exports = { fast, removeQuietly, closeQuietly, cleanup, lookup };
