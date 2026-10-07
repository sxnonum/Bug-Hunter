'use strict';

// Tokenizer-style tables: "token", "secret" and "password" appear in names, never as credentials.
const TOKEN_URL = 'https://auth.example.com/oauth/token';
const tokenStorageKey = 'auth_token_v2';
const SECRET_ENV = 'MY_APP_SECRET';
const passwordLabel = 'Password';
const tokenKey = ':_authToken';
const PASSWORD_PLACEHOLDER = '<your password>';

const KEYWORDS = {
  break: 'BreakStatement',
  debugger: 'DebuggerStatement',
  return: 'ReturnStatement',
  throw: 'ThrowStatement',
};

class Lexer {
  constructor(source) {
    this.source = source;
    this.tokenType = 'WHITESPACE';
    this.lastSignificantToken = '?InterpolationInJSX';
    this.tokenizerState = 'InterpolationInTemplate';
  }

  // A method that happens to be called like the keyword.
  debugger() {
    return this.tokenType;
  }

  next() {
    if (this.pos >= this.source.length) return null;
    const ch = this.source[this.pos++];
    this.tokenType = ch === ' ' ? 'WHITESPACE' : 'BADSTRING';
    return { type: this.tokenType, value: ch };
  }
}

// Extension APIs share the name of a statement.
function attach(tabId) {
  return new Promise((resolve) => chrome.debugger.attach({ tabId }, '1.3', resolve));
}

function checkPem(pem) {
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('not a PEM key');
  return pem;
}

const help = `Pass the key as: key="-----BEGIN PRIVATE KEY-----\\nXXXX\\n-----END PRIVATE KEY-----"`;

module.exports = { Lexer, KEYWORDS, TOKEN_URL, tokenStorageKey, SECRET_ENV, passwordLabel, tokenKey, attach, checkPem, help, PASSWORD_PLACEHOLDER };
