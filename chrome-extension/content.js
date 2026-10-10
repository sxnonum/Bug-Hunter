// Floating chat panel on github.com. Lives in a shadow root so GitHub's CSS cannot touch it.
(function () {
  if (window.__ghGuideLoaded) return;
  window.__ghGuideLoaded = true;

  const { pageContext } = GHGuideCore;
  const PENDING_KEY = 'ghguide:highlight';

  // ---------- highlighting the target setting on the destination page ----------
  function findByText(text) {
    const want = text.trim().toLowerCase();
    const nodes = document.querySelectorAll('h1,h2,h3,h4,label,legend,button,summary,a,[role="heading"],span,div');
    let best = null;
    for (const el of nodes) {
      if (el.children.length > 3) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length > want.length + 20) continue;
      if (t !== want && !t.startsWith(want)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!best || t === want) best = el;
      if (t === want) break;
    }
    return best;
  }

  function flash(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = '3px solid #f2cc60';
    el.style.outlineOffset = '4px';
    setTimeout(() => { el.style.outline = prev.outline; el.style.outlineOffset = prev.offset; }, 6000);
  }

  function highlightWhenReady(text) {
    let tries = 0;
    const timer = setInterval(() => {
      const el = findByText(text);
      if (el) { clearInterval(timer); flash(el); }
      else if (++tries > 20) clearInterval(timer);
    }, 300);
  }

  function consumePending() {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      sessionStorage.removeItem(PENDING_KEY);
      const { text, ts } = JSON.parse(raw);
      if (text && Date.now() - ts < 30000) highlightWhenReady(text);
    } catch { /* sessionStorage can be unavailable */ }
  }

  // ---------- UI ----------
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; right: 16px; bottom: 16px;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
      .fab { width: 44px; height: 44px; border-radius: 50%; border: 0; background: #1f6feb; color: #fff; font-size: 20px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
      .panel { display: none; width: 360px; max-width: calc(100vw - 32px); height: 480px; max-height: calc(100vh - 32px); flex-direction: column; background: #fff; color: #1f2328; border: 1px solid #d1d9e0; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.35); overflow: hidden; }
      :host(.open) .panel { display: flex; } :host(.open) .fab { display: none; }
      header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #d1d9e0; font-weight: 600; font-size: 14px; }
      header button { background: none; border: 0; cursor: pointer; font-size: 16px; color: inherit; padding: 2px 6px; }
      .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; font-size: 13px; line-height: 1.45; }
      .me { align-self: flex-end; background: #ddf4ff; border-radius: 10px 10px 2px 10px; padding: 7px 10px; max-width: 85%; }
      .bot { align-self: flex-start; background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 10px 10px 10px 2px; padding: 8px 10px; max-width: 95%; }
      .bot.err { background: #ffebe9; border-color: #ff8182; }
      .hint { color: #59636e; font-size: 12px; }
      .go { display: inline-block; margin-top: 8px; padding: 6px 10px; border-radius: 6px; background: #1f6feb; color: #fff; text-decoration: none; font-weight: 600; font-size: 12px; cursor: pointer; border: 0; }
      .go.alt { background: transparent; color: #0969da; padding-left: 0; }
      details { margin-top: 8px; font-size: 12px; } summary { cursor: pointer; color: #59636e; }
      ol { margin: 6px 0 0; padding-left: 18px; }
      form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #d1d9e0; }
      input { flex: 1; padding: 8px 10px; border: 1px solid #d1d9e0; border-radius: 6px; font-size: 13px; background: #fff; color: #1f2328; }
      form button { padding: 0 12px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-weight: 600; cursor: pointer; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #0d1117; color: #e6edf3; border-color: #3d444d; } header, form { border-color: #3d444d; }
        .me { background: #0c2d6b; } .bot { background: #151b23; border-color: #3d444d; } .bot.err { background: #3d1418; border-color: #8e2a31; }
        .hint, summary { color: #9198a1; } .go.alt { color: #4493f8; } input { background: #0d1117; color: #e6edf3; border-color: #3d444d; }
      }
    </style>
    <button class="fab" title="GitHub Guide (Alt+Shift+G)" aria-label="Open GitHub Guide">?</button>
    <section class="panel" aria-label="GitHub Guide">
      <header><span>GitHub Guide</span><span><button class="opts" title="Options">⚙</button><button class="close" title="Close">✕</button></span></header>
      <div class="log" aria-live="polite"></div>
      <form><input type="text" maxlength="500" placeholder="e.g. make this repo public" aria-label="Your question"><button>Ask</button></form>
    </section>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const log = $('.log');
  const input = $('input');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function add(node) { log.appendChild(node); log.scrollTop = log.scrollHeight; return node; }

  function toggle(force) {
    const open = force != null ? force : !host.classList.contains('open');
    host.classList.toggle('open', open);
    if (open) setTimeout(() => input.focus(), 0);
  }

  function setupLink(a, url, highlight) {
    a.href = url;
    a.addEventListener('click', (e) => {
      const target = new URL(url);
      const same = target.pathname === location.pathname && target.search === location.search;
      if (highlight) {
        if (same) { e.preventDefault(); highlightWhenReady(highlight); return; }
        try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ text: highlight, ts: Date.now() })); } catch { /* ignore */ }
      }
    });
  }

  function renderAnswer(res) {
    if (res.error === 'no-key') {
      const box = el('div', 'bot', 'Add your Claude API key first so I can answer.');
      const b = el('button', 'go', 'Open options');
      b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-options' }));
      box.append(document.createElement('br'), b);
      return add(box);
    }
    if (res.error) return add(el('div', 'bot err', res.error));

    const box = el('div', 'bot');
    box.appendChild(el('div', null, res.answer || 'No answer.'));
    if (res.task && res.url) {
      const a = el('a', 'go', 'Take me there →');
      setupLink(a, res.url, res.task.highlight);
      box.appendChild(a);
    } else if (res.task && res.missing) {
      box.appendChild(el('div', 'hint', 'Open a repository first, then ask again.'));
    }
    if (res.task && res.task.steps.length) {
      const d = el('details');
      d.appendChild(el('summary', null, 'Steps'));
      const ol = el('ol');
      res.task.steps.forEach((s) => ol.appendChild(el('li', null, s)));
      d.appendChild(ol);
      box.appendChild(d);
    }
    if (!res.task) {
      const a = el('a', 'go alt', 'Search the GitHub docs →');
      a.href = res.docs; a.target = '_blank'; a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
    return add(box);
  }

  async function ask(question) {
    add(el('div', 'me', question));
    const pending = add(el('div', 'bot hint', 'Thinking…'));
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'ask', question, ctx: pageContext(location.href) });
    } catch {
      res = { error: 'The extension was reloaded. Refresh this page and try again.' };
    }
    pending.remove();
    renderAnswer(res || { error: 'No response from the extension.' });
  }

  $('.fab').addEventListener('click', () => toggle(true));
  $('.close').addEventListener('click', () => toggle(false));
  $('.opts').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-options' }));
  shadow.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') toggle(false); });
  shadow.addEventListener('keyup', (e) => e.stopPropagation());
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    ask(q);
  });

  add(el('div', 'bot hint', 'Ask where something is on GitHub, e.g. “make this repo public” or “add a secret”.'));

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'toggle') toggle(); });

  // GitHub navigates without full reloads; check for a pending highlight on both kinds.
  consumePending();
  document.addEventListener('turbo:load', consumePending);
})();
