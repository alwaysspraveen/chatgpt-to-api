// Claude Copy: shows the messages Claude drafted for you (saved with the
// `save_draft` MCP tool) in a side panel, with one-click copy.
//
// Other extensions can't read Claude Code's chat panel, so Claude saves each
// draft to ~/.claude-copy/drafts.jsonl and this extension reads that file.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { readDrafts, deleteDraft, clearDrafts, DEFAULT_FILE } = require('./drafts');
const { toPlain, toHtml } = require('./format');
const { writeRich } = require('./clipboard');
const { ClaudeCopyPanel } = require('./panel');

let panel;
let watcher;
let lastAutoCopied = null;

const config = () => vscode.workspace.getConfiguration('claudeCopy');
const draftsFile = () => config().get('draftsFile') || DEFAULT_FILE;

const store = {
  read: () => readDrafts(draftsFile()),
  remove: (id) => deleteDraft(id, draftsFile()),
  clear: () => clearDrafts(draftsFile()),
};

// mode: 'rich' (formatted: real bold/bullets), 'plain' (no formatting) or
// 'markdown' (as written); undefined uses the claudeCopy.format setting.
async function copy(text, label, mode) {
  const m = mode ?? config().get('format') ?? 'rich';
  if (m === 'rich') {
    try {
      await writeRich(toHtml(text), toPlain(text));
    } catch {
      await vscode.env.clipboard.writeText(toPlain(text)); // non-macOS / osascript failure
    }
  } else {
    await vscode.env.clipboard.writeText(m === 'plain' ? toPlain(text) : text);
  }
  const preview = text.replace(/\s+/g, ' ').slice(0, 60);
  vscode.window.setStatusBarMessage(`$(check) Copied ${label}: ${preview}${text.length > 60 ? '…' : ''}`, 4000);
}

async function copyLastDraft() {
  const last = store.read().at(-1);
  if (!last) return vscode.window.showWarningMessage('Claude Copy: no drafts yet. Ask Claude to draft a message.');
  await copy(last.text, 'draft');
}

async function pick() {
  const drafts = store.read().slice().reverse();
  if (!drafts.length) return vscode.window.showWarningMessage('Claude Copy: no drafts yet. Ask Claude to draft a message.');
  const choice = await vscode.window.showQuickPick(
    drafts.slice(0, 30).map((d) => ({
      label: `$(mail) ${d.title || d.text.split('\n')[0]}`,
      description: d.platform || '',
      detail: d.text.replace(/\s+/g, ' ').slice(0, 120),
      d,
    })),
    { placeHolder: 'Choose a draft to copy (newest first)', matchOnDetail: true },
  );
  if (choice) await copy(choice.d.text, 'draft');
}

async function clearAll() {
  const ok = await vscode.window.showWarningMessage('Delete all saved drafts?', { modal: true }, 'Delete all');
  if (ok) {
    store.clear();
    panel?.refresh();
  }
}

// Watches the drafts file: refreshes the panel and, if enabled, auto-copies new drafts.
function setupWatcher(context) {
  watcher?.close();
  watcher = null;
  const file = draftsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  lastAutoCopied = store.read().at(-1)?.id || null;
  let timer;
  try {
    watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && name !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        panel?.refresh();
        const latest = store.read().at(-1);
        if (latest && latest.id !== lastAutoCopied) {
          lastAutoCopied = latest.id;
          if (config().get('autoCopyDrafts')) await copy(latest.text, 'new draft');
        }
      }, 250);
    });
    context.subscriptions.push({ dispose: () => watcher?.close() });
  } catch (err) {
    vscode.window.showWarningMessage(`Claude Copy: can't watch ${file}: ${err.message}`);
  }
}

function activate(context) {
  panel = new ClaudeCopyPanel(store, copy);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeCopy.panel', panel),
    vscode.commands.registerCommand('claudeCopy.copyLastDraft', copyLastDraft),
    vscode.commands.registerCommand('claudeCopy.pick', pick),
    vscode.commands.registerCommand('claudeCopy.refresh', () => panel.refresh()),
    vscode.commands.registerCommand('claudeCopy.clear', clearAll),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(copy) Drafts';
  status.tooltip = 'Claude Copy: copy a saved draft';
  status.command = 'claudeCopy.pick';
  status.show();
  context.subscriptions.push(status);

  setupWatcher(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeCopy.draftsFile')) {
      setupWatcher(context);
      panel.refresh();
    }
  }));
}

function deactivate() {
  watcher?.close();
}

module.exports = { activate, deactivate };
