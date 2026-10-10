// Turns OpenAI-style requests into text ChatGPT can follow, and parses its
// replies back into OpenAI-style messages (including emulated tool calls).
import crypto from 'node:crypto';

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

// Attachments in a message: images and files, as { kind, src, filename }.
//   {type: "image_url", image_url: {url}}            (also "input_image")
//   {type: "file", file: {file_data, filename}}      (also "input_file"; file_data
//                                                     may be a data: URL, raw base64 or http(s) URL)
export function attachmentRefs(m) {
  if (!Array.isArray(m?.content)) return [];
  const refs = [];
  for (const part of m.content) {
    if (part?.type === 'image_url' || part?.type === 'input_image') {
      const src = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof src === 'string' && src) refs.push({ kind: 'image', src, filename: null });
    } else if (part?.type === 'file' || part?.type === 'input_file') {
      const f = part.type === 'file' ? part.file || {} : part;
      if (f.file_id && !f.file_data) refs.push({ kind: 'file_id', src: f.file_id, filename: f.filename || null });
      const src = f.file_data || f.file_url || f.url;
      if (typeof src === 'string' && src) refs.push({ kind: 'file', src, filename: f.filename || null });
    }
  }
  return refs;
}

export function parseArgs(args) {
  if (typeof args !== 'string') return args ?? {};
  try { return JSON.parse(args); } catch { return args; }
}

const isSystem = (m) => m.role === 'system' || m.role === 'developer';

// ChatGPT likes to answer some questions (weather, places, stocks, images) with
// visual widgets instead of text, which an API caller can't use.
const PLAIN_TEXT = process.env.PLAIN_TEXT !== '0';
const STYLE_RULE = '[Response style]\nAnswer in plain text (Markdown is fine). Do not use widgets, cards, maps, charts, images, canvas, or web search.';
const STYLE_REMINDER = '(Plain text only: no widgets, cards, images or web search.)';

function functionTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t?.type === 'function' && typeof t.function?.name === 'string')
    .map((t) => t.function);
}

// Maps tool_call_id -> tool name so tool results can be labelled.
function toolNames(messages) {
  const names = new Map();
  for (const m of messages) {
    for (const c of m.tool_calls || []) if (c?.id) names.set(c.id, c.function?.name);
  }
  return names;
}

