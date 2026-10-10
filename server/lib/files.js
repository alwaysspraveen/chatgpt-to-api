// Minimal OpenAI Files API (/v1/files) so clients that upload first and then
// reference a `file_id` (e.g. Google ADK via LiteLLM) can attach files.
// Files are kept in memory for 24 hours.
import crypto from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 200;

export class FileStore {
  constructor() {
    this.files = new Map();
  }

  add({ filename, mime, buffer, purpose }) {
    this.prune();
    const id = `file-${crypto.randomBytes(12).toString('hex')}`;
    this.files.set(id, { id, filename, mime, buffer, purpose, created_at: Math.floor(Date.now() / 1000) });
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value);
    return this.meta(id);
  }

  get(id) {
    this.prune();
    return this.files.get(id) || null;
  }

  meta(id) {
    const f = this.files.get(id);
    if (!f) return null;
    return {
      id: f.id, object: 'file', bytes: f.buffer.length, created_at: f.created_at,
      filename: f.filename, purpose: f.purpose, status: 'processed',
    };
  }

  list() {
    this.prune();
    return [...this.files.keys()].map((id) => this.meta(id));
  }

  delete(id) {
    return this.files.delete(id);
  }

  prune() {
    const cutoff = Date.now() / 1000 - TTL_MS / 1000;
    for (const [id, f] of this.files) if (f.created_at < cutoff) this.files.delete(id);
  }
}

// Parses multipart/form-data into { fields, files: [{ name, filename, mime, buffer }] }.
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Expected multipart/form-data with a boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  const files = [];
  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break; // closing boundary
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const headers = buffer.slice(start + 2, headerEnd).toString('utf8');
    const body = buffer.slice(headerEnd + 4, next - 2); // strip trailing CRLF
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] || '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim();
    if (name !== undefined) {
      if (filename !== undefined) files.push({ name, filename, mime, buffer: body });
      else fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}
