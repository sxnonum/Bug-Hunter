'use strict';

// The README shows the output for examples/vulnerable.js, so keep the two in step.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('../src/analyze');

const FILE = path.join(__dirname, '..', 'examples', 'vulnerable.js');

test('examples/vulnerable.js triggers exactly the documented findings', () => {
  const found = analyzeSource(fs.readFileSync(FILE, 'utf8'), { file: FILE }).map((f) => `${f.line} ${f.rule}`);
  assert.deepEqual(found, [
    '5 hardcoded-secret',
    '8 assignment-in-condition',
    '13 foreach-async',
    '17 command-injection',
    '21 empty-catch',
    '23 insecure-random',
    '24 parseint-radix',
    '26 nan-comparison',
    '28 unreachable-code',
    '31 no-eval',
  ]);
});
