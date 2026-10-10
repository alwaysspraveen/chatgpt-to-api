# ChatGPT → API Bridge

Use your logged-in **ChatGPT web session** as a local, **OpenAI-compatible API**, including tool calling for agent frameworks.

```
Your app / agent ──HTTP──▶ Local server ──WebSocket──▶ Chrome extension ──▶ chatgpt.com tab(s)
 (OpenAI SDK, agents)     127.0.0.1:8765               (background.js)      (content.js)
        ▲                                                                        │
        └──────────────── reply streamed back the same way ◀────────────────────┘
```

The extension types each prompt into a real chatgpt.com tab, clicks Send, reads the reply as it renders, and returns it as an OpenAI `chat.completion`.

> ⚠️ **Personal use only.** Automating the ChatGPT web app is against OpenAI's Terms of Use and can get your account suspended. It's also fragile: ChatGPT changes its page often, which breaks the selectors. For production workloads, use the official API.

---

## Features

- **OpenAI-compatible:** `POST /v1/chat/completions` (streaming and non-streaming) and `GET /v1/models`
- **Tool / function calling:** emulated by prompting ChatGPT, then parsed into real `tool_calls`. Works with the OpenAI SDK, LiteLLM and other OpenAI-compatible clients.
- **Automatic agent sessions:** each conversation history maps to its own ChatGPT chat, and only new messages are typed
- **Parallel workers:** every open chatgpt.com tab handles one request at a time
- **Files and images in:** PDFs, Word, Excel, PowerPoint, CSV, text, code, images and more, sent inline (`file` / `image_url` parts) or uploaded first with the OpenAI **Files API** (`/v1/files`), then uploaded into the ChatGPT message box
- **Request parameters:** `max_tokens`, `stop`, `n`, `model` and `reasoning_effort` are enforced; `temperature`, `top_p` and the penalties are approximated; `seed`, `logprobs` and the rest are accepted (see [Parameters](#parameters))
- **JSON mode:** `response_format` `json_object` / `json_schema`
- **Streaming:** plain text streams as it renders, even when tools are enabled
- **Plain-text answers:** asks ChatGPT not to reply with widgets, cards, images or web search
- **Extension popup:** status, tab workers, stop/start bridge, stop all replies
- **`start.bash` / `stop.bash`:** one-command start and stop, with a persistent API key in `server/.env`
- **Localhost only:** API-key auth, and only a browser extension can connect as the bridge

---

## Contents

1. [Quick enable checklist](#quick-enable-checklist)
2. [Setup](#setup)
3. [How to use](#using-it)
4. [Where you can use it](#where-you-can-use-it)
5. [Which ChatGPT chat a request goes to](#which-chatgpt-chat-a-request-goes-to)
6. [How tool calling works](#how-tool-calling-works)
7. [API docs](#api-docs) (including [Parameters](#parameters) and [Files and images](#files-and-images))
8. [Configuration](#configuration)
9. [Runbook](#runbook)
10. [Troubleshooting](#troubleshooting)
11. [Project layout](#project-layout)
12. [Limitations](#limitations)

---

## Quick enable checklist

Every time you want to use the bridge:

- [ ] **Server running:** `./start.bash` (the API key is in `server/.env`)
- [ ] **Chrome open** with the **ChatGPT API Bridge** extension enabled
- [ ] **At least one chatgpt.com tab** open and logged in (open more tabs to run requests in parallel)
- [ ] **Popup shows READY.** If it says STOPPED, click **Start bridge**.
- [ ] **`curl http://127.0.0.1:8765/health`** shows `"extensionConnected": true` and `"tabs" ≥ 1`
- [ ] Your client points at **`http://127.0.0.1:8765/v1`** and uses the same **API key**

---

## Requirements

- Node.js 20+
- Google Chrome 116+ (or another Chromium browser), logged in to chatgpt.com

---

## Setup

### 1. Start the server

```bash
./start.bash          # installs deps on first run, starts in the background
./stop.bash           # stops it
./start.bash -f       # or run in the foreground (Ctrl+C to stop)
```

```
ChatGPT bridge started (pid 9482)
  Base URL : http://127.0.0.1:8765/v1
  API key  : sk-local-…
  Logs     : tail -f server/bridge.log
  Health   : curl http://127.0.0.1:8765/health
```

On first run, `start.bash` creates **`server/.env`** with a random `API_KEY`. The key stays the same across restarts. Edit that file to change the key, port or other settings (see [Configuration](#configuration)).

To run it by hand instead: `cd server && npm install && API_KEY=sk-local-change-me npm start`. Without `API_KEY`, a new key is generated on every start.

### 2. Install the Chrome extension

The extension isn't in the Chrome Web Store. You load it straight from the `extension/` folder of this repo ("unpacked").

**Get the code** (if you haven't already):
```bash
git clone https://github.com/alwaysspraveen/chatgpt-to-api.git
cd chatgpt-to-api
```

**Load it:**

1. Open the extensions page:
   | Browser | Address |
   |---|---|
   | Chrome | `chrome://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |
2. Turn on **Developer mode**. The switch is at the top right in Chrome and Brave, and in the left sidebar in Edge.
3. Click **Load unpacked**.
4. Select the **`extension`** folder inside the repo, the one that contains `manifest.json`. Don't select the repo root.
5. **ChatGPT API Bridge** appears in the list. Make sure its switch is **on**.
6. **Pin the icon:** click the puzzle-piece icon in the toolbar, then the pin next to **ChatGPT API Bridge**. The badge on the icon shows the status at a glance.

**Connect it:**

7. Start the server (`./start.bash`, step 1) if it isn't running.
8. Open **https://chatgpt.com** and log in. If a ChatGPT tab was already open, **reload it** so the extension can attach.
9. Click the extension icon. The popup should say **READY** and show `Tabs: 0 busy / 1 open`.

Open **more chatgpt.com tabs** to run several requests in parallel, one per tab.

**What the extension can access:** only `https://chatgpt.com/*`, plus the `storage`, `alarms` and `scripting` permissions. It talks only to your local server (`ws://127.0.0.1:8765/bridge` by default; change it under popup → **Settings**).

**Updating** (after `git pull` or editing files): open the extensions page, click **↻** on **ChatGPT API Bridge**, then reload your chatgpt.com tab(s). See [When to reload the extension](#when-to-reload-the-extension).

**Removing:** click **Remove** on the extension's card on the extensions page.

**If something's wrong:**
| Problem | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You picked the wrong folder. Select `extension/`, the one containing `manifest.json`. |
| Popup says **OFFLINE** | The server isn't running, or popup → Settings points to the wrong URL |
| Popup says **NO TABS** | Open or reload a chatgpt.com tab |
| Badge empty / no **ON** | Check that the extension's switch is on, then click **↻** on its card |
| Red **Errors** button on the extension's card | Click it, copy the message, and include it in your bug report |

### 3. Test it

```bash
curl http://127.0.0.1:8765/health

curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer sk-local-change-me" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi"}]}'
```

More examples: `./curl-examples.sh [health|models|chat|new|stream|system|history|params|n|image <file>|ask "prompt"]`. It reads the key from `server/.env`.

---

## Using it

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="sk-local-change-me")
reply = client.chat.completions.create(
    model="chatgpt-web",  # ignored: you get whichever model is selected in the ChatGPT tab
    messages=[{"role": "user", "content": "Explain REST in one sentence."}],
)
print(reply.choices[0].message.content)
```

### Postman

Click **Import → Raw text** and paste any curl command from above. Use the **desktop app**: the web version can't reach `127.0.0.1` without the desktop agent. Set **Settings → Request timeout** to `0`, because replies take 5–60 s.

---

## Where you can use it

Anything that can talk to an **OpenAI-compatible Chat Completions endpoint** works. Wherever a tool asks for these settings, use:

| Setting | Value |
|---|---|
| Base URL / API base | `http://127.0.0.1:8765/v1` |
| API key | your `API_KEY` |
| Model | `chatgpt-web` (any name works) |
| Provider type | "OpenAI" / "OpenAI-compatible" |
| API style | **Chat Completions**, not the Responses API |
| Timeout | 300–600 s |

### Agent frameworks

| Framework | Config |
|---|---|
| **LiteLLM** | `litellm.completion(model="openai/chatgpt-web", api_base="http://127.0.0.1:8765/v1", api_key=KEY, messages=[...])` |
| **LangChain / LangGraph** | `ChatOpenAI(model="chatgpt-web", base_url="http://127.0.0.1:8765/v1", api_key=KEY, timeout=600)` |
| **CrewAI** | `LLM(model="openai/chatgpt-web", base_url="http://127.0.0.1:8765/v1", api_key=KEY)` |
| **OpenAI Agents SDK** | `OpenAIChatCompletionsModel(model="chatgpt-web", openai_client=AsyncOpenAI(base_url=..., api_key=KEY))`. Use the Chat Completions model, because the Responses API isn't supported. |
| **AutoGen** | `OpenAIChatCompletionClient(model="chatgpt-web", base_url=..., api_key=KEY, model_info={"function_calling": True, "json_output": True, "vision": False, "family": "unknown"})` |
| **LlamaIndex** | `OpenAILike(model="chatgpt-web", api_base=..., api_key=KEY, is_chat_model=True, is_function_calling_model=True)` |

### SDKs and scripts

| Tool | Config |
|---|---|
| **OpenAI Python** | `OpenAI(base_url="http://127.0.0.1:8765/v1", api_key=KEY)` |
| **OpenAI Node** | `new OpenAI({ baseURL: "http://127.0.0.1:8765/v1", apiKey: KEY })` |
| **curl / shell** | `./curl-examples.sh ask "your prompt"` |
| **Postman** | Import any curl command (see [Postman](#postman)) |

### Apps and automation (OpenAI-compatible provider setting)

**n8n** (OpenAI credential → Base URL), **Open WebUI** (Connections → OpenAI API), **Continue.dev** (`provider: openai`, `apiBase`), **LibreChat** (custom endpoint) and **Flowise** (ChatOpenAI → Base path) all accept a custom base URL.

### Good fits

- Personal agents and prototypes built with LangGraph, CrewAI or similar frameworks, at low to moderate volume
- Testing prompts and agent flows before paying for API usage
- Scripts, automations and summarizing or rewriting jobs from your own machine
- Using the model you already have selected in ChatGPT (your plan's model) from code

### Not a good fit

- Production, customer-facing or high-volume traffic
- Workloads that need low latency, exact token counts, sampling controls or images
- Anything shared with other people, or exposed beyond `127.0.0.1`

---

## Which ChatGPT chat a request goes to

| Request | Behaviour |
|---|---|
| *(default)* | If the messages continue a history this server has already answered, it **continues that chat** and types only the new messages. Otherwise it starts a **new chat** with the instructions and tools plus the latest message. |
| `"new_chat": true` (or `"new": true`) | Always start a new chat |
| `"conversation_id": "<id>"` | Open that ChatGPT chat and continue it, typing the messages after the last assistant turn |

Every response includes a non-standard `conversation_id` field. To continue a chat manually:

```json
{ "conversation_id": "6aca8695-178c-83ee-a820-6c974b5e8350",
  "messages": [{ "role": "user", "content": "And what about Python?" }] }
```

**History is never retyped.** ChatGPT keeps the conversation itself, so only the newest message(s) are ever typed: in an existing chat, just the new turn; in a new chat, the instructions and tools plus the latest turn, with no `USER:` / `ASSISTANT:` transcript. Set `REPLAY_HISTORY=1` to paste earlier turns into new chats instead.

If a remembered chat can't be reopened, the server starts a new chat with the latest message. An explicit `conversation_id` returns the error instead.

Sessions (which history belongs to which ChatGPT chat) are saved to `server/sessions.json` and kept for 24 hours, so they survive server restarts.

---

## How tool calling works

ChatGPT's web app has no function-calling API, so the server:

1. Adds a `[Tools]` section to the prompt that lists your tools and their JSON schemas, and tells ChatGPT to reply with **only** this when it needs a tool:
   ```json
   {"tool_calls": [{"name": "get_weather", "arguments": {"city": "Paris"}}]}
   ```
2. Finds that JSON in the reply, even inside a code block, and returns it as standard `tool_calls` with `finish_reason: "tool_calls"`.
3. Sends tool results (`role: "tool"`) back into the same chat as `TOOL RESULT` blocks.

`tool_choice` (`auto`, `required`, `none`, or a specific function) and `parallel_tool_calls` are respected. When streaming with tools, a reply that starts like JSON is held back and sent as `tool_calls`. A reply that starts as normal text streams right away.

This is prompt-based, so it's **less reliable than the real API**. ChatGPT sometimes ignores the format or answers in prose.

---

## API docs

Base URL: `http://127.0.0.1:8765`. Every `/v1/*` endpoint requires the header `Authorization: Bearer <API_KEY>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | no | Bridge status |
| `GET` | `/v1/models` | yes | List models |
| `POST` | `/v1/chat/completions` | yes | Chat (streaming or not, with tools, JSON mode, files and images) |
| `POST` | `/v1/files` | yes | Upload a file, get a `file_id` (OpenAI Files API) |
| `GET` | `/v1/files`, `/v1/files/{id}`, `/v1/files/{id}/content` | yes | List / metadata / download |
| `DELETE` | `/v1/files/{id}` | yes | Delete an uploaded file |

### `GET /health`

```bash
curl http://127.0.0.1:8765/health
```
```json
{ "ok": true, "extensionConnected": true, "tabs": 2, "running": 1, "queued": 0, "sessions": 3 }
```

| Field | Meaning |
|---|---|
| `extensionConnected` | The extension is connected over the WebSocket |
| `tabs` | Open chatgpt.com tabs, which is the number of requests that can run in parallel |
| `running` / `queued` | Requests in progress / waiting for a free tab |
| `sessions` | Remembered history → chat mappings |

### `GET /v1/models`

```json
{ "object": "list", "data": [{ "id": "chatgpt-web", "object": "model", "created": 0, "owned_by": "local-bridge" }] }
```

### `POST /v1/chat/completions`

#### Request body

| Field | Type | Notes |
|---|---|---|
| `messages` | array, **required** | Roles: `system`, `developer`, `user`, `assistant` (may include `tool_calls`), `tool` (with `tool_call_id`). `content` can be a string or parts: `text`, `image_url`, `file` (see [Files and images](#files-and-images)). The last message can't be `assistant`. |
| `model` | string | `chatgpt-web` = whatever is selected in the tab. Any other ChatGPT slug (e.g. `gpt-5`) opens **new** chats on that model. Echoed back. |
| `stream` | bool | Server-sent events in the OpenAI chunk format |
| `stream_options.include_usage` | bool | Adds a final usage chunk |
| `tools` | array | `[{type:"function", function:{name, description, parameters}}]` |
| `tool_choice` | `"auto"` / `"required"` / `"none"` / `{type:"function",function:{name}}` | |
| `parallel_tool_calls` | bool | `false` allows at most one call per reply |
| `response_format` | `{type:"json_object"}` / `{type:"json_schema", json_schema:{schema}}` | The reply is reduced to the JSON value |
| `new_chat` (alias `new`) | bool | *Bridge-specific.* Force a new ChatGPT chat. |
| `conversation_id` | string | *Bridge-specific.* Continue this ChatGPT chat. Can't be combined with `new_chat`. |
| `max_tokens` / `max_completion_tokens`, `stop`, `n`, `reasoning_effort`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `logprobs`, … | | See [Parameters](#parameters) |

#### Parameters

The ChatGPT web app has no sampling controls, so each parameter is either **enforced**, **approximated** with an instruction, or **accepted and ignored**:

| Parameter | Status | What happens |
|---|---|---|
| `max_tokens`, `max_completion_tokens` | ✅ Enforced | A length hint is added to the prompt. The tab clicks **Stop** once the reply passes the limit, and the text is cut at about 4 characters per token, giving `finish_reason: "length"`. |
| `stop` (string or up to 4 strings) | ✅ Enforced | Generation stops when a stop string appears, and the reply is cut just before it (`finish_reason: "stop"`). Streaming never sends a partial stop string. |
| `n` (1–4) | ✅ Enforced | Runs n separate new chats in parallel, one per free tab, and returns n `choices`. Only choice 0 continues a session. |
| `model` | ✅ New chats | Opens `chatgpt.com/?model=<slug>`. An unknown slug falls back to ChatGPT's default. |
| `reasoning_effort` | ✅ New chats | `medium` / `high` turn on the **Think** toggle in the message box, `low` / `minimal` / `none` turn it off |
| `response_format` | ✅ Prompted | Asks for JSON, then extracts the JSON value from the reply |
| `tools`, `tool_choice`, `parallel_tool_calls` | ✅ Emulated | See [How tool calling works](#how-tool-calling-works) |
| `stream`, `stream_options.include_usage` | ✅ | |
| `temperature` (0–2), `top_p` (0–1) | ≈ Approximate | `≤ 0.3` adds "be precise and consistent", `≥ 1.2` adds "be creative". Values in between add nothing. |
| `frequency_penalty`, `presence_penalty` (−2–2) | ≈ Approximate | `≥ 0.5` adds "avoid repetition" or "bring in new points" |
| `seed` | Accepted | Results aren't deterministic. Responses include `system_fingerprint: "chatgpt-web"`. |
| `logprobs`, `top_logprobs` | Accepted | Always `logprobs: null` |
| `top_k`, `logit_bias`, `user`, `metadata`, `store`, `service_tier`, `prediction`, `web_search_options` | Accepted | Ignored |
| `modalities: ["audio"]`, `audio` | ❌ | `400`. Audio isn't supported. |

Out-of-range values (e.g. `temperature: 5`, `n: 9`, `stop: [1]`) return `400` with a message.

#### Files and images

Attach any file ChatGPT accepts: **PDF, Word, Excel, PowerPoint, CSV, TXT, Markdown, JSON, code files, images** and more. The extension uploads them into ChatGPT's message box (by paste, then drag-and-drop, then the file picker as a fallback) and waits for the upload to finish before sending.

**Option A: inline in the message** (simplest)

```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Summarize the report and describe the chart." },
      { "type": "file", "file": { "filename": "report.pdf", "file_data": "data:application/pdf;base64,JVBERi0xLjQK…" } },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo…" } }
    ]
  }]
}
```

| Part | Accepted values |
|---|---|
| `{"type": "file", "file": {"filename", "file_data"}}` | `file_data` = `data:<mime>;base64,…`, **raw base64** (the type is guessed from `filename`), or an `http(s)://` URL to download |
| `{"type": "file", "file": {"file_id"}}` | An id from `POST /v1/files` (option B) |
| `{"type": "image_url", "image_url": {"url"}}` | `data:image/*;base64,…` or an `http(s)://` image URL |
| `input_file` / `input_image` | Same as above (newer part names some SDKs use) |

**Option B: upload first, then reference it** (OpenAI Files API, used automatically by Google ADK / LiteLLM)

```bash
curl http://127.0.0.1:8765/v1/files -H "Authorization: Bearer $API_KEY" \
  -F purpose=user_data -F file=@report.pdf
# → {"id": "file-6a1f…", "object": "file", "bytes": 48213, "filename": "report.pdf", ...}
```
```json
{ "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "Summarize this." },
    { "type": "file", "file": { "file_id": "file-6a1f…" } }
] }] }
```

Uploaded files are kept **in memory for 24 hours** (up to 200 files). They're cleared when the server restarts.

**Limits and behaviour**
- Up to **10 attachments** per request, **25 MB** each, and a **100 MB** request body
- In a continuing chat, only attachments in the **new** message are uploaded, since earlier ones are already in the chat
- Output is text only: no image or file generation

**curl recipes**

Load the key first: `API_KEY=$(grep '^API_KEY=' server/.env | cut -d= -f2)`

*Upload first, then ask* (any size up to 25 MB):
```bash
FILE_ID=$(curl -s http://127.0.0.1:8765/v1/files \
  -H "Authorization: Bearer $API_KEY" \
  -F purpose=user_data -F file=@report.pdf \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"new_chat": true, "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Summarize this document in 5 bullet points."},
        {"type": "file", "file": {"file_id": "'"$FILE_ID"'"}}]}]}'
```

*Inline, single request* (small files):
```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"new_chat": true, "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Summarize this document."},
        {"type": "file", "file": {"filename": "report.pdf",
          "file_data": "data:application/pdf;base64,'"$(base64 -i report.pdf)"'"}}]}]}'
```

*Inline, large files.* Build the body in a file, since big base64 doesn't fit on a command line:
```bash
python3 - report.pdf <<'PY' > /tmp/req.json
import base64, json, mimetypes, sys
p = sys.argv[1]
mime = mimetypes.guess_type(p)[0] or "application/octet-stream"
data = base64.b64encode(open(p, "rb").read()).decode()
print(json.dumps({"new_chat": True, "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Summarize this document."},
    {"type": "file", "file": {"filename": p.split("/")[-1], "file_data": f"data:{mime};base64,{data}"}}]}]}))
PY
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/req.json
```

*Manage uploads:*
```bash
curl -s http://127.0.0.1:8765/v1/files -H "Authorization: Bearer $API_KEY"                      # list
curl -s http://127.0.0.1:8765/v1/files/$FILE_ID/content -H "Authorization: Bearer $API_KEY" -o out.pdf  # download
curl -s -X DELETE http://127.0.0.1:8765/v1/files/$FILE_ID -H "Authorization: Bearer $API_KEY"   # delete
```

*Several files at once:* add more `file` / `image_url` parts to `content`, up to 10.

**Postman**
1. **Upload:** `POST http://127.0.0.1:8765/v1/files`, header `Authorization: Bearer <key>`, **Body → form-data**: key `purpose` (Text) = `user_data`, key `file` (switch the type to **File**) = pick your file. Copy the `id` from the response.
2. **Ask:** `POST http://127.0.0.1:8765/v1/chat/completions`, **Body → raw → JSON**, with the `file_id` request from above.

**Python (OpenAI SDK)**
```python
import base64
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key=KEY)

pdf = base64.b64encode(open("report.pdf", "rb").read()).decode()
r = client.chat.completions.create(model="chatgpt-web", messages=[{"role": "user", "content": [
    {"type": "text", "text": "Summarize this report in 5 bullets."},
    {"type": "file", "file": {"filename": "report.pdf", "file_data": f"data:application/pdf;base64,{pdf}"}},
]}])

# or upload first
f = client.files.create(file=open("report.pdf", "rb"), purpose="user_data")
r = client.chat.completions.create(model="chatgpt-web", messages=[{"role": "user", "content": [
    {"type": "text", "text": "Summarize this."}, {"type": "file", "file": {"file_id": f.id}},
]}])
```

#### Example: plain chat

```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "What is an API?"}
    ]
  }'
```
```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1791658009,
  "model": "chatgpt-web",
  "conversation_id": "6aca8695-178c-83ee-a820-6c974b5e8350",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "An API is a defined way for programs to talk to each other." },
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": { "prompt_tokens": 9, "completion_tokens": 15, "total_tokens": 24 }
}
```

#### Example: tool calling (two steps)

**Step 1: the model asks for a tool.**
```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
      }
    }]
  }'
```
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_8f2c…",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

**Step 2: run the tool, then send the full history plus its result.** The server recognizes the history and continues the same ChatGPT chat, typing only the tool result:
```json
{
  "messages": [
    {"role": "user", "content": "Weather in Paris?"},
    {"role": "assistant", "content": null, "tool_calls": [{"id": "call_8f2c…", "type": "function",
      "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]},
    {"role": "tool", "tool_call_id": "call_8f2c…", "content": "{\"condition\":\"sunny\",\"temp_c\":22}"}
  ],
  "tools": [ /* same tools as before */ ]
}
```
```json
{ "choices": [{ "message": { "role": "assistant", "content": "It's sunny and 22°C in Paris." }, "finish_reason": "stop" }] }
```

#### Example: JSON mode

```json
{
  "messages": [{"role": "user", "content": "Give me 2 fruits with their colors."}],
  "response_format": {
    "type": "json_schema",
    "json_schema": {"name": "fruits", "schema": {"type": "object", "properties": {"fruits": {"type": "array"}}}}
  }
}
```
→ `"content": "{\"fruits\":[{\"name\":\"apple\",\"color\":\"red\"},{\"name\":\"banana\",\"color\":\"yellow\"}]}"`

#### Example: continue a specific chat

```json
{ "conversation_id": "6aca8695-178c-83ee-a820-6c974b5e8350",
  "messages": [{"role": "user", "content": "Now give an example."}] }
```
Only the messages after the last `assistant` message are typed.

#### Streaming format (`"stream": true`)

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"It's sunny "},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"and 22°C."},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","conversation_id":"6aca…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- Text arrives in batches about every 150 ms, as ChatGPT renders it.
- With `tools`, a tool call arrives as a single `delta.tool_calls` chunk followed by `finish_reason: "tool_calls"`. Text answers still stream.
- With `response_format`, the content arrives in one chunk.
- An error mid-stream arrives as `data: {"error":{"message":"…","type":"upstream_error"}}` followed by `[DONE]`.

#### Errors

All errors look like `{"error": {"message": "...", "type": "..."}}`.

| Status | `type` | When |
|---|---|---|
| `400` | `invalid_request_error` | Missing or empty `messages`, last message is `assistant`, bad `conversation_id`, `conversation_id` combined with `new_chat`, out-of-range parameters, an image or file that can't be loaded, unknown `file_id`, audio, invalid JSON |
| `401` | `authentication_error` | Missing or wrong API key |
| `404` | `invalid_request_error` | Unknown path |
| `413` | `invalid_request_error` | Body over 100 MB |
| `502` | `upstream_error` | Failure in the tab: selector timeout, cancelled, ChatGPT didn't reply, or the job timed out |
| `503` | `service_unavailable` | Extension not connected, or no chatgpt.com tab open |

Tab errors include page diagnostics, e.g. `Timed out waiting for prompt input | script=v15-files url=/ editors=[…] …`.

---

## Configuration

Settings live in **`server/.env`**, which `start.bash` creates on first run and loads on every start. Environment variables work too when you run `npm start` by hand.

| Variable | Default | |
|---|---|---|
| `API_KEY` | random per start | Bearer token clients must send |
| `PORT` | `8765` | |
| `HOST` | `127.0.0.1` | Keep it on localhost |
| `JOB_TIMEOUT_MS` | `600000` | Max time per request, including time waiting in the queue |
| `PLAIN_TEXT` | `1` | `0` turns off the "no widgets / plain text" rule |
| `SESSIONS_FILE` | `server/sessions.json` | Where sessions are saved |
| `REPLAY_HISTORY` | `0` | `1` pastes earlier turns into new chats (by default only the latest message is typed) |

The extension's server URL can be changed under **popup → Settings**. The default is `ws://127.0.0.1:8765/bridge`.

### Recommended ChatGPT settings
- **Personalization → Custom instructions:** *"Always answer in plain text or Markdown. Never use widgets, cards, maps, image results, canvas, or web search unless I explicitly ask."*
- **Personalization → Memory:** off, so details from your own chats don't leak into agent replies
- Make sure Web search, Canvas and Image generation aren't switched on in the message box's tools menu

---

## Extension popup

| Pill | Meaning |
|---|---|
| **READY** | Connected, tabs idle |
| **BUSY n/m** | n of m tabs working |
| **OFFLINE** | Server not reachable (it keeps retrying) |
| **NO TABS** | No chatgpt.com tab open |
| **STOPPED** | You clicked **Stop bridge**, and the API returns 503 until you click **Start bridge** |

**Stop all replies** clicks ChatGPT's Stop button in every busy tab and fails those API requests right away.

---

## When to reload the extension

| You changed… | Reload? |
|---|---|
| `extension/content.js`, `background.js`, `manifest.json` | **Yes.** Click **↻** on `chrome://extensions`, then reload the chatgpt.com tab(s). |
| `extension/popup.*` | No. Reopen the popup. |
| `server/**` | No. Restart the server. |

Errors from the tab start with `script=<version>` (for example `script=v15-files`), so you can confirm which content-script version is running.

---

## Runbook

### Start (daily)

```bash
# 1. Server (key and port come from server/.env)
cd ~/chatgpt-to-api
./start.bash

# 2. In Chrome: open 1–3 chatgpt.com tabs and check the popup says READY

# 3. Verify
curl -s http://127.0.0.1:8765/health
#   → "extensionConnected": true, "tabs": ≥1
./curl-examples.sh ask "Reply with exactly: ok"    # from the repo root, with API_KEY exported
#   → ok
```

### Run the server in the background

`./start.bash` already runs it in the background (pid in `server/bridge.pid`, logs in `server/bridge.log`):

```bash
tail -f server/bridge.log

# Or with pm2 (auto-restart on crash)
npm i -g pm2
API_KEY=sk-local-change-me pm2 start server.js --name chatgpt-bridge
pm2 logs chatgpt-bridge
```

### Stop

| What | How |
|---|---|
| Pause the bridge, keeping the server up | Popup → **Stop bridge** (API returns 503). **Start bridge** resumes it. |
| Cancel replies in progress | Popup → **Stop all replies** |
| Stop the server | `./stop.bash` (or `Ctrl+C` in foreground mode, or `pm2 stop chatgpt-bridge`) |

### Restart the server

```bash
./stop.bash && ./start.bash
```
The extension reconnects by itself within a few seconds. Sessions are saved in `server/sessions.json`, so agents continue in the same chats.

### Update the code

1. Pull or edit the files.
2. **Server changed:** restart it (above).
3. **`extension/content.js`, `background.js` or `manifest.json` changed:** click **↻** on `chrome://extensions`, then reload every chatgpt.com tab.
4. Confirm the version: tab errors start with `script=<version>`.

### Scale up or down

- **More parallel agents:** open more chatgpt.com tabs. The popup and `/health` show the new `tabs` count right away.
- **Fewer:** close tabs. A request running in a tab you close fails with "The ChatGPT tab running this request was closed".
- Keep tabs in a normal window, not minimized, for the most reliable rendering.

### Rotate the API key

Edit `API_KEY` in `server/.env`, run `./stop.bash && ./start.bash`, and update every client (Postman header, agent and SDK configs).

### Reading the server log

```
[bridge] extension connected                     ← extension (re)connected
[job] done mode=new queued=0ms first-text=3058ms total=5357ms
[job] done mode=session …                        ← continued a remembered chat
[job] session chat 6aca… unavailable, retrying in a new chat
[job] error (Timed out waiting for prompt input) mode=new …
```

| Field | Meaning |
|---|---|
| `mode` | `new` = new chat, `session` = automatic continuation, `explicit` = `conversation_id`, `new (fallback)` = session chat couldn't be opened |
| `queued` | Time spent waiting for a free tab. If it's often high, open more tabs. |
| `first-text` | Time from sending the prompt to the first reply text: typing plus ChatGPT's thinking |
| `total` | End-to-end time for the request |

### Incident playbook

| Situation | Steps |
|---|---|
| **Every request fails with `503`** | 1) `curl /health`. 2) If `extensionConnected` is false: open the popup; if it says STOPPED, click Start; if OFFLINE, check the server is running on the URL under popup → Settings. 3) If `tabs` is 0, open chatgpt.com. |
| **Requests hang, then `502 Timed out …`** | 1) Look at the tab: is ChatGPT showing a captcha, a login screen or a rate-limit message? Fix that by hand. 2) Popup → **Stop all replies**. 3) Retry. |
| **`Timed out waiting for prompt input / send / ChatGPT to start replying` on every call** | ChatGPT changed its page. 1) Copy the diagnostics from the error. 2) Right-click the element → Inspect → Copy outerHTML. 3) Update `SELECTORS` in `extension/content.js`, bump `SCRIPT_VERSION`, reload the extension and tabs. |
| **Agents stop calling tools and reply in prose** | Check your Custom instructions don't conflict. Start a new chat (`"new_chat": true`), because a very long chat can drift from the tool instructions. |
| **Replies include widget or card text** | Apply the recommended ChatGPT settings. Keep `PLAIN_TEXT=1`. |
| **"You've reached your limit" in ChatGPT** | You've hit your plan's message limit. Wait, or switch the tab to another model. Reduce agent loops and parallel tabs. |
| **"Port 8765 is already in use"** | Run `./stop.bash`. If something else owns the port (`lsof -iTCP:8765 -sTCP:LISTEN`), set `PORT=8766` in `server/.env` and update popup → Settings. |
| **`Could not attach files` / `Timed out waiting for file upload to finish`** | ChatGPT's attachment area changed, the file type isn't accepted, or the upload failed. Check the file in the tab, then send the outerHTML of the message box so the `attachments` selector can be updated. |
| **Popup shows old behaviour or errors show an old `script=` version** | Reload the extension, then reload each chatgpt.com tab |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Browser extension is not connected` | Server running? Popup says READY? Did you click **Stop bridge**? |
| `ChatGPT tab is not ready` / `No chatgpt.com tab is open` | Open or reload a chatgpt.com tab |
| `Timed out waiting for prompt input / ChatGPT to start replying` | ChatGPT's page changed. The error lists what's on the page. Update `SELECTORS` at the top of `extension/content.js`. |
| `Could not open conversation … (tab is on /)` | That chat was deleted, was temporary, or isn't in this account |
| Old behaviour after an update | Reload the extension **and** the tab, then check the `script=` version |
| Reply contains a weather or other card instead of text | See **Recommended ChatGPT settings** |
| Slow replies | Each call has 1–3 s of overhead (typing, then detecting the end). Keep tabs in a normal, non-minimized window. |

---

## Project layout

```
server/
  server.js          HTTP API, bridge WebSocket, job queue / tab scheduling
  lib/prompt.js      messages → ChatGPT prompt, tool-call emulation, reply parsing
  lib/sessions.js    history → ChatGPT chat mapping (automatic sessions)
  lib/files.js       /v1/files store and multipart parser
extension/
  manifest.json      MV3 manifest
  background.js      server connection, tab worker pool, keepalive
  content.js         runs in chatgpt.com: types, sends, reads replies (SELECTORS live here)
  popup.html/js      status and controls
start.bash           start the server in the background (creates server/.env)
stop.bash            stop it
curl-examples.sh     ready-made curl requests
```

---

## Limitations

- Slower than the real API: roughly 3–60 s per call, depending on reply length
- One request per tab. More tabs mean more parallelism, and more load on your account.
- No real sampling controls (temperature, top_p, seed and logprobs are approximated or ignored) or exact token counts
- Files and images in only (no image or file output); no audio
- Tool calling depends on ChatGPT following the prompt format
- Breaks whenever ChatGPT changes its page layout, until the selectors are updated
- ChatGPT plan message limits apply, and heavy automated use risks account action
