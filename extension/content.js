// Runs inside chatgpt.com: types the prompt, sends it, and streams the reply back.
// ChatGPT's DOM changes often; if something breaks, update SELECTORS first.
{
const SELECTORS = {
  input: '#prompt-textarea, div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], form textarea',
  send: '[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label^="Send"]',
  stop: '[data-testid="stop-button"], button[aria-label^="Stop"]',
  // Action buttons that only appear under a finished reply.
  finished: '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], button[aria-label="Good response"]',
  newChat: '[data-testid="create-new-chat-button"], a[aria-label="New chat"], button[aria-label="New chat"], a[href="/"]',
  assistant: '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]',
  replyBody: '[data-markdown-text-style="assistant-message"], .markdown',
  attachments: '[data-composer-attachments]',
  uploading: '[role="progressbar"], .animate-spin, [aria-busy="true"]',
};

const SCRIPT_VERSION = 'v15-files';
const POLL_MS = 150;
const STABLE_POLLS = 10; // fallback: ~1.5s with no change and no stop button => done
const FAST_STABLE_POLLS = 2; // once ChatGPT signals it's finished, confirm briefly
const START_TIMEOUT_MS = 60_000;

let current = null; // { id, cancelled }


const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// ChatGPT keeps inactive views mounted, so only count what's actually on screen.
const isVisible = (el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
const visible = (sel) => $$(sel).filter(isVisible);
const $ = (sel) => visible(sel)[0] || null;
// Hidden tabs get their timers throttled to >=1s, so the background worker
// sends ticks while a job runs and sleepers wake on whichever comes first.
const sleepers = new Set();
const sleep = (ms) => new Promise((resolve) => {
  const s = { until: Date.now() + ms, resolve };
  sleepers.add(s);
  setTimeout(() => { if (sleepers.delete(s)) resolve(); }, ms);
});
function wakeSleepers() {
  const now = Date.now();
  for (const s of sleepers) {
    if (s.until <= now) {
      sleepers.delete(s);
      s.resolve();
    }
  }
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label} | ${pageDiagnostics()}`);
}

// Summarizes what's on the page so selector breakage can be diagnosed from the API error.
function pageDiagnostics() {
  const short = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const tid = el.dataset?.testid ? `[data-testid=${el.dataset.testid}]` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}${tid}`;
  };
  const editors = $$('textarea, [contenteditable="true"]').map(short).slice(0, 5);
  const testids = [...new Set($$('[data-testid]').map((e) => e.dataset.testid))].filter((t) => /send|stop|composer|prompt|chat|login/i.test(t)).slice(0, 15);
  const roles = `${visible(SELECTORS.assistant).length} visible / ${$$(SELECTORS.assistant).length} total`;
  const turns = $$('article, [data-testid^="conversation-turn"], [data-turn]').length;
  const buttons = $$('button[aria-label]').map((b) => b.getAttribute('aria-label')).filter((l) => /send|stop|voice|new chat/i.test(l)).slice(0, 8);
  return `script=${SCRIPT_VERSION} attachments=${attachmentCount()} url=${location.pathname} visible=${document.visibilityState} editors=[${editors.join(', ')}] roles=[${roles}] turns=${turns} buttons=[${buttons.join(', ')}] testids=[${testids.join(', ')}]`;
}

