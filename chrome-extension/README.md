# GitHub Guide

A Chrome extension that answers "where is X on GitHub?". Type *"make this repo public"* and it gives you a short answer plus a button that opens the right settings page and outlines the exact control.

You bring your own Claude API key. There is no server: the extension talks to the Anthropic API directly from your browser.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's **Options**, paste your Claude API key (`sk-ant-...`), click **Test key**, then **Save**.
3. Go to any page on github.com and click the **?** button (or press `Alt+Shift+G`).

## How it works

- `catalog.js` is a hand-written list of ~45 common GitHub tasks: title, keywords, URL template, steps and the text to highlight on the destination page.
- The model gets the catalog plus the owner/repo from the current URL and must call a single `answer` tool with a `taskId` from the catalog and a short reply in your language.
- **URLs and steps always come from the catalog, never from the model.** An id the model invents is ignored and you get a link to the GitHub docs search instead.
- The extension only points. It never clicks anything for you, destructive actions included.

## Privacy

- Your API key lives in `chrome.storage.local` (this browser only, not synced) and is read only by the service worker (`background.js`), never by the content script running on github.com.
- What is sent to Anthropic: your question and the owner/repository name from the page URL. No page content, code or GitHub tokens.

## Develop

```
npm test        # catalog validation, URL building, response parsing (node:test, no dependencies)
```

Add a task by appending an entry to `catalog.js`; the tests check ids, scopes, paths and placeholders.

## Layout

| File | Role |
|---|---|
| `manifest.json` | Manifest V3, permissions: `storage`, host `api.anthropic.com` |
| `catalog.js` | Task catalog |
| `guide-core.js` | Pure logic: context parsing, prompt, response handling |
| `background.js` | Service worker, calls the API |
| `content.js` | Chat panel (shadow DOM) and highlighting |
| `options.html` / `options.js` | API key and model settings |

## Ideas for later

- "Why is CI red?" using the failing job log
- PR summaries
- Swedish/other-language UI strings
- Move to its own repository and publish to the Chrome Web Store
