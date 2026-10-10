import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { applyLimits, buildContinuation, buildFullPrompt, contentText, estimateTokens, imageUrls, parseReply, toolsActive } from './lib/prompt.js';
import { SessionStore } from './lib/sessions.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8765);
const API_KEY = process.env.API_KEY || `sk-local-${crypto.randomBytes(18).toString('hex')}`;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_BODY_BYTES = 50 * 1024 * 1024; // images arrive base64-encoded
const MODEL_ID = 'chatgpt-web';

const sessions = new SessionStore({ file: new URL('./sessions.json', import.meta.url).pathname });

// ---------------------------------------------------------------------------
// Bridge: one extension connection; each open chatgpt.com tab is a worker,
// so up to `capacity` jobs run in parallel (one per tab).
// ---------------------------------------------------------------------------
let bridge = null;
let capacity = 0;
const queue = [];
const running = new Map(); // job id -> job

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const chatBusy = (chatId) =>
  Boolean(chatId) && [...running.values(), ...queue].some((j) => j.conversationId === chatId);

function enqueue(job) {
  job.t = { queued: Date.now() };
  job.timer = setTimeout(() => finish(job.id, new Error('Timed out waiting for ChatGPT')), JOB_TIMEOUT_MS);
  queue.push(job);
  pump();
}

function pump() {
  if (!bridge) return;
  while (running.size < capacity) {
    // Never run two jobs in the same ChatGPT chat at once.
    const busy = new Set([...running.values()].map((j) => j.conversationId).filter(Boolean));
    const i = queue.findIndex((j) => !j.conversationId || !busy.has(j.conversationId));
    if (i === -1) return;
    const [job] = queue.splice(i, 1);
    running.set(job.id, job);
    job.t.sent = Date.now();
    send(bridge, {
      type: 'job', id: job.id, text: job.text, newChat: job.newChat, conversationId: job.conversationId,
      images: job.images, maxChars: job.maxChars, stop: job.stop,
      // Model and Think mode can only be chosen when a chat starts.
      think: job.newChat ? job.think : null, model: job.newChat ? job.chatModel : null,
    });
  }
}

function finish(id, err, result) {
  let job = running.get(id);
  if (job) {
    running.delete(id);
  } else {
    const i = queue.findIndex((j) => j.id === id);
    if (i === -1) return;
    [job] = queue.splice(i, 1);
  }
  // A remembered chat that can't be reopened: start a new chat instead.
  if (err && job.fallbackText && /Could not open conversation/.test(err.message)) {
    console.log(`[job] session chat ${job.conversationId} unavailable, retrying in a new chat`);
    Object.assign(job, {
      mode: 'new (fallback)', newChat: true, conversationId: null,
      text: job.fallbackText, images: job.fallbackImages || [], fallbackText: null,
    });
    delete job.t.sent;
    queue.unshift(job);
    pump();
    return;
  }
  clearTimeout(job.timer);
  const t = job.t;
  const ms = (a, b) => (a && b ? `${b - a}ms` : '-');
  console.log(`[job] ${err ? `error (${err.message.split(' | ')[0]})` : 'done'} mode=${job.mode} queued=${ms(t.queued, t.sent)} first-text=${ms(t.sent, t.first)} total=${ms(t.queued, Date.now())}`);
  // In-tab breakdown (ms since the tab got the job): ready -> typed -> sent -> replyStarted -> firstText -> done
  if (job.tab) {
    const { source, ...steps } = job.tab;
    console.log(`      tab: ${Object.entries(steps).map(([k, v]) => `${k}=${v}`).join(' ')} via=${source}`);
  }
  if (err) {
    if (t.sent) send(bridge, { type: 'cancel', id });
    job.reject(err);
  } else {
    job.resolve(result);
  }
  pump();
}

function onBridgeMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'capacity') {
    capacity = Math.max(0, Number(msg.tabs) || 0);
    pump();
    return;
  }
  const job = running.get(msg.id);
  if (!job) return;
  if ((msg.type === 'delta' || msg.type === 'done') && !job.t.first) job.t.first = Date.now();
  if (msg.type === 'delta' && typeof msg.text === 'string') {
    job.onText?.(msg.text);
  } else if (msg.type === 'done' && typeof msg.text === 'string') {
    job.onText?.(msg.text);
    job.tab = msg.timing && typeof msg.timing === 'object' ? { ...msg.timing, source: msg.source } : null;
    finish(msg.id, null, { text: msg.text, chatId: typeof msg.chatId === 'string' ? msg.chatId : null });
  } else if (msg.type === 'requeue') {
    // The extension had no free tab after all; try again when one frees up.
    running.delete(job.id);
    delete job.t.sent;
    queue.unshift(job);
    capacity = Math.max(running.size, 0);
  } else if (msg.type === 'error') {
    finish(msg.id, new Error(String(msg.message || 'Extension error')));
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function apiError(res, status, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type } });
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Request parameters. The web app has no sampling controls, so each OpenAI
// parameter is either applied for real, approximated, or accepted and ignored.
// ---------------------------------------------------------------------------
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function parseParams(body) {
  const fail = (error) => ({ error });
  if (body.modalities?.includes?.('audio') || body.audio) return fail('Audio input/output is not supported');

  let stop = body.stop ?? null;
  if (typeof stop === 'string') stop = [stop];
  if (stop !== null && (!Array.isArray(stop) || stop.length > 4 || !stop.every((x) => typeof x === 'string' && x.length > 0))) {
    return fail('`stop` must be a string or an array of up to 4 non-empty strings');
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? null;
  if (maxTokens !== null && !(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 200_000)) {
    return fail('`max_tokens` must be a positive integer');
  }

  const n = body.n ?? 1;
  if (!(Number.isInteger(n) && n >= 1 && n <= 4)) return fail('`n` must be an integer from 1 to 4');

  for (const [k, lo, hi] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]]) {
    if (body[k] !== undefined && body[k] !== null && !num(body[k], lo, hi)) return fail(`\`${k}\` must be a number between ${lo} and ${hi}`);
  }

  // reasoning_effort maps onto ChatGPT's "Think" toggle for new chats.
  const effort = body.reasoning_effort ?? null;
  if (effort !== null && !['none', 'minimal', 'low', 'medium', 'high'].includes(effort)) {
    return fail('`reasoning_effort` must be one of none, minimal, low, medium, high');
  }
  const think = effort === null ? null : ['medium', 'high'].includes(effort);

  // Any model other than the default selects that ChatGPT model slug for new chats.
  let chatModel = null;
  if (typeof body.model === 'string' && body.model !== MODEL_ID && body.model !== '') {
    if (!/^[\w.-]{1,64}$/.test(body.model)) return fail('`model` must be a ChatGPT model slug such as "gpt-5"');
    chatModel = body.model;
  }

  return {
    n,
    think,
    chatModel,
    opts: {
      tools: body.tools,
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
      responseFormat: body.response_format,
      temperature: body.temperature,
      topP: body.top_p,
      frequencyPenalty: body.frequency_penalty,
      presencePenalty: body.presence_penalty,
      maxTokens,
      stop,
    },
  };
}

