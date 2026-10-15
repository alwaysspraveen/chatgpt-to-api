// Reads and edits the drafts Claude saves with the chatgpt-drafts MCP's
// `save_draft` tool (one JSON object per line).
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.claude-copy', 'drafts.jsonl');

function readDrafts(file = DEFAULT_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const drafts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d.text === 'string' && d.id) drafts.push(d);
    } catch {}
  }
  return drafts; // oldest first
}

function deleteDraft(id, file = DEFAULT_FILE) {
  const kept = readDrafts(file).filter((d) => d.id !== id);
  fs.writeFileSync(file, kept.map((d) => JSON.stringify(d)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
}

function clearDrafts(file = DEFAULT_FILE) {
  fs.writeFileSync(file, '', { mode: 0o600 });
}

module.exports = { DEFAULT_FILE, readDrafts, deleteDraft, clearDrafts };
