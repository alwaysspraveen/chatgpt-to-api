// Holds the WebSocket to the local server and runs jobs on a pool of
// chatgpt.com tabs: each open tab is one worker that handles one job at a time.
const DEFAULT_SERVER = 'ws://127.0.0.1:8765/bridge';
const CHATGPT_URL = 'https://chatgpt.com/*';

let ws = null;
let reconnectTimer = null;
const state = {
  enabled: true,
  connection: 'disconnected', // disconnected | connecting | connected | stopped
  completed: 0,
  lastError: null,
};
// tabId -> { url, jobId, activity, startedAt, chars, ticker }
const workers = new Map();
const jobTab = new Map(); // jobId -> tabId

async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return serverUrl || DEFAULT_SERVER;
}

function snapshot() {
  return {
    ...state,
    workers: [...workers.entries()].map(([tabId, w]) => ({
      tabId, jobId: w.jobId, activity: w.activity, startedAt: w.startedAt, chars: w.chars,
    })),
  };
}

function update(patch = {}) {
  Object.assign(state, patch);
  const busy = [...workers.values()].filter((w) => w.jobId).length;
  const badge = !state.enabled ? 'OFF' : state.connection !== 'connected' ? '' : busy ? String(busy) : 'ON';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: !state.enabled ? '#888888' : busy ? '#e8a33d' : '#10a37f' });
  chrome.runtime.sendMessage({ type: 'state', state: snapshot() }).catch(() => {});
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reportCapacity() {
  sendToServer({ type: 'capacity', tabs: workers.size });
}

// --- Tab pool ----------------------------------------------------------------
async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL });
  const ids = new Set(tabs.map((t) => t.id));
  for (const t of tabs) {
    const w = workers.get(t.id);
    if (w) w.url = t.url;
    else workers.set(t.id, { url: t.url, jobId: null, activity: 'idle', startedAt: null, chars: 0, ticker: null });
  }
  for (const [tabId, w] of workers) {
    if (ids.has(tabId)) continue;
    if (w.jobId) failJob(w.jobId, 'The ChatGPT tab running this request was closed');
    workers.delete(tabId);
  }
  reportCapacity();
  update();
}

let refreshTimer = null;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshTabs, 200);
};
chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) scheduleRefresh(); });

// Synchronous so two jobs arriving together never pick the same tab.
function claimTab(jobId, conversationId) {
  const free = [...workers.entries()].filter(([, w]) => !w.jobId);
  if (free.length === 0) return null;
  const onChat = (url) => (url || '').includes(`/c/${conversationId}`);
  const isHome = (url) => /^https:\/\/chatgpt\.com\/?(\?.*)?$/.test(url || '');
  const pick = (conversationId && free.find(([, w]) => onChat(w.url)))
    || free.find(([, w]) => isHome(w.url))
    || free[0];
  const [tabId, w] = pick;
  Object.assign(w, { jobId, activity: 'sending', startedAt: Date.now(), chars: 0 });
  jobTab.set(jobId, tabId);
  // Hidden tabs throttle their own timers; ticking from here keeps polling fast.
  w.ticker = setInterval(() => chrome.tabs.sendMessage(tabId, { type: 'tick' }).catch(() => {}), 100);
  update();
  return tabId;
}

function releaseJob(jobId, patch = {}) {
  const tabId = jobTab.get(jobId);
  jobTab.delete(jobId);
  const w = workers.get(tabId);
  if (w && w.jobId === jobId) {
    clearInterval(w.ticker);
    Object.assign(w, { jobId: null, activity: 'idle', startedAt: null, chars: 0, ticker: null });
  }
  update(patch);
}

function failJob(jobId, message) {
  sendToServer({ type: 'error', id: jobId, message });
  releaseJob(jobId, { lastError: message });
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return;
  } catch {}
  // Tab was opened before the extension loaded: inject the content script.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, msg);
}

