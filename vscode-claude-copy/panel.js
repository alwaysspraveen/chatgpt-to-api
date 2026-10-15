// Sidebar panel: drafts Claude saved for you (save_draft), with copy buttons.
const vscode = require('vscode');
const crypto = require('crypto');
const { toHtml } = require('./format');

const PLATFORM_LABEL = { teams: 'Teams', google_chat: 'Google Chat', slack: 'Slack', email: 'Email', plain: 'Text' };

class ClaudeCopyPanel {
  /**
   * @param {{ read: () => any[], remove: (id: string) => void, clear: () => void }} store
   * @param {(text: string, label: string, plain?: boolean) => Promise<void>} copy
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
      drafts: drafts.map((d) => ({
        id: d.id,
        text: d.text,
        // Rendered preview (same converter as Copy). toHtml escapes the text.
        html: toHtml(d.text),
        title: d.title || d.text.split('\n')[0],
        platform: PLATFORM_LABEL[d.platform] || d.platform || '',
        when: d.created_at ? new Date(d.created_at * 1000).toLocaleString() : '',
      })),
    });
  }

  html() {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { padding: 4px 8px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .meta { opacity: .7; font-size: 11px; padding: 4px 2px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 8px 0; background: var(--vscode-editor-background); }
  .head { display: flex; align-items: baseline; gap: 6px; padding: 7px 8px 0; }
  .title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .when { font-size: 10px; opacity: .6; padding: 2px 8px 0; }
  .text { word-break: break-word; padding: 6px 8px; max-height: 9em; overflow: hidden; line-height: 1.5; cursor: pointer; }
  .text p { margin: 0 0 .6em; }
  .text ul, .text ol { margin: 0 0 .6em; padding-left: 1.4em; }
  .text li { margin: .1em 0; }
  .text pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; margin: 0 0 .6em; }
  .text code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .text a { color: var(--vscode-textLink-foreground); }
  .card.open .text { max-height: none; }
  .actions { display: flex; gap: 6px; padding: 0 8px 8px; }
  .actions button { flex: 1; padding: 4px 6px; border: none; border-radius: 4px; cursor: pointer; font: inherit;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .actions button.del { flex: 0 0 auto; }
  .actions button:hover { filter: brightness(1.1); }
  .empty { opacity: .75; padding: 16px 4px; line-height: 1.6; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
  <div class="meta" id="meta"></div>
  <div id="list"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = onClick;
    return b;
  }

  function render(drafts) {
    document.getElementById('meta').textContent = drafts.length ? drafts.length + ' draft' + (drafts.length > 1 ? 's' : '') + ' · newest first' : '';
    list.replaceChildren();
    if (!drafts.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = 'No drafts yet.<br>Ask Claude to write a message, e.g. <i>"Draft a Teams message to the team that the release moves to Friday"</i>. Claude saves it here with <code>save_draft</code>.';
      list.append(e);
      return;
    }
    for (const d of drafts) {
      const card = document.createElement('div');
      card.className = 'card';
      const head = document.createElement('div');
      head.className = 'head';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = d.title;
      head.append(title);
      if (d.platform) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = d.platform;
        head.append(badge);
      }
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = d.when;
      const text = document.createElement('div');
      text.className = 'text';
      text.innerHTML = d.html;
      text.title = 'Click to expand';
      text.onclick = () => card.classList.toggle('open');
      const actions = document.createElement('div');
      actions.className = 'actions';
      const copy = (mode, label, cls) => button(label, cls, (ev) => {
        vscode.postMessage({ type: 'copy', id: d.id, mode });
        const b = ev.currentTarget, old = b.textContent;
        b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = old), 1200);
      });
      actions.append(
        copy('rich', 'Copy', 'primary'),
        copy('plain', 'Copy plain'),
        button('🗑', 'del', () => vscode.postMessage({ type: 'delete', id: d.id })),
      );
      card.append(head, when, text, actions);
      list.append(card);
    }
  }

  window.addEventListener('message', (e) => { if (e.data.type === 'drafts') render(e.data.drafts); });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

module.exports = { ClaudeCopyPanel };
