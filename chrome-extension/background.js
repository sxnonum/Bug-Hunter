// Service worker: the only place that ever sees the API key.
importScripts('catalog.js', 'guide-core.js');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';

async function getSettings() {
  const { apiKey = '', model = DEFAULT_MODEL } = await chrome.storage.local.get(['apiKey', 'model']);
  return { apiKey: apiKey.trim(), model };
}

async function callClaude(body, apiKey) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function friendlyError(err) {
  if (err.status === 401) return 'The API key was rejected. Check it in the extension options.';
  if (err.status === 429) return 'Rate limited by the API. Try again in a moment.';
  if (err.status === 529 || err.status >= 500) return 'The API is busy right now. Try again shortly.';
  return `Request failed: ${err.message}`;
}

async function ask(question, ctx) {
  const { apiKey, model } = await getSettings();
  if (!apiKey) return { error: 'no-key' };
  try {
    const data = await callClaude({
      model,
      max_tokens: 500,
      system: [{ type: 'text', text: GHGuideCore.systemPrompt(GHGuideCatalog), cache_control: { type: 'ephemeral' } }],
      tools: [GHGuideCore.ANSWER_TOOL],
      tool_choice: { type: 'tool', name: 'answer' },
      messages: [{ role: 'user', content: GHGuideCore.userMessage(question, ctx) }],
    }, apiKey);
    const parsed = GHGuideCore.parseResponse(data);
    const r = GHGuideCore.resolve(parsed, GHGuideCatalog, ctx, question);
    return {
      answer: r.answer,
      url: r.url,
      missing: r.missing,
      docs: r.docs,
      task: r.task && { id: r.task.id, title: r.task.title, steps: r.task.steps, highlight: r.task.highlight },
    };
  } catch (err) {
    return { error: friendlyError(err) };
  }
}

async function testKey(apiKey, model) {
  try {
    await callClaude({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, apiKey.trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages and content scripts may use the key.
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'ask') {
    ask(String(msg.question || '').slice(0, 1000), msg.ctx || { owner: null, repo: null }).then(sendResponse);
    return true;
  }
  if (msg.type === 'test-key') {
    testKey(String(msg.apiKey || ''), String(msg.model || DEFAULT_MODEL)).then(sendResponse);
    return true;
  }
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => chrome.runtime.openOptionsPage());
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});