// Loads a chatgpt.com URL in the tab and waits until its content script is ready.
async function openUrl(tabId, url, activity) {
  const w = workers.get(tabId);
  if (w) w.activity = activity;
  update();
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out loading ${url}`));
    }, 30_000);
    function listener(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  await chrome.tabs.update(tabId, { url });
  await loaded;
  if (w) w.url = url;
  for (let i = 0; i < 20; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'noop' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function runJob(msg) {
  const tabId = claimTab(msg.id, msg.conversationId);
  if (tabId === null) {
    sendToServer({ type: 'requeue', id: msg.id });
    reportCapacity();
    return;
  }
  try {
    // Use the tab's real URL; the cached one can lag behind in-app navigation.
    const tab = await chrome.tabs.get(tabId);
    workers.get(tabId).url = tab.url;
    if (msg.conversationId && !(tab.url || '').includes(`/c/${msg.conversationId}`)) {
      await openUrl(tabId, `https://chatgpt.com/c/${msg.conversationId}`, 'opening chat');
    } else if (msg.newChat && msg.model) {
      // A new chat on a specific model: ChatGPT reads ?model= when the page loads.
      await openUrl(tabId, `https://chatgpt.com/?model=${encodeURIComponent(msg.model)}`, 'opening chat');
    }
    await sendToTab(tabId, msg);
  } catch (err) {
    failJob(msg.id, err.message);
  }
}

// --- Server connection -------------------------------------------------------
async function connect() {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled === false || !state.enabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const url = await serverUrl();
  update({ connection: 'connecting' });
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    update({ connection: 'disconnected', lastError: `Bad server URL: ${err.message}` });
    return;
  }
  ws = socket;
  socket.onopen = async () => {
    update({ connection: 'connected' });
    await refreshTabs();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    for (const jobId of [...jobTab.keys()]) releaseJob(jobId, { lastError: 'Server connection lost during a request' });
    update({ connection: state.enabled ? 'disconnected' : 'stopped' });
    if (state.enabled) reconnectTimer = setTimeout(connect, 3000);
  };
  socket.onerror = () => {};
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'ping') {
      sendToServer({ type: 'pong' });
    } else if (msg.type === 'job') {
      runJob(msg);
    } else if (msg.type === 'cancel') {
      const tabId = jobTab.get(msg.id);
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, msg).catch(() => {});
        releaseJob(msg.id);
      }
    }
  };
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled });
  update({ enabled });
  if (enabled) {
    connect();
    return;
  }
  clearTimeout(reconnectTimer);
  await cancelAll('Bridge stopped from the extension');
  const socket = ws;
  ws = null;
  socket?.close();
  update({ connection: 'stopped' });
}

async function cancelAll(reason = 'Cancelled from the extension') {
  for (const [jobId, tabId] of [...jobTab.entries()]) {
    chrome.tabs.sendMessage(tabId, { type: 'cancel', id: jobId }).catch(() => {});
    failJob(jobId, reason);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'getState':
      sendResponse({ state: snapshot() });
      return;
    case 'setEnabled':
      setEnabled(Boolean(msg.enabled));
      return;
    case 'cancelCurrent':
      cancelAll();
      return;
    case 'reconnect':
      ws?.close();
      ws = null;
      connect();
      return;
    case 'ready':
      scheduleRefresh();
      connect();
      return;
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined || jobTab.get(msg?.id) !== tabId) return;
  const w = workers.get(tabId);
  if (msg.type === 'phase') {
    w.activity = msg.phase;
    update();
  } else if (msg.type === 'delta') {
    sendToServer(msg);
    w.activity = 'streaming';
    w.chars = msg.text.length;
    update();
  } else if (msg.type === 'done') {
    sendToServer(msg);
    if (msg.chatId) w.url = `https://chatgpt.com/c/${msg.chatId}`;
    releaseJob(msg.id, { completed: state.completed + 1, lastError: null });
  } else if (msg.type === 'error') {
    sendToServer(msg);
    releaseJob(msg.id, { lastError: msg.message });
  }
});

async function init() {
  const { enabled } = await chrome.storage.local.get('enabled');
  update({ enabled: enabled !== false, connection: enabled === false ? 'stopped' : state.connection });
  await refreshTabs();
  connect();
}

// Service workers get suspended; alarms bring us back to reconnect.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
init();
