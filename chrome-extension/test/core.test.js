const test = require('node:test');
const assert = require('node:assert/strict');
const CATALOG = require('../catalog.js');
const core = require('../guide-core.js');

test('catalog entries are well formed', () => {
  const ids = new Set();
  for (const t of CATALOG) {
    assert.ok(t.id && !ids.has(t.id), `duplicate or missing id: ${t.id}`);
    ids.add(t.id);
    assert.ok(['repo', 'owner', 'global'].includes(t.scope), `${t.id}: bad scope`);
    assert.ok(t.title && t.description, `${t.id}: needs title and description`);
    assert.ok(t.path.startsWith('/'), `${t.id}: path must start with /`);
    assert.ok(Array.isArray(t.steps) && t.steps.length > 0, `${t.id}: needs steps`);
    assert.ok(t.highlight === null || typeof t.highlight === 'string', `${t.id}: highlight must be string or null`);
    const placeholders = t.path.match(/\{[a-z]+\}/g) || [];
    for (const p of placeholders) assert.ok(['{owner}', '{repo}'].includes(p), `${t.id}: unknown placeholder ${p}`);
    if (t.scope === 'repo') assert.ok(t.path.includes('{owner}') && t.path.includes('{repo}'), `${t.id}: repo scope needs both`);
    if (t.scope === 'global') assert.equal(placeholders.length, 0, `${t.id}: global path has placeholders`);
  }
});

test('parseContext reads owner and repo from github URLs', () => {
  assert.deepEqual(core.parseContext('https://github.com/octo/hello'), { owner: 'octo', repo: 'hello' });
  assert.deepEqual(core.parseContext('https://github.com/octo/hello/issues/3?q=1'), { owner: 'octo', repo: 'hello' });
  assert.deepEqual(core.parseContext('https://github.com/octo'), { owner: 'octo', repo: null });
  assert.deepEqual(core.parseContext('https://github.com/'), { owner: null, repo: null });
  assert.deepEqual(core.parseContext('https://github.com/settings/profile'), { owner: null, repo: null });
  assert.deepEqual(core.parseContext('https://example.com/octo/hello'), { owner: null, repo: null });
  assert.deepEqual(core.parseContext('not a url'), { owner: null, repo: null });
});

test('pageContext finds the organization on /orgs pages', () => {
  assert.deepEqual(core.pageContext('https://github.com/orgs/acme/people'), { owner: 'acme', repo: null });
  assert.deepEqual(core.pageContext('https://github.com/organizations/acme/settings/profile'), { owner: 'acme', repo: null });
  assert.deepEqual(core.pageContext('https://github.com/octo/hello'), { owner: 'octo', repo: 'hello' });
});

test('buildUrl fills placeholders and refuses when context is missing', () => {
  const vis = CATALOG.find((t) => t.id === 'repo-visibility');
  assert.equal(core.buildUrl(vis, { owner: 'octo', repo: 'hello' }), 'https://github.com/octo/hello/settings');
  assert.equal(core.buildUrl(vis, { owner: null, repo: null }), null);
  assert.equal(core.buildUrl(vis, { owner: 'octo', repo: null }), null);
  const org = CATALOG.find((t) => t.id === 'org-people');
  assert.equal(core.buildUrl(org, { owner: 'acme', repo: null }), 'https://github.com/orgs/acme/people');
  const glob = CATALOG.find((t) => t.id === 'new-repo');
  assert.equal(core.buildUrl(glob, { owner: null, repo: null }), 'https://github.com/new');
});

test('buildUrl encodes path segments', () => {
  const vis = CATALOG.find((t) => t.id === 'repo-visibility');
  assert.equal(core.buildUrl(vis, { owner: 'a/b', repo: 'c d' }), 'https://github.com/a%2Fb/c%20d/settings');
});

test('every catalog URL stays on github.com', () => {
  const ctx = { owner: 'octo', repo: 'hello' };
  for (const t of CATALOG) assert.equal(new URL(core.buildUrl(t, ctx)).origin, 'https://github.com', t.id);
});

test('parseResponse extracts the tool call', () => {
  const data = { content: [{ type: 'tool_use', name: 'answer', input: { taskId: 'repo-visibility', answer: 'Go to Settings.' } }] };
  assert.deepEqual(core.parseResponse(data), { taskId: 'repo-visibility', answer: 'Go to Settings.' });
  assert.deepEqual(core.parseResponse({ content: [{ type: 'text', text: 'hmm' }] }), { taskId: null, answer: 'hmm' });
  assert.deepEqual(core.parseResponse(null), { taskId: null, answer: '' });
});

test('resolve ignores task ids the model invented', () => {
  const ctx = { owner: 'octo', repo: 'hello' };
  const r = core.resolve({ taskId: 'made-up-id', answer: 'x' }, CATALOG, ctx, 'how do I do a thing?');
  assert.equal(r.task, null);
  assert.equal(r.url, null);
  assert.ok(r.docs.startsWith('https://docs.github.com/'));
});

test('resolve reports missing repo context instead of building a bad link', () => {
  const r = core.resolve({ taskId: 'repo-visibility', answer: 'x' }, CATALOG, { owner: null, repo: null }, 'make public');
  assert.equal(r.url, null);
  assert.equal(r.missing, 'repo');
  assert.ok(r.task);
});

test('system prompt lists every catalog id', () => {
  const prompt = core.systemPrompt(CATALOG);
  for (const t of CATALOG) assert.ok(prompt.includes(t.id), t.id);
});
