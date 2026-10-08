'use strict';

// Helpers for judging whether an identifier names a secret, shared by rules.

// "resetToken" -> ["reset", "token"], "API_KEY" -> ["api", "key"], "salt[i]" -> ["salt"]
function nameWords(name) {
  return name
    .replace(/\[[^\]]*\]/g, '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const SECRET_LAST = new Set([
  'password', 'passwd', 'pwd', 'pass', 'pw', 'passphrase', 'secret', 'secrets',
  'token', 'tokens', 'apikey', 'credential', 'credentials', 'nonce', 'salt', 'csrf', 'otp',
]);
const KEY_QUALIFIERS = new Set([
  'api', 'private', 'secret', 'access', 'auth', 'signing', 'encryption', 'master', 'session',
]);

// True when the identifier's meaning is a credential (judged by its last words), so
// `apiKey`, `reset_token`, `PASSWORD` qualify but `tokenType`, `tokenStorageKey`,
// `passwordLabel` and `SECRET_ENV` do not.
function isSecretName(name) {
  const words = nameWords(name);
  if (!words.length) return false;
  const last = words[words.length - 1];
  const prev = words[words.length - 2];
  if (SECRET_LAST.has(last)) return true;
  if (last === 'key' && prev && KEY_QUALIFIERS.has(prev)) return true;
  if (last === 'id' && prev === 'session') return true;
  return words.length === 1 && last === 'session';
}

module.exports = { nameWords, isSecretName };
