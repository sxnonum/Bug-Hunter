'use strict'

const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

// No semicolons: the rules must not mistake continued statements for dead code.
function pick (items) {
  return items
    .filter(Boolean)
    .map((item) => item.name)
}

function sum (a, b) {
  return a +
    b
}

function message (user) {
  return `hello ${user.name},
    welcome back`
}

function guard (value) {
  return value > 0 &&
    // comments between the operands are fine
    value < 10
}

function allman ()
{
  return function inner ()
  {
    return 1
  }
}

function classify (kind) {
  switch (kind) {
    case 'a':
      return 1
    case 'b':
      return 2
    default:
      return 3
  }
}

function early (x) {
  if (x) return 1
  return 2
}

function braceless (x) {
  if (x)
    return 1
  return 2
}

function token () {
  return crypto.randomBytes(16).toString('hex')
}

function jitter () {
  return Math.random() * 100
}

function poolPick (tokens) {
  return tokens[Math.floor(Math.random() * tokens.length)]
}

function randomSession (sessions) {
  const session = sessions[Math.floor(Math.random() * sessions.length)]
  return session
}

function scan (re, text) {
  const out = []
  let m
  while ((m = re.exec(text)) !== null) out.push(m[0])
  return out
}

function list (dir, cb) {
  execFile('ls', ['-la', dir], cb)
}

function legacyRun (exec) {
  exec('ls -la', () => {})
}

module.exports = { pick, sum, message, guard, allman, classify, early, braceless, token, jitter, poolPick, randomSession, scan, list, legacyRun }
