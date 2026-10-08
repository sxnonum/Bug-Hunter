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
  const body = 'MIIEowIBAAKCAQEA' + 'x7Qm4pLz'.repeat(8);
  assert.ok(has(`const t = '${pat}';`));
  for (const kind of ['PGP PRIVATE KEY BLOCK', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY']) {
    assert.ok(has(`const k = '-----BEGIN ${kind}-----\\n${body}\\n-----END ${kind}-----\\n';`), kind);
  }
  assert.ok(has('const k = `-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----`;'));
  assert.ok(has("const k = '-----BEGIN RSA PRIVATE KEY-----\\n' +\n  '" + body + "\\n';"));
  assert.ok(has("const k = 'AS" + "IAABCDEFGHIJKLMNOP';"));
  assert.ok(has("const t = 'xoxb-123456789012-1234567890123-" + "AbCdEfGhIjKlMnOpQrStUvWx';"));
  assert.ok(!has('const k = "-----BEGIN PUBLIC KEY-----";'));
  // Documentation example with a placeholder body.
  assert.ok(!has('const help = `key="-----BEGIN PRIVATE KEY-----\\nXXXX\\nXXXX\\n-----END PRIVATE KEY-----"`;'));
});

test('hardcoded-secret needs key material after a PEM header', () => {
  const body = 'MIIEowIBAAKCAQEA' + 'x7Qm4pLz'.repeat(8);
  for (const src of [
    "const HEADER = '-----BEGIN PRIVATE KEY-----';",
    "const HEADERS = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----'];",
    'function toPem(b64) { return `-----BEGIN PRIVATE KEY-----\\n${b64}\\n-----END PRIVATE KEY-----\\n`; }',
    "const pem = '-----BEGIN PRIVATE KEY-----\\n' + b64 + '\\n-----END PRIVATE KEY-----';",
    "if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('bad');",
    "const pem = '-----BEGIN PRIVATE KEY-----' + '\\n' + b64;",
  ]) {
    assert.ok(!has(src), src);
  }
  assert.ok(has("const pem = '-----BEGIN PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,0123\\n\\n" + body + "';"));
});

test('hardcoded-secret skips documented placeholder tokens', () => {
  assert.ok(!has("const example = 'AKIAIOSFODNN7EXAMPLE';"));
  assert.ok(!has("console.log('usage: tool --token ghp_" + 'x'.repeat(36) + "');"));
  assert.ok(!has("console.log('usage: tool --token ghp_" + '*'.repeat(36) + "');"));
  assert.ok(!has("const help = 'SLACK_BOT_TOKEN=xoxb-your-bot-token-here';"));
  assert.ok(!has("const help = 'SLACK_BOT_TOKEN=xoxb-1234-5678-" + "xxxxxxxxxxxx';"));
  assert.ok(!has("const t = 'xoxb-not-a-real-token-but-long-enough';"));
  assert.ok(has("const t = 'ghp_" + 'a'.repeat(36) + "';"));
});

test('hardcoded-secret finds format-based secrets in comments', () => {
  const body = 'MIIEowIBAAKCAQEA' + 'x7Qm4pLz'.repeat(8);
  assert.ok(has('// const key = "AKIAIOSFODNN7ABCDEFG";'));
  assert.ok(has('/* old token: ghp_' + 'a'.repeat(36) + ' */'));
  assert.ok(has('// xo' + 'xb-123456789012-abcdefghijklmnop'));
  assert.ok(has('// postgres://admin:hunter2pw@db.internal/app'));
  assert.ok(has('/*\n-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----\n*/'));
  assert.ok(has('/**\n * -----BEGIN RSA PRIVATE KEY-----\n * ' + body + '\n */'));
  // Placeholders in documentation are still skipped, and the name-based rule ignores comments.
  assert.ok(!has('// const key = "AKIAIOSFODNN7EXAMPLE";'));
  assert.ok(!has('// e.g. http://user:pass@host/ and redis://:secret@host and mongodb://myUser:myPassword@host'));
  assert.ok(!has('// const password = "Zx81qLm4pQ";'));
  assert.ok(!has('// the header is -----BEGIN PRIVATE KEY----- followed by base64'));
});

