const $ = (id) => document.getElementById(id);
const status = (text, cls) => { $('status').textContent = text; $('status').className = cls || ''; };

chrome.storage.local.get(['apiKey', 'model']).then(({ apiKey, model }) => {
  if (apiKey) $('key').value = apiKey;
  if (model) $('model').value = model;
});

$('save').addEventListener('click', async () => {
  const apiKey = $('key').value.trim();
  if (apiKey && !apiKey.startsWith('sk-ant-')) return status('That does not look like an Anthropic key (sk-ant-...).', 'err');
  await chrome.storage.local.set({ apiKey, model: $('model').value });
  status('Saved.', 'ok');
});

$('test').addEventListener('click', async () => {
  const apiKey = $('key').value.trim();
  if (!apiKey) return status('Enter a key first.', 'err');
  status('Testing...');
  const res = await chrome.runtime.sendMessage({ type: 'test-key', apiKey, model: $('model').value });
  res.ok ? status('The key works.', 'ok') : status(res.error, 'err');
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  $('key').value = '';
  status('Key removed.', 'ok');
});