// ---------------------------------------------------------------------------
// Images: data: URLs are decoded, http(s) URLs fetched; then uploaded in the tab.
// ---------------------------------------------------------------------------
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function resolveImage(url) {
  const data = url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (data) return { mime: data[1], data: data[2].replace(/\s/g, '') };
  if (!/^https?:\/\//i.test(url)) throw new Error('Images must be data:image/... base64 URLs or http(s) URLs');
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  } catch (err) {
    throw new Error(`Could not download image: ${err.message}`);
  }
  if (!resp.ok) throw new Error(`Could not download image: HTTP ${resp.status}`);
  const mime = (resp.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) throw new Error(`URL is not an image (content-type ${mime || 'unknown'})`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image is larger than 20 MB');
  return { mime, data: buf.toString('base64') };
}

const imagesOf = (messages) => messages.flatMap(imageUrls).slice(-MAX_IMAGES);
// Images for a new chat: only those in the messages that actually get typed.
const newChatImages = (messages) => {
  if (process.env.REPLAY_HISTORY === '1') return imagesOf(messages);
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  return imagesOf(messages.slice(lastAssistant + 1));
};

// ---------------------------------------------------------------------------
// Deciding which ChatGPT chat a request goes to and what gets typed.
//   conversation_id -> continue that chat, type messages after the last assistant turn
//   new_chat: true  -> new chat with the full prompt
//   otherwise       -> continue the chat whose history this request extends
//                      (automatic agent sessions), else a new chat
// ---------------------------------------------------------------------------
function plan(body, opts, { allowSession = true } = {}) {
  const { messages } = body;
  const newChat = body.new_chat === true || body.new === true;
  const conversationId = body.conversation_id ?? null;
  if (conversationId !== null && (typeof conversationId !== 'string' || !/^[\w-]{1,100}$/.test(conversationId))) {
    return { error: '`conversation_id` must be an id returned by a previous response' };
  }
  if (conversationId && newChat) return { error: 'Use either `conversation_id` or `new_chat`, not both' };

  const fresh = () => ({
    mode: 'new', newChat: true, conversationId: null, text: buildFullPrompt(messages, opts), imageUrls: newChatImages(messages),
  });
  if (newChat || !allowSession) return fresh();

  if (conversationId) {
    let lastAssistant = -1;
    messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
    const tail = messages.slice(lastAssistant + 1).filter((m) => m.role !== 'system' && m.role !== 'developer');
    if (tail.length === 0) return { error: 'Nothing new to send: the last message is from the assistant' };
    return { mode: 'explicit', newChat: false, conversationId, text: buildContinuation(messages, tail, opts), imageUrls: imagesOf(tail) };
  }

  const hit = sessions.match(messages);
  // A busy chat means a parallel branch of the same history: give it its own chat.
  if (hit && !chatBusy(hit.chatId)) {
    const tail = messages.slice(hit.seen);
    return {
      mode: 'session', newChat: false, conversationId: hit.chatId,
      text: buildContinuation(messages, tail, opts), imageUrls: imagesOf(tail),
      fallbackText: buildFullPrompt(messages, opts), fallbackImageUrls: newChatImages(messages),
    };
  }
  return fresh();
}

// ---------------------------------------------------------------------------
// /v1/chat/completions
// ---------------------------------------------------------------------------
async function chatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return apiError(res, err.status || 400, err.status ? err.message : 'Invalid JSON body');
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return apiError(res, 400, '`messages` must be a non-empty array');
  }
  if (!body.messages.every((m) => m && typeof m.role === 'string')) {
    return apiError(res, 400, 'Every message needs a `role`');
  }
  if (body.messages.at(-1).role === 'assistant') {
    return apiError(res, 400, 'The last message must not be from the assistant');
  }

  const params = parseParams(body);
  if (params.error) return apiError(res, 400, params.error);
  const { opts, n } = params;

  // Choice 0 may continue a session; extra choices (n > 1) each need their own new chat.
  const routes = [];
  for (let i = 0; i < n; i++) {
    const route = plan(body, opts, { allowSession: i === 0 });
    if (route.error) return apiError(res, 400, route.error);
    if (!route.text.trim() && route.imageUrls.length === 0) return apiError(res, 400, 'No text or image content found in messages');
    routes.push(route);
  }
  if (!bridge) {
    return apiError(res, 503, 'Browser extension is not connected. Open chatgpt.com with the extension enabled.', 'service_unavailable');
  }
  if (capacity === 0 && running.size === 0) {
    return apiError(res, 503, 'No chatgpt.com tab is open in the browser.', 'service_unavailable');
  }

  // Decode/download each distinct image once.
  const images = new Map();
  try {
    const urls = new Set(routes.flatMap((r) => [...r.imageUrls, ...(r.fallbackImageUrls || [])]));
    await Promise.all([...urls].map(async (u) => images.set(u, await resolveImage(u))));
  } catch (err) {
    return apiError(res, 400, err.message);
  }
  const pick = (urls) => (urls || []).map((u, i) => ({ ...images.get(u), name: `image-${i + 1}` }));

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : MODEL_ID;
  const stream = body.stream === true;
  const promptTokens = estimateTokens(body.messages.map((m) => contentText(m.content)).join('\n'));
  const meta = { id, created, model, system_fingerprint: 'chatgpt-web' };

  const jobs = routes.map((route, index) => {
    const job = {
      id: n === 1 ? id : `${id}-${index}`,
      index,
      ...route,
      images: pick(route.imageUrls),
      fallbackImages: route.fallbackText ? pick(route.fallbackImageUrls) : null,
      maxChars: opts.maxTokens ? opts.maxTokens * 4 : null,
      stop: opts.stop,
      think: params.think,
      chatModel: params.chatModel,
    };
    job.done = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    return job;
  });
  res.on('close', () => {
    if (!res.writableEnded) for (const j of jobs) finish(j.id, new Error('Client disconnected'));
  });

  // Reply text -> OpenAI message, with max_tokens/stop applied.
  const finalize = ({ text, chatId }, index) => {
    const parsed = parseReply(text, opts);
    const message = { role: 'assistant', content: parsed.content };
    let finishReason = 'stop';
    if (parsed.toolCalls) {
      message.tool_calls = parsed.toolCalls;
      finishReason = 'tool_calls';
    } else {
      const limited = applyLimits(parsed.content, opts);
      message.content = limited.text;
      if (limited.reason === 'length') finishReason = 'length';
    }
    if (index === 0) sessions.remember(body.messages, message, chatId);
    return { chatId, message, finishReason, completionTokens: estimateTokens(text) };
  };
  const usageOf = (results) => {
    const completion = results.reduce((a, r) => a + r.completionTokens, 0);
    return { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion };
  };
  const failOthers = (err) => { for (const j of jobs) finish(j.id, err); };

  if (!stream) {
    jobs.forEach(enqueue);
    try {
      const results = await Promise.all(jobs.map(async (j) => finalize(await j.done, j.index)));
      return json(res, 200, {
        ...meta, object: 'chat.completion', conversation_id: results[0].chatId,
        choices: results.map((r, index) => ({ index, message: r.message, finish_reason: r.finishReason, logprobs: null })),
        usage: usageOf(results),
      });
    } catch (err) {
      failOthers(err);
      if (!res.headersSent) apiError(res, 502, err.message, 'upstream_error');
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const event = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (index, delta, finish_reason = null, extra = {}) =>
    event({ ...meta, object: 'chat.completion.chunk', ...extra, choices: [{ index, delta, finish_reason, logprobs: null }] });

  // Plain replies stream as they grow. With tools, wait until the start of the
  // reply shows whether it's a tool call (JSON) or normal text, and stream only
  // the latter. JSON mode is always sent whole once it can be parsed.
  const jsonOnly = ['json_object', 'json_schema'].includes(opts.responseFormat?.type);
  const streamChoice = async (job) => {
    const i = job.index;
    let mode = jsonOnly ? 'buffer' : toolsActive(opts) ? 'undecided' : 'stream';
    let sent = '';
    chunk(i, { role: 'assistant', content: '' });
    job.onText = (raw) => {
      let text = applyLimits(raw.replace(/^\s*ASSISTANT:\s*/i, ''), opts).text;
      // Hold back a tail that could be the start of a stop sequence.
      let hold = 0;
      for (const st of opts.stop || []) {
        for (let k = Math.min(st.length - 1, text.length); k > hold; k--) {
          if (text.endsWith(st.slice(0, k))) { hold = k; break; }
        }
      }
      text = text.slice(0, text.length - hold);
      if (mode === 'undecided') {
        const head = text.trimStart();
        if (/^(```|`|\{|\[|json\b|copy code)/i.test(head) || head.includes('tool_calls')) {
          mode = 'buffer';
          return;
        }
        if (head.length < 12) return;
        mode = 'stream';
      }
      // ChatGPT re-renders markdown as it streams; only forward append-only growth.
      if (mode === 'stream' && text.startsWith(sent) && text.length > sent.length) {
        chunk(i, { content: text.slice(sent.length) });
        sent = text;
      }
    };
    enqueue(job);
    const r = finalize(await job.done, i);
    if (r.message.tool_calls) {
      chunk(i, { tool_calls: r.message.tool_calls.map((c, index) => ({ index, id: c.id, type: 'function', function: c.function })) });
    } else if (!sent) {
      chunk(i, { content: r.message.content });
    } else if (r.message.content.startsWith(sent) && r.message.content.length > sent.length) {
      chunk(i, { content: r.message.content.slice(sent.length) });
    }
    chunk(i, {}, r.finishReason, { conversation_id: r.chatId });
    return r;
  };

  try {
    const results = await Promise.all(jobs.map(streamChoice));
    if (body.stream_options?.include_usage) {
      event({ ...meta, object: 'chat.completion.chunk', choices: [], usage: usageOf(results) });
    }
  } catch (err) {
    failOthers(err);
    event({ error: { message: err.message, type: 'upstream_error' } });
  }
  if (!res.writableEnded) res.end('data: [DONE]\n\n');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      extensionConnected: Boolean(bridge),
      tabs: capacity,
      running: running.size,
      queued: queue.length,
      sessions: sessions.map.size,
    });
  }
  if (!url.pathname.startsWith('/v1/')) return apiError(res, 404, 'Not found');
  if (!authorized(req)) return apiError(res, 401, 'Invalid API key', 'authentication_error');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'local-bridge' }] });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return chatCompletions(req, res).catch((err) => {
      if (!res.headersSent) apiError(res, 500, err.message, 'server_error');
      else res.end();
    });
  }
  return apiError(res, 404, 'Not found');
});

// Only browser extensions may connect as the bridge; web pages send their own
// origin and can't impersonate a chrome-extension:// origin.
const wss = new WebSocketServer({
  server,
  path: '/bridge',
  maxPayload: 8 * 1024 * 1024,
  verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
});

wss.on('connection', (ws) => {
  if (bridge) bridge.close(4000, 'Replaced by a newer connection');
  bridge = ws;
  capacity = 1; // until the extension reports its tab count
  console.log('[bridge] extension connected');
  ws.on('message', (data) => onBridgeMessage(data.toString()));
  ws.on('close', () => {
    if (bridge !== ws) return;
    bridge = null;
    capacity = 0;
    console.log('[bridge] extension disconnected');
    for (const id of [...running.keys()]) finish(id, new Error('Extension disconnected'));
  });
  pump();
});

// Keeps the extension's MV3 service worker alive while connected.
setInterval(() => send(bridge, { type: 'ping' }), 20_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`ChatGPT bridge API listening on http://${HOST}:${PORT}/v1`);
  console.log(`API key: ${API_KEY}${process.env.API_KEY ? ' (from API_KEY env)' : ' (generated; set API_KEY to keep it fixed)'}`);
});
