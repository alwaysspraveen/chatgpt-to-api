// Automatic sessions: agent frameworks resend the whole history every call.
// We remember "history so far -> ChatGPT chat" so a request whose messages
// extend a known history continues that chat and only types the new messages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { attachmentRefs, contentText, parseArgs } from './prompt.js';

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// Normalizes the parts of a message that clients echo back verbatim.
function canonical(m) {
  const role = m.role === 'developer' ? 'system' : m.role;
  const calls = (m.tool_calls || []).map((c) => [c.function?.name, sortKeys(parseArgs(c.function?.arguments))]);
  const files = attachmentRefs(m).map((r) => crypto.createHash('sha256').update(`${r.kind}:${r.src}`).digest('hex'));
  return JSON.stringify([role, contentText(m.content).trim(), calls, files]);
}

// hashes[k] identifies messages[0..k] (inclusive).
export function prefixHashes(messages) {
  let h = '';
  return messages.map((m) => (h = crypto.createHash('sha256').update(`${h}\u0000${canonical(m)}`).digest('hex')));
}

export class SessionStore {
  // `file`: where sessions are saved so they survive server restarts.
  constructor({ max = 5000, ttlMs = 24 * 60 * 60 * 1000, file = null } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.file = file;
    this.map = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const now = Date.now();
      for (const [hash, chatId, at] of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
        if (now - at <= this.ttlMs) this.map.set(hash, { chatId, at });
      }
    } catch (err) {
      console.warn(`[sessions] could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const rows = [...this.map].map(([hash, e]) => [hash, e.chatId, e.at]);
      fs.writeFile(this.file, JSON.stringify(rows), { mode: 0o600 }, (err) => {
        if (err) console.warn(`[sessions] could not save: ${err.message}`);
      });
    }, 500);
  }

  get(hash) {
    const entry = this.map.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(hash);
      return null;
    }
    return entry.chatId;
  }

  set(hash, chatId) {
    this.map.delete(hash);
    this.map.set(hash, { chatId, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.save();
  }

  // Longest known prefix of `messages` (excluding the newest message).
  match(messages) {
    const hashes = prefixHashes(messages);
    for (let k = messages.length - 2; k >= 0; k--) {
      const chatId = this.get(hashes[k]);
      if (chatId) return { chatId, seen: k + 1 };
    }
    return null;
  }

  remember(messages, reply, chatId) {
    if (!chatId) return;
    this.set(prefixHashes([...messages, reply]).at(-1), chatId);
  }
}
