// Sidebar panel: an "outbox" of drafts Claude saved for you (save_draft),
// each previewed as the message you're about to paste, with copy actions.
const crypto = require('crypto');
const { toHtml } = require('./format');

const PLATFORMS = {
  teams: { label: 'Teams', copy: 'Copy for Teams' },
  google_chat: { label: 'Google Chat', copy: 'Copy for Chat' },
  slack: { label: 'Slack', copy: 'Copy for Slack' },
  email: { label: 'Email', copy: 'Copy email' },
  plain: { label: 'Text', copy: 'Copy' },
};

class ClaudeCopyPanel {
  /**
   * @param {{ read: () => any[], remove: (id: string) => void, clear: () => void }} store
   * @param {(text: string, label: string, mode?: string) => Promise<void>} copy
   */
  constructor(store, copy) {
    this.store = store;
    this.copy = copy;
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') return this.refresh();
      const draft = this.store.read().find((d) => d.id === msg.id);
      if (msg.type === 'copy' && draft) await this.copy(draft.text, 'draft', msg.mode);
      if (msg.type === 'delete' && draft) {
        this.store.remove(draft.id);
        this.refresh();
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
  }

  refresh() {
    if (!this.view?.visible) return;
    const drafts = this.store.read().slice().reverse(); // newest first
    this.view.webview.postMessage({
      type: 'drafts',
      drafts: drafts.map((d) => {
        const key = d.platform in PLATFORMS ? d.platform : 'plain';
        const p = PLATFORMS[key];
        return {
          id: d.id,
          text: d.text,
          // Rendered preview (same converter as Copy). toHtml escapes the text.
          html: toHtml(d.text),
          title: d.title || d.text.split('\n')[0],
          platform: key,
          platformLabel: p.label,
          copyLabel: p.copy,
          created: d.created_at || 0,
        };
      }),
    });
  }

  html() {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body {
    --rail-teams: #6264a7;
    --rail-google_chat: #00ac47;
    --rail-slack: #611f69;
    --rail-email: var(--vscode-textLink-foreground);
    --rail-plain: var(--vscode-descriptionForeground);
    --edge: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border)));
  }
  body.vscode-dark { --rail-teams: #8b8cd4; --rail-slack: #b37bb9; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 12px 16px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45;
  }

  .search { position: sticky; top: 0; z-index: 2; padding: 10px 0 4px; background: var(--vscode-sideBar-background); }
  .search[hidden] { display: none; }
  .search input {
    width: 100%; padding: 5px 8px; border-radius: 3px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  .search input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .search input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  .day { margin: 14px 0 6px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  #list > .day:first-child { margin-top: 10px; }

  /* A draft: the message preview; click the message to expand it. */
  .draft {
    position: relative; margin: 0 0 10px; padding: 9px 10px 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--edge); border-radius: 6px;
  }
  .draft:focus-within { border-color: var(--vscode-focusBorder); }

  .top { display: flex; align-items: baseline; gap: 8px; }
  .title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dest { flex: none; font-size: 11px; font-weight: 600; color: var(--rail); }
  .when { font-size: 11px; color: var(--vscode-descriptionForeground); }

  .body { margin-top: 8px; max-height: 8.2em; overflow: hidden; word-break: break-word; border-radius: 3px; }
  .draft.clipped .body { cursor: pointer; }
  .body:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
  .draft.clipped:not(.open) .body {
    -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent);
            mask-image: linear-gradient(to bottom, #000 62%, transparent);
  }
  .draft.open .body { max-height: none; }
  .body p { margin: 0 0 .55em; }
  .body > :last-child { margin-bottom: 0; }
  .body ul, .body ol { margin: 0 0 .55em; padding-left: 1.3em; }
  .body li { margin: .1em 0; }
  .body pre { white-space: pre-wrap; margin: 0 0 .55em; padding: 6px 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
  .body code { font-family: var(--vscode-editor-font-family); font-size: .92em; padding: 0 3px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
  .body pre code { padding: 0; background: none; }
  .body a { color: var(--vscode-textLink-foreground); }

  button { font: inherit; cursor: pointer; border-radius: 3px; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .actions { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
  .copy {
    flex: 1; min-width: 0; padding: 5px 10px; border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .copy:hover { background: var(--vscode-button-hoverBackground); }
  .quiet { padding: 5px 8px; border: 1px solid transparent; color: var(--vscode-foreground); background: transparent; }
  .quiet:hover { background: var(--vscode-toolbar-hoverBackground); }
  .icon { display: inline-flex; align-items: center; justify-content: center; padding: 5px; }
  .icon svg { width: 16px; height: 16px; fill: currentColor; }
  .icon.danger:hover { color: var(--vscode-errorForeground); }

  /* The one motion moment: the card's border lights up once when a draft is copied. */
  .draft.copied { border-color: var(--rail); box-shadow: 0 0 0 1px var(--rail); }
  @media (prefers-reduced-motion: no-preference) { .draft { transition: border-color .4s ease-out, box-shadow .4s ease-out; } }

  .empty { padding: 16px 2px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .empty strong { color: var(--vscode-foreground); font-weight: 600; }
  .empty .example {
    margin: 8px 0; padding: 8px 10px; border-left: 3px solid var(--rail-teams); border-radius: 0 4px 4px 0;
    color: var(--vscode-foreground); background: var(--vscode-textBlockQuote-background);
  }
  .none { padding: 12px 2px; color: var(--vscode-descriptionForeground); }
</style></head>
<body>
  <div class="search" id="searchBar" hidden>
    <input id="search" type="search" placeholder="Search drafts" aria-label="Search drafts">
  </div>
  <div id="list" role="list"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const searchBar = document.getElementById('searchBar');
  const search = document.getElementById('search');
  let drafts = [];
  search.value = (vscode.getState() || {}).query || '';

  const TRASH = 'M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5zm1 2h1v5H6V6zm3 0h1v5H9V6z';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill-rule', 'evenodd');
    svg.append(p);
    return svg;
  }

  function ago(sec) {
    if (!sec) return '';
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 60) return 'Just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel(sec) {
    const d = new Date(sec * 1000), now = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  }

  function flash(card, button) {
    const old = button.textContent;
    button.textContent = 'Copied';
    card.classList.add('copied');
    setTimeout(() => { button.textContent = old; card.classList.remove('copied'); }, 1300);
  }

  function draftCard(d) {
    const card = el('article', 'draft');
    card.setAttribute('role', 'listitem');
    card.style.setProperty('--rail', 'var(--rail-' + d.platform + ')');

    const top = el('div', 'top');
    top.append(el('span', 'title', d.title), el('span', 'dest', d.platformLabel));
    const when = el('div', 'when', ago(d.created));
    if (d.created) {
      when.title = new Date(d.created * 1000).toLocaleString();
      when.dataset.created = d.created;
    }

    const body = el('div', 'body');
    body.innerHTML = d.html; // generated by toHtml(), which escapes the draft text
    // Click (or Enter/Space on) a cut-off message to expand or collapse it.
    const toggle = (e) => {
      if (!card.classList.contains('clipped') || e.target.closest('a')) return;
      if (window.getSelection().toString()) return; // don't toggle while selecting text
      body.setAttribute('aria-expanded', String(card.classList.toggle('open')));
    };
    body.addEventListener('click', toggle);
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
    });

    const actions = el('div', 'actions');
    const copy = el('button', 'copy', d.copyLabel);
    copy.title = 'Copy with formatting (bold, lists)';
    copy.onclick = () => { vscode.postMessage({ type: 'copy', id: d.id, mode: 'rich' }); flash(card, copy); };
    const plain = el('button', 'quiet', 'Plain');
    plain.title = 'Copy as plain text, without formatting';
    plain.onclick = () => { vscode.postMessage({ type: 'copy', id: d.id, mode: 'plain' }); flash(card, plain); };
    const del = el('button', 'quiet icon danger');
    del.append(icon(TRASH));
    del.title = 'Delete draft';
    del.setAttribute('aria-label', 'Delete draft: ' + d.title);
    del.onclick = () => vscode.postMessage({ type: 'delete', id: d.id });
    actions.append(copy, plain, del);

    card.append(top, when, body, actions);
    return card;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    searchBar.hidden = drafts.length < 4 && !q;
    list.replaceChildren();

    if (!drafts.length) {
      const e = el('div', 'empty');
      e.append(el('strong', null, 'No drafts yet.'), document.createElement('br'),
        document.createTextNode('Ask Claude to write a message, for example:'),
        el('div', 'example', 'Draft a Teams message telling the team the release moves to Friday'),
        document.createTextNode('It appears here, ready to copy and paste.'));
      list.append(e);
      return;
    }

    const shown = q ? drafts.filter((d) => (d.title + '\\n' + d.text).toLowerCase().includes(q)) : drafts;
    if (!shown.length) {
      list.append(el('div', 'none', 'No drafts match "' + search.value.trim() + '".'));
      return;
    }

    let lastDay = null;
    for (const d of shown) {
      const day = d.created ? dayLabel(d.created) : 'Earlier';
      if (day !== lastDay) { list.append(el('div', 'day', day)); lastDay = day; }
      list.append(draftCard(d));
    }
    // Only cut-off messages are expandable (clickable, focusable, announced as such).
    requestAnimationFrame(() => {
      document.querySelectorAll('.draft').forEach((card) => {
        const body = card.querySelector('.body');
        const clipped = body.scrollHeight > body.clientHeight + 2;
        card.classList.toggle('clipped', clipped);
        if (clipped) {
          body.tabIndex = 0;
          body.setAttribute('role', 'button');
          body.setAttribute('aria-expanded', 'false');
          body.title = 'Click to expand or collapse';
        }
      });
    });
  }

  search.addEventListener('input', () => { vscode.setState({ query: search.value }); render(); });
  window.addEventListener('message', (e) => {
    if (e.data.type !== 'drafts') return;
    drafts = e.data.drafts;
    render();
  });
  // Keep "5 min ago" fresh in place, without redrawing (keeps expanded drafts and focus).
  setInterval(() => document.querySelectorAll('.when[data-created]').forEach((w) => {
    w.textContent = ago(Number(w.dataset.created));
  }), 60000);
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

module.exports = { ClaudeCopyPanel };
