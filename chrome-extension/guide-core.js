// Pure logic shared by the content script, the service worker and the tests.
(function (root) {
  const GITHUB = 'https://github.com';

  // First path segments on github.com that are not user or organization names.
  const RESERVED = new Set([
    'settings', 'orgs', 'organizations', 'notifications', 'new', 'login', 'logout', 'signup', 'join',
    'explore', 'marketplace', 'pulls', 'issues', 'codespaces', 'sponsors', 'features', 'topics',
    'collections', 'trending', 'search', 'account', 'apps', 'about', 'pricing', 'enterprise',
    'copilot', 'security', 'customer-stories', 'readme', 'site', 'contact', 'dashboard', 'stars',
    'users', 'sessions', 'password_reset', 'import', 'mobile', 'events', 'models', 'resources',
  ]);

  // "https://github.com/octo/hello/issues/3" -> { owner: "octo", repo: "hello" }
  function parseContext(href) {
    let url;
    try { url = new URL(href); } catch { return { owner: null, repo: null }; }
    if (url.hostname !== 'github.com') return { owner: null, repo: null };
    const parts = url.pathname.split('/').filter(Boolean);
    const owner = parts[0];
    if (!owner || RESERVED.has(owner.toLowerCase())) return { owner: null, repo: null };
    // /orgs/<org>/... and /organizations/<org>/... carry the org in the second segment.
    return { owner, repo: parts[1] || null };
  }

  function orgFromPath(href) {
    try {
      const parts = new URL(href).pathname.split('/').filter(Boolean);
      if ((parts[0] === 'orgs' || parts[0] === 'organizations') && parts[1]) return parts[1];
    } catch { /* fall through */ }
    return null;
  }

  // Full context for a page: owner/repo from the URL, plus org pages.
  function pageContext(href) {
    const ctx = parseContext(href);
    if (!ctx.owner) {
      const org = orgFromPath(href);
      if (org) return { owner: org, repo: null };
    }
    return ctx;
  }

  function missingFor(task, ctx) {
    if (task.scope === 'repo') return ctx.owner && ctx.repo ? null : 'repo';
    if (task.scope === 'owner') return ctx.owner ? null : 'owner';
    return null;
  }

  function buildUrl(task, ctx) {
    if (missingFor(task, ctx)) return null;
    const path = task.path
      .replace('{owner}', encodeURIComponent(ctx.owner || ''))
      .replace('{repo}', encodeURIComponent(ctx.repo || ''));
    return GITHUB + path;
  }

  function docsUrl(question) {
    return 'https://docs.github.com/en/search?query=' + encodeURIComponent(question.slice(0, 200));
  }

  function systemPrompt(catalog) {
    const lines = catalog.map((t) => `- ${t.id} [${t.scope}]: ${t.title}. ${t.description}`);
    return [
      'You are GitHub Guide, a browser helper that tells people where things are in the GitHub web interface.',
      'You are given a catalog of known tasks. Pick the single best match for the user\'s question and call the "answer" tool.',
      'Rules:',
      '- taskId must be one of the catalog ids, or null if nothing fits. Never invent ids, URLs or menu names.',
      '- "answer" is 1-3 short sentences in the SAME LANGUAGE as the question. Say what to do and where. Do not repeat a long list of steps; the app shows the catalog steps itself.',
      '- If the task needs a repository but the user is not on one, say they should open the repository first.',
      '- If nothing fits, set taskId to null and say honestly that you are not sure; suggest searching the GitHub docs.',
      '- Never claim you performed an action. You only point to where it can be done.',
      '',
      'Catalog (id [scope]: title. keywords):',
      ...lines,
    ].join('\n');
  }

  function userMessage(question, ctx) {
    const where = ctx.repo
      ? `the repository ${ctx.owner}/${ctx.repo}`
      : ctx.owner ? `the page of ${ctx.owner} (not a repository)` : 'a GitHub page that is not a repository';
    return `The user is currently on ${where}.\n\nQuestion: ${question}`;
  }

  const ANSWER_TOOL = {
    name: 'answer',
    description: 'Reply to the user with the best matching catalog task.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: ['string', 'null'], description: 'Catalog id of the best matching task, or null' },
        answer: { type: 'string', description: 'Short answer in the user\'s language' },
      },
      required: ['taskId', 'answer'],
    },
  };

  // Pull the tool call out of an Anthropic Messages API response.
  function parseResponse(data) {
    const block = data && Array.isArray(data.content) && data.content.find((b) => b.type === 'tool_use' && b.name === 'answer');
    if (block && block.input) {
      return { taskId: typeof block.input.taskId === 'string' ? block.input.taskId : null, answer: String(block.input.answer || '') };
    }
    const text = data && Array.isArray(data.content) ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    return { taskId: null, answer: text };
  }

  // Turn the model's choice into something safe to render: URL and steps come from the catalog.
  function resolve(parsed, catalog, ctx, question) {
    const task = catalog.find((t) => t.id === parsed.taskId) || null;
    if (!task) return { answer: parsed.answer, task: null, url: null, missing: null, docs: docsUrl(question) };
    const missing = missingFor(task, ctx);
    return { answer: parsed.answer, task, url: buildUrl(task, ctx), missing, docs: docsUrl(question) };
  }

  const api = { parseContext, pageContext, buildUrl, missingFor, docsUrl, systemPrompt, userMessage, ANSWER_TOOL, parseResponse, resolve };
  root.GHGuideCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