function renderToolCalls(calls) {
  const payload = { tool_calls: calls.map((c) => ({ name: c.function?.name, arguments: parseArgs(c.function?.arguments) })) };
  return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function renderMessage(m, names) {
  const text = contentText(m.content);
  switch (m.role) {
    case 'user': {
      const n = attachmentRefs(m).length;
      return `USER:\n${text}${n ? `\n[${n} attachment${n > 1 ? 's' : ''}]` : ''}`;
    }
    case 'assistant': {
      const parts = [text, m.tool_calls?.length ? renderToolCalls(m.tool_calls) : ''].filter(Boolean);
      return `ASSISTANT:\n${parts.join('\n')}`;
    }
    case 'tool':
      return `TOOL RESULT (${names.get(m.tool_call_id) || m.name || 'tool'}, id ${m.tool_call_id || '?'}):\n${text}`;
    case 'function':
      return `TOOL RESULT (${m.name || 'tool'}):\n${text}`;
    case 'system':
    case 'developer':
      return `SYSTEM:\n${text}`;
    default:
      return `${String(m.role).toUpperCase()}:\n${text}`;
  }
}

export function toolsActive({ tools, toolChoice }) {
  return functionTools(tools).length > 0 && toolChoice !== 'none';
}

function toolInstructions({ tools, toolChoice, parallelToolCalls }) {
  if (!toolsActive({ tools, toolChoice })) return '';
  const list = functionTools(tools).map((f) =>
    `- ${f.name}: ${f.description || '(no description)'}\n  parameters: ${JSON.stringify(f.parameters || { type: 'object', properties: {} })}`).join('\n');

  let rule = 'Call a tool only when you need it; otherwise answer normally in plain text.';
  if (toolChoice === 'required') rule = 'You MUST call at least one tool in this reply.';
  else if (toolChoice?.type === 'function' && toolChoice.function?.name) rule = `You MUST call the tool "${toolChoice.function.name}" in this reply.`;

  return `[Tools]
You are the reasoning engine of an automated agent. You cannot run these tools yourself: you request them, the system runs them and sends back the results.
Available tools:
${list}

To call tools, reply with ONLY a JSON code block in exactly this shape and no other text:
\`\`\`json
{"tool_calls": [{"name": "<tool name>", "arguments": {}}]}
\`\`\`
${parallelToolCalls === false ? 'Call at most one tool per reply.' : 'You may put several independent calls in the array.'}
Arguments must be valid JSON matching the tool's parameters schema.
Results arrive in a later message as "TOOL RESULT" blocks; use them to continue.
${rule}
Never invent tool results, and do not use your own built-in tools (web search, code execution, image generation); use only the tools listed above.`;
}

function formatInstructions(responseFormat) {
  if (responseFormat?.type === 'json_object') {
    return '[Output format]\nReply with a single valid JSON object only: no prose, no explanations.';
  }
  if (responseFormat?.type === 'json_schema') {
    const schema = responseFormat.json_schema?.schema ?? {};
    return `[Output format]\nReply with a single valid JSON value only (no prose) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  }
  return '';
}

const jsonMode = (rf) => rf?.type === 'json_object' || rf?.type === 'json_schema';

// The web app has no sampling controls; these are best-effort style hints.
function styleHints({ temperature, topP, frequencyPenalty, presencePenalty }) {
  const hints = [];
  const t = typeof temperature === 'number' ? temperature : typeof topP === 'number' ? topP : null;
  if (t !== null && t <= 0.3) hints.push('Be precise, factual and consistent. Avoid creative variation and embellishment.');
  if (t !== null && t >= 1.2) hints.push('Be creative and varied; unexpected ideas are welcome.');
  if (frequencyPenalty >= 0.5) hints.push('Avoid repeating the same words and phrases.');
  if (presencePenalty >= 0.5) hints.push('Bring in new points rather than restating earlier ones.');
  return hints.length ? `[Style]\n${hints.join(' ')}` : '';
}

function lengthHint({ maxTokens }) {
  if (!maxTokens) return '';
  const words = Math.max(5, Math.floor(maxTokens * 0.7));
  return `(Keep the reply under about ${words} words.)`;
}

// ChatGPT keeps the conversation itself, so by default a new chat gets only
// the latest turn (everything after the last assistant message), never a
// transcript of earlier turns. REPLAY_HISTORY=1 restores the full replay.
const REPLAY_HISTORY = process.env.REPLAY_HISTORY === '1';

function latestTurn(messages) {
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  return messages.slice(lastAssistant + 1).filter((m) => !isSystem(m));
}

// Prompt for a brand-new ChatGPT chat: instructions + the latest turn.
export function buildFullPrompt(messages, opts) {
  const system = messages.filter(isSystem).map((m) => contentText(m.content)).join('\n\n').trim();
  const convo = REPLAY_HISTORY ? messages.filter((m) => !isSystem(m)) : latestTurn(messages);
  const extras = [toolInstructions(opts), formatInstructions(opts.responseFormat), styleHints(opts), PLAIN_TEXT ? STYLE_RULE : ''].filter(Boolean);
  const single = convo.length === 1 && convo[0].role === 'user';

  if (!system && extras.length === 0 && single) {
    return [contentText(convo[0].content), lengthHint(opts)].filter(Boolean).join('\n\n');
  }
  // A lone question: keep it natural, with the style rule as a short footer.
  if (!system && single && extras.length === 1 && PLAIN_TEXT) {
    return [contentText(convo[0].content), lengthHint(opts), STYLE_REMINDER].filter(Boolean).join('\n\n');
  }

  let out = '';
  if (system) out += `[Instructions]\n${system}\n\n`;
  for (const e of extras) out += `${e}\n\n`;
  if (single) {
    out += `[User message]\n${contentText(convo[0].content)}`;
  } else {
    const names = toolNames(messages);
    out += `[Conversation]\n${convo.map((m) => renderMessage(m, names)).join('\n\n')}\n\n`;
    out += '[Write the next ASSISTANT reply directly, without an "ASSISTANT:" prefix]';
  }
  const len = lengthHint(opts);
  return len ? `${out}\n\n${len}` : out;
}

// Text for continuing an existing ChatGPT chat: only the messages it hasn't seen.
export function buildContinuation(allMessages, tail, opts) {
  const reminders = [];
  if (toolsActive(opts)) {
    reminders.push(`(To use a tool, reply with only the {"tool_calls": [...]} JSON block${PLAIN_TEXT ? '; otherwise plain text, no widgets' : ''}.)`);
  }
  if (jsonMode(opts.responseFormat)) reminders.push('(Reminder: reply with JSON only.)');
  const len = lengthHint(opts);
  if (len) reminders.push(len);

  const body = tail.length === 1 && tail[0].role === 'user'
    ? contentText(tail[0].content)
    : tail.map((m) => renderMessage(m, toolNames(allMessages))).join('\n\n');
  return [body, ...reminders].join('\n\n');
}

// --- Reply parsing -----------------------------------------------------------
function balancedAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Finds the first JSON object/array in free text (code fences, labels and all).
export function findJson(text, accept = () => true) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const raw = balancedAt(text, i);
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (accept(value)) return { value, raw };
    } catch {}
  }
  return null;
}

const looksLikeCall = (c) => c && typeof c === 'object' && typeof c.name === 'string';

function callsFrom(value) {
  if (Array.isArray(value?.tool_calls)) return value.tool_calls;
  if (Array.isArray(value) && value.length > 0 && value.every(looksLikeCall)) return value;
  if (looksLikeCall(value) && ('arguments' in value || 'parameters' in value)) return [value];
  return null;
}

export function parseReply(text, opts) {
  let cleaned = text.replace(/^\s*ASSISTANT:\s*/i, '').trim();

  if (toolsActive(opts) && /tool_calls|"name"/.test(cleaned)) {
    const allowed = new Set(functionTools(opts.tools).map((f) => f.name));
    const hit = findJson(cleaned, (v) => Boolean(callsFrom(v)?.some((c) => allowed.has(c.name))));
    if (hit) {
      const calls = callsFrom(hit.value).filter((c) => looksLikeCall(c) && allowed.has(c.name));
      const limited = opts.parallelToolCalls === false ? calls.slice(0, 1) : calls;
      return {
        content: null,
        toolCalls: limited.map((c) => ({
          id: `call_${crypto.randomBytes(12).toString('hex')}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? c.parameters ?? {}) },
        })),
      };
    }
  }

  if (jsonMode(opts.responseFormat)) {
    const hit = findJson(cleaned);
    if (hit) cleaned = hit.raw;
  }
  return { content: cleaned, toolCalls: null };
}

export const estimateTokens = (s) => Math.ceil((s || '').length / 4);

// Applies max_tokens / stop to reply text. Returns the visible text and why it ended early.
export function applyLimits(text, { maxTokens, stop }) {
  let out = text;
  let reason = null;
  for (const s of stop || []) {
    const i = out.indexOf(s);
    if (i !== -1) {
      out = out.slice(0, i);
      reason = 'stop';
    }
  }
  if (maxTokens && out.length > maxTokens * 4) {
    out = out.slice(0, maxTokens * 4);
    reason = 'length';
  }
  return { text: out, reason };
}
