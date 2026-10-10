const $ = (id) => document.getElementById(id);
const COLORS = { ok: '#10a37f', warn: '#e8a33d', bad: '#d9534f', muted: '#888' };
const ACTIVITY = {
  sending: 'Typing prompt…',
  'opening chat': 'Opening chat…',
  waiting: 'Waiting for ChatGPT…',
  streaming: 'Receiving reply',
  cancelling: 'Stopping…',
};

let current = null;
let ticker = null;

function elapsed(since) {
  const s = Math.floor((Date.now() - since) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function render(state) {
  current = state;
  const workers = state.workers || [];
  const busy = workers.filter((w) => w.jobId);

  const pill = !state.enabled ? ['STOPPED', COLORS.muted]
    : state.connection !== 'connected' ? ['OFFLINE', COLORS.bad]
    : workers.length === 0 ? ['NO TABS', COLORS.bad]
    : busy.length ? [`BUSY ${busy.length}/${workers.length}`, COLORS.warn]
    : ['READY', COLORS.ok];
  $('pill').textContent = pill[0];
  $('pill').style.background = pill[1];

  const conn = { connected: ['Connected', COLORS.ok], connecting: ['Connecting…', COLORS.warn], disconnected: ['Not reachable, retrying', COLORS.bad], stopped: ['Stopped', COLORS.muted] }[state.connection] || [state.connection, COLORS.muted];
  $('conn').textContent = conn[0];
  $('connDot').style.background = conn[1];

  $('tabs').textContent = workers.length === 0
    ? 'Open chatgpt.com'
    : `${busy.length} busy / ${workers.length} open (${workers.length} parallel)`;

  const list = $('workers');
  list.replaceChildren(...workers.map((w, i) => {
    const div = document.createElement('div');
    div.className = w.jobId ? 'worker' : 'worker idle';
    let text = `Tab ${i + 1}: `;
    if (!w.jobId) {
      text += 'idle';
    } else {
      text += ACTIVITY[w.activity] || w.activity;
      if (w.activity === 'streaming') text += ` (${w.chars} chars)`;
      if (w.startedAt) text += ` · ${elapsed(w.startedAt)}`;
    }
    div.textContent = text;
    return div;
  }));

  $('completed').textContent = String(state.completed);
  $('error').hidden = !state.lastError;
  $('error').textContent = state.lastError ? `Last error: ${state.lastError}` : '';

  $('toggle').textContent = state.enabled ? 'Stop bridge' : 'Start bridge';
  $('toggle').className = state.enabled ? 'stop' : 'start';
  $('cancel').disabled = busy.length === 0;

  clearInterval(ticker);
  if (busy.length) ticker = setInterval(() => render(current), 1000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'state') render(msg.state);
});

$('toggle').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'setEnabled', enabled: !current?.enabled });
});
$('cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancelCurrent' }));
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: $('url').value.trim() });
  chrome.runtime.sendMessage({ type: 'reconnect' });
});

chrome.storage.local.get('serverUrl').then(({ serverUrl }) => {
  $('url').value = serverUrl || 'ws://127.0.0.1:8765/bridge';
});
chrome.runtime.sendMessage({ type: 'getState' }).then(({ state }) => render(state));