test('hardcoded-secret exempts test files by their path inside the scan root only', () => {
  const src = "const password = 'Zx81qLm4pQ';";
  const flagged = (file, relFile) => analyzeSource(src, { file, relFile }).some((f) => f.rule === 'hardcoded-secret');
  assert.ok(!flagged('/proj/test/a.js', 'test/a.js'));
  assert.ok(!flagged('/proj/src/a.test.js', 'src/a.test.js'));
  assert.ok(!flagged('/proj/cypress/e2e/login.cy.ts', 'cypress/e2e/login.cy.ts'));
  assert.ok(!flagged('/proj/src/Login.stories.tsx', 'src/Login.stories.tsx'));
  assert.ok(!flagged('/proj/src/__fixtures__/user.js', 'src/__fixtures__/user.js'));
  // Directories above the scan root do not count.
  assert.ok(flagged('/home/me/test/proj/src/a.js', 'src/a.js'));
  assert.ok(flagged('/home/runner/work/spec/spec/src/a.js', 'src/a.js'));
  assert.ok(flagged('C:\\Users\\me\\spec\\proj\\a.js', 'a.js'));
  // Without a relFile the path as given is used.
  assert.ok(!analyzeSource(src, { file: 'test/a.js' }).some((f) => f.rule === 'hardcoded-secret'));
  // Format-based secrets are still found in tests.
  assert.ok(analyzeSource("const k = 'AS" + "IAABCDEFGHIJKLMNOP';", { file: '/p/test/a.js', relFile: 'test/a.js' }).length > 0);
});

test('hardcoded-secret ignores routes, rules, cookie names, enums and translated words', () => {
  for (const src of [
    "const API = { login: '/api/v1/login', token: '/api/v1/token' };",
    "const rules = { password: 'required', token: 'string|required' };",
    "const es = { password: 'Contrase\u00f1a' };",
    "const sv = { password: 'L\u00f6senord' };",
    "const nl = { password: 'wachtwoord' };",
    "const SESSION_KEY = 'app.session.v2';",
    "const csrf = 'csrftoken';",
    "const session = 'sessionid';",
    "const store = { token: './token.json', secret: '../secret' };",
    "const names = { apiKey: 'api_key_v2', secretKey: 'SECRET_KEY' };",
    "const messages = { password: 'Enter your password', secret: 'Secret is required' };",
    'const x = { token: "1.2.3", session: "10.0.0.1" };',
  ]) {
    assert.ok(!has(src, 'a.js'), src);
  }
  assert.ok(!has("export enum Cookie { RefreshToken = 'refreshtoken', CsrfToken = 'csrf-token' }", 'a.ts'));
});

test('hardcoded-secret recognises credential shapes and common names', () => {
  const positives = [
    "createTransport({ auth: { user: 'a@b.c', pass: 'Zx81qLm4pQ' } });",
    "const dbPass = 'Zx81qLm4pQ';",
    "process.env.DB_PASS = 'Zx81qLm4pQ';",
    "const pwd = 'Zx81qLm4pQ';",
    "const password = 'hunter2';",
    "const o = { password: '123456' };",
    "app.use(session({ secret: 'keyboard cat' }));",
    "cfg['password'] = 'Zx81qLm4pQ';",
    "const password =\n  'Zx81qLm4pQ';",
    "const o = {\n  secret:\n    'Zx81qLm4pQ',\n};",
    "const stripeSecretKey = process.env.STRIPE_API_KEY || 'sk_" + 'li' + "ve_4eC39HqLyjWDarjtT1zdp7dc';",
    "const apiKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';",
    "const jwtSecret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';",
    'const config = { clientSecret: `Zx81qLm4pQ-ab` };',
    "const adminPassword = 'p@ssw0rd!';",
    "this.refreshToken = 'a1b2c3d4e5f6a7b8c9d0';",
    "const secret = process.env.JWT_SECRET || 'supersecretvalue';",
  ];
  for (const src of positives) assert.ok(has(src), src);
  // Short passwords only count when the name is exactly password-like.
  assert.ok(!has("const dbPassword = 'abc123';"));
  assert.ok(!has("const apiKey = 'abc12';"));
  // A phrase is not a passphrase when it reads like a label or a sentence.
  assert.ok(!has("const o = { password: 'Mot de passe' };"));
  assert.ok(!has("const o = { secret: 'the quick brown fox' };"));
  assert.ok(!has("const o = { secret: 'Please try again' };"));
  assert.ok(!has("const o = { token: 'two words' };")); // spaces only for password/secret names
  // pass/pw names, but not words that merely end in them.
  assert.ok(isSecretName('pass') && isSecretName('userPass') && isSecretName('db_pw'));
  assert.ok(!isSecretName('bypass') && !isSecretName('compass') && !isSecretName('passed'));
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
