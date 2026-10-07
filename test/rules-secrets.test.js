'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../src/analyze');
const { isSecretName } = require('../src/names');

const has = (src, file) => analyzeSource(src, { file }).some((f) => f.rule === 'hardcoded-secret');

test('isSecretName judges by the last words of the identifier', () => {
  for (const name of ['apiKey', 'API_KEY', 'password', 'dbPassword', 'resetToken', 'client_secret', 'sessionId', 'salt[i]']) {
    assert.ok(isSecretName(name), name);
  }
  for (const name of ['tokenType', 'tokenStorageKey', 'passwordLabel', 'SECRET_ENV', 'TOKEN_URL', 'key', 'monkey']) {
    assert.ok(!isSecretName(name), name);
  }
});

test('hardcoded-secret ignores names that merely contain a keyword', () => {
  const src = [
    "const TOKEN_URL = 'https://auth.example.com/oauth/token';",
    "const tokenStorageKey = 'auth_token_v2';",
    "const SECRET_ENV = 'MY_APP_SECRET';",
    "const passwordLabel = 'Password';",
    'this.tokenType = "WHITESPACE";',
    'lastSignificantToken = "?InterpolationInJSX";',
    "var tokenKey = ':_authToken';",
    "if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('bad pem');",
  ].join('\n');
  assert.ok(!has(src, 'a.ts'));
  assert.ok(!has('export type TrustTokenOperationType = "Issuance" | "Redemption";', 'a.ts'));
  assert.ok(!has('type Token = "Issuance";', 'a.ts'));
});

test('hardcoded-secret filters non-credential values', () => {
  assert.ok(!has('const token = "WHITESPACE_TOKEN";'));
  assert.ok(!has('const password = "correct-horse-staple";'));
  assert.ok(!has('const token = "someCamelCaseWord";'));
  assert.ok(!has('const secret = "path.to.secret";'));
  assert.ok(!has('const token = "https://example.com/oauth/token";'));
  assert.ok(!has('const secret = "Ex ample sentence here";'));
  assert.ok(!has('const password = "password";'));
  assert.ok(!has("var token = '%[a-f0-9]{2}';"));
  assert.ok(!has('const sessionId = `pw-tab-${this.next++}`;'));
  assert.ok(!has('const secret = process.env.JWT_SECRET || "dev";'));
  assert.ok(!has('const x = cond ? token : "anonymousvalue";'));
  assert.ok(!has('const msg = "set password: \'hunter2hunter2\' in config";'));
  assert.ok(!has('declare const apiKey: "abcd1234efgh5678";', 'a.d.ts'));
  assert.ok(!has('const token = "dXNlcm5hbWU6cGFzc3dvcmQ=";', 'test/auth.js'));
});

test('hardcoded-secret flags typed declarations and env fallbacks', () => {
  assert.ok(has("const password: string = 'hunter2hunter2';", 'a.ts'));
  assert.ok(has("class C { private apiKey: string = 'abcd1234efgh5678'; }", 'a.ts'));
  assert.ok(has("const secret = process.env.JWT_SECRET || 'supersecretvalue';"));
  assert.ok(has("const apiKey = process.env.API_KEY ?? 'abcd1234efgh5678';"));
  assert.ok(has("const o = { 'client_secret': 'abcd1234efgh5678' };"));
  assert.ok(has('this.password = "hunter2hunter2";'));
});

test('hardcoded-secret detects more token and key formats', () => {
  const pat = 'github' + '_pat_' + '11ABCDEFG0' + 'a'.repeat(60);
  assert.ok(has(`const t = '${pat}';`));
  assert.ok(has("const k = '-----BEGIN PGP PRIVATE KEY BLOCK-----';"));
  assert.ok(has("const k = '-----BEGIN ENCRYPTED PRIVATE KEY-----';"));
  assert.ok(has("const k = '-----BEGIN OPENSSH PRIVATE KEY-----';"));
  assert.ok(has("const k = 'AS" + "IAABCDEFGHIJKLMNOP';"));
  assert.ok(!has('const k = "-----BEGIN PUBLIC KEY-----";'));
  // Documentation example with a placeholder body.
  assert.ok(!has('const help = `key="-----BEGIN PRIVATE KEY-----\\\\nXXXX\\\\nXXXX\\\\n-----END PRIVATE KEY-----"`;'));
});

test('hardcoded-secret detects credentials embedded in URLs', () => {
  assert.ok(has("const u = 'postgres://admin:s3cr3tpw@db.example.com/app';"));
  assert.ok(has('const u = `redis://:hunter2hunter2@cache.internal:6379`;'));
  assert.ok(!has("const u = 'https://example.com:8080/path';"));
  assert.ok(!has("const u = 'postgres://${user}:${pw}@db.example.com/app';"));
  assert.ok(!has("const u = 'postgres://user:password@localhost/app';"));
  assert.ok(!has("const doc = 'Proxy URL like https-proxy=https://user:passw0rd@proxy:1234/foo';"));
});

test('hardcoded-secret does not echo the value', () => {
  const [f] = analyzeSource("const u = 'postgres://admin:s3cr3tpw@db.example.com/app';");
  assert.ok(!f.message.includes('s3cr3tpw'));
  const [g] = analyzeSource('const apiKey = "abcd1234efgh5678";');
  assert.ok(!g.message.includes('abcd1234'));
});

test('hardcoded-secret stays fast on long runs of identifier characters', () => {
  for (const blob of ['ab12'.repeat(50000), 'a'.repeat(200000), 'a-'.repeat(100000)]) {
    const start = Date.now();
    const found = analyzeSource(`var wasm = "${blob}";\n`);
    assert.deepEqual(found, []);
    assert.ok(Date.now() - start < 1500, `took ${Date.now() - start}ms`);
  }
  const start = Date.now();
  analyzeSource(`const token = 1; var blob = "${'f'.repeat(200000)}";\n`);
  assert.ok(Date.now() - start < 1500);
});