function report(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- DOM -> Markdown ---------------------------------------------------------
function toMarkdown(root) {
  const walk = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    const kids = (d = depth) => Array.from(el.childNodes).map((n) => walk(n, d)).join('');

    if (['button', 'svg', 'style', 'script', 'img'].includes(tag)) return '';
    if (el.hidden || el.classList.contains('sr-only')) return '';
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${kids().trim()}\n\n`;

    switch (tag) {
      case 'pre': {
        const code = el.querySelector('code');
        const lang = (code?.className.match(/language-([\w+#-]+)/) || [])[1] || '';
        const body = (code ?? el).textContent.replace(/\n$/, '');
        return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
      }
      case 'code': {
        // ChatGPT's newer code blocks aren't wrapped in <pre>; multi-line code is a block.
        const body = el.textContent.replace(/\n$/, '');
        if (!body.includes('\n')) return `\`${body}\``;
        const lang = (el.className.match(/language-([\w+#-]+)/) || [])[1] || '';
        return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
      }
      case 'strong': case 'b': return `**${kids()}**`;
      case 'em': case 'i': return `*${kids()}*`;
      case 'a': return `[${kids()}](${el.getAttribute('href') || ''})`;
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'p': return `\n\n${kids()}\n\n`;
      case 'blockquote':
        return `\n\n${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'ul': case 'ol': {
        const items = Array.from(el.children).filter((c) => c.tagName === 'LI');
        const start = Number(el.getAttribute('start') || 1);
        const lines = items.map((li, i) => {
          const marker = tag === 'ol' ? `${start + i}. ` : '- ';
          const text = Array.from(li.childNodes).map((n) => walk(n, depth + 1)).join('').trim().replace(/\n{2,}/g, '\n');
          return '  '.repeat(depth) + marker + text;
        });
        return `\n${lines.join('\n')}\n`;
      }
      case 'table': {
        const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
          `| ${Array.from(tr.children).map((c) => walk(c).trim().replace(/\|/g, '\\|')).join(' | ')} |`);
        if (rows.length === 0) return '';
        const cols = el.querySelector('tr').children.length;
        rows.splice(1, 0, `| ${Array(cols).fill('---').join(' | ')} |`);
        return `\n\n${rows.join('\n')}\n\n`;
      }
      default: return kids();
    }
  };
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

function replyText(el) {
  return toMarkdown(el.querySelector(SELECTORS.replyBody) || el);
}

// --- Composer ----------------------------------------------------------------
function insertPrompt(input, text) {
  input.focus();
  if (input instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // ProseMirror contenteditable: execCommand goes through its input handling.
  const range = document.createRange();
  range.selectNodeContents(input);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, text);
}

// --- Attachments & options ----------------------------------------------------
function attachmentBox() {
  return $$(SELECTORS.attachments).find((el) => !el.hidden) || null;
}

function attachmentCount() {
  const box = attachmentBox();
  if (!box) return 0;
  return Math.max(box.querySelectorAll('img').length, box.children.length);
}

function toFile(f, i) {
  const bin = atob(f.data);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return new File([bytes], f.name || `file-${i + 1}`, { type: f.mime || 'application/octet-stream' });
}

// Uploads images and files into the composer, trying the same routes a user
// would: paste, then drag-and-drop, then the hidden file picker. Then waits
// until ChatGPT has finished uploading/processing them.
async function attachFiles(input, files) {
  if (!files?.length) return;
  const make = () => {
    const dt = new DataTransfer();
    files.map(toFile).forEach((f) => dt.items.add(f));
    return dt;
  };
  const target = attachmentCount() + files.length;
  const attached = (ms) => waitFor(() => attachmentCount() >= target, ms, 'files to attach').then(() => true, () => false);

  input.focus();
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: make(), bubbles: true, cancelable: true }));
  let ok = await attached(3_000);

  if (!ok) {
    const dt = make();
    const zone = input.closest('form') || input;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    ok = await attached(3_000);
  }

  if (!ok) {
    const onlyImages = files.every((f) => (f.mime || '').startsWith('image/'));
    const inputs = $$('input[type="file"]');
    const fileInput = inputs.find((el) => !el.accept)
      || (onlyImages && inputs.find((el) => /image/.test(el.accept)))
      || inputs[0];
    if (!fileInput) throw new Error(`Could not attach files | ${pageDiagnostics()}`);
    fileInput.files = make().files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    ok = await attached(15_000);
    if (!ok) throw new Error(`Could not attach files | ${pageDiagnostics()}`);
  }
  await sleep(500);
  await waitFor(() => !attachmentBox()?.querySelector(SELECTORS.uploading), 180_000, 'file upload to finish');
}

// ChatGPT's "Think" toggle in the composer (used for reasoning_effort).
function setThink(on) {
  if (on !== true && on !== false) return;
  const btn = visible('button[aria-pressed]').find((b) => /^\s*think\s*$/i.test(b.textContent));
  if (btn && (btn.getAttribute('aria-pressed') === 'true') !== on) btn.click();
}

async function submit(input, waitMs = 500) {
  try {
    const send = await waitFor(() => {
      const b = $(SELECTORS.send);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, waitMs, 'send button');
    send.click();
  } catch {
    // No recognizable send button: press Enter in the editor instead.
    input.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
}

async function startNewChat() {
  if (location.pathname === '/' && visible(SELECTORS.assistant).length === 0) return;
  const btn = $(SELECTORS.newChat);
  if (!btn) return;
  btn.click();
  // Best effort: proceed even if the old view lingers; new replies are
  // detected by element identity, not by count.
  await waitFor(() => location.pathname === '/' && visible(SELECTORS.assistant).length === 0 && $(SELECTORS.input), 5_000, 'new chat')
    .catch(() => {});
  await sleep(400);
}

// --- Job ---------------------------------------------------------------------
async function runJob({ id, text, newChat, conversationId, files, maxChars, stop, think }) {
  if (current) throw new Error('ChatGPT tab is busy with another request');
  current = { id, cancelled: false };
  const job = current;
  const t0 = Date.now();
  const timing = {};
  const mark = (name) => { timing[name] = Date.now() - t0; };
  try {
    if (newChat) await startNewChat();
    if (conversationId) {
      const onChat = () => location.pathname.includes(`/c/${conversationId}`);
      // Try in-app navigation via the sidebar link before giving up.
      if (!onChat()) $(`a[href$="/c/${conversationId}"]`)?.click();
      await waitFor(onChat, 10_000, 'conversation').catch(() => {
        throw new Error(`Could not open conversation ${conversationId} (tab is on ${location.pathname})`);
      });
      // Wait for the existing messages to render so we only type the newest one.
      await waitFor(() => visible(SELECTORS.assistant).length > 0, 15_000, 'conversation to load').catch(() => {});
    }

    const input = await waitFor(() => $(SELECTORS.input), 10_000, 'prompt input');
    mark('ready');
    if (newChat) setThink(think);
    const before = new Set($$(SELECTORS.assistant));
    const newReply = () => visible(SELECTORS.assistant).filter((el) => !before.has(el)).at(-1) || null;
    await attachFiles(input, files);
    if (text) insertPrompt(input, text);

    // With attachments, the send button stays disabled until uploads settle.
    mark('typed');
    await submit(input, files?.length ? 60_000 : 500);
    mark('sent');
    report({ type: 'phase', id, phase: 'waiting' });

    const reply = await waitFor(() => {
      if (job.cancelled) throw new Error('Cancelled');
      return newReply();
    }, START_TIMEOUT_MS, 'ChatGPT to start replying');
    mark('replyStarted');

    let last = '';
    let stable = 0;
    let sawStop = false;
    while (!job.cancelled) {
      await sleep(POLL_MS);
      const el = newReply() || reply;
      const text = replyText(el);
      const generating = Boolean($(SELECTORS.stop));
      sawStop ||= generating;
      // max_tokens / stop: stop generating as soon as the limit is reached.
      const limitHit = (maxChars && text.length > maxChars * 1.1 + 20) || (stop || []).some((s) => text.includes(s));
      if (limitHit) {
        if (generating) $(SELECTORS.stop)?.click();
        last = text;
        report({ type: 'delta', id, text });
        break;
      }
      if (text !== last) {
        if (!timing.firstText && text) mark('firstText');
        last = text;
        stable = 0;
        report({ type: 'delta', id, text });
      } else if (!generating && text) {
        stable += 1;
        const signalled = sawStop || Boolean(el.querySelector(SELECTORS.finished));
        if (stable >= (signalled ? FAST_STABLE_POLLS : STABLE_POLLS)) break;
      }
    }
    if (job.cancelled) throw new Error('Cancelled');
    const chatId = (location.pathname.match(/\/c\/([\w-]+)/) || [])[1] || null;
    mark('done');
    report({ type: 'done', id, text: last, chatId, source: 'dom', timing });
  } finally {
    if (current === job) current = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'tick') {
    wakeSleepers();
  } else if (msg?.type === 'job') {
    runJob(msg).catch((err) => report({ type: 'error', id: msg.id, message: err.message }));
  } else if (msg?.type === 'cancel' && current?.id === msg.id) {
    current.cancelled = true;
    $(SELECTORS.stop)?.click();
  }
});

report({ type: 'ready' });
}
