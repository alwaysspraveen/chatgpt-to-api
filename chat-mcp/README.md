# ChatGPT Drafts MCP

An MCP server (built with [FastMCP](https://gofastmcp.com)) that lets **Claude** ask **ChatGPT** to draft messages you can paste into **Microsoft Teams, Google Chat, Slack or email**.

```
Claude ──MCP──▶ chatgpt-drafts (this server) ──HTTP──▶ ChatGPT bridge :8765 ──▶ chatgpt.com tab
```

It uses the local ChatGPT bridge (see the [main README](../README.md)), so the drafts are written by your ChatGPT account.

---

## Requirements

- The bridge running: `./start.bash` from the repo root
- Chrome with the bridge extension, and a **chatgpt.com tab open** (popup shows **READY**)
- [uv](https://docs.astral.sh/uv/)

## Install

**Quickest:** from the repo root run `./install-drafts.bash`. It does everything below for you: dependencies, Claude Code registration, the VS Code extension, and the `CLAUDE.md` instruction and permission.

### Manual install

```bash
cd chat-mcp
uv sync
```

### Add to Claude Code

```bash
claude mcp add --scope user chatgpt-drafts -- uv --directory /path/to/chatgpt-to-api/chat-mcp run server.py
claude mcp list        # should show: chatgpt-drafts … ✔ Connected
```

Remove it with `claude mcp remove chatgpt-drafts --scope user`.

### Add to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chatgpt-drafts": {
      "command": "uv",
      "args": ["--directory", "/path/to/chatgpt-to-api/chat-mcp", "run", "server.py"]
    }
  }
}
```

Restart Claude Desktop afterwards. If Claude Desktop can't find `uv`, use its full path (`which uv`).

---

**Existing sessions:** Claude Code loads a newly registered MCP into sessions that are already open, and the server's own instructions tell Claude to use `save_draft`, so you don't need to restart. Type `/mcp` to confirm **chatgpt-drafts** is connected (choose **Reconnect** if it isn't).

## Tools

| Tool | What it does | Key inputs |
|---|---|---|
| `save_draft` | Saves a message **Claude** wrote for you, so it appears in the **Claude Copy** VS Code panel. **No ChatGPT or bridge needed.** | `text`, `platform`, `title`, `copy_to_clipboard` |
| `chatgpt_draft_message` | *ChatGPT tools only:* asks ChatGPT to write a new message | `request` (what to say), `platform`, `tone`, `length`, `audience`, `context`, `language`, `new_chat` |
| `chatgpt_draft_reply` | *ChatGPT tools only:* asks ChatGPT to write a reply | `incoming_message`, `intent`, `platform`, `tone`, `length`, `sender`, `language`, `new_chat` |
| `chatgpt_refine_draft` | *ChatGPT tools only:* asks ChatGPT to revise its latest draft | `instructions`, optional `conversation_id` |
| `bridge_status` | *ChatGPT tools only:* checks the bridge is running and a ChatGPT tab is open | none |

**Drafts-only vs. ChatGPT tools.** `./install-drafts.bash` registers the MCP with `CHATGPT_TOOLS=0`, so Claude sees only `save_draft` and never tries a tool that needs the ChatGPT bridge. Run `./install-drafts.bash --with-chatgpt` to also enable the ChatGPT tools; those need the bridge from this repo running (`./start.bash`) and a chatgpt.com tab open. Claude uses them only when you explicitly ask for ChatGPT.

- **`platform`:** `teams` (default), `google_chat`, `slack`, `email`, `plain`. Formatting follows each app: Teams Markdown, Google Chat `*bold*` / `_italic_`, Slack mrkdwn, email with a `Subject:` line.
- **`length`:** `one_line`, `short` (default), `medium`, `long`.
- **One chat for all drafts:** drafts continue in the **same ChatGPT chat** until you ask for a new one (*"…in a new chat"*), which makes Claude pass `new_chat: true`. Each new draft is marked as a separate message, so details from earlier drafts aren't reused. The current chat id is saved in `.state.json`. If that chat no longer exists, a new one is started automatically.
- **Output:** every drafting tool returns `{"draft": "<text to paste>", "conversation_id": "<id>"}`. The draft is the bare message, with no "Here's a draft" preamble, quotes or code fences.

## Example prompts in Claude

- *"Use ChatGPT to draft a Teams message telling the dev channel the release moves to Friday because QA found a blocker. Friendly tone."*
- *"Draft a Google Chat reply to Priya: 'Can we meet at 3?' Say yes but suggest 4pm."*
- *"Make that draft shorter and more formal."* (Claude rewrites it and saves the new version with `save_draft`)
- *"Ask ChatGPT to draft …"* (only with `--with-chatgpt`: Claude calls `chatgpt_draft_message`)
- *"In a new chat, draft a leave email to my manager for Oct 20–22."* (starts a fresh ChatGPT chat)
- *"Draft an email to the client confirming the invoice was paid, medium length."*

Claude shows the draft. Copy it and paste it into Teams or Chat.

---

## Claude-written drafts (`save_draft`)

When **Claude itself** writes a message for you (*"draft a Teams message to …"*), it calls `save_draft` with just the message text. The draft is appended to `~/.claude-copy/drafts.jsonl`, and the **Claude Copy** VS Code extension ([`../vscode-claude-copy`](../vscode-claude-copy)) shows it in a side panel with Copy buttons. Only drafts are saved, not the rest of the conversation. Say *"save it"* if Claude doesn't save one automatically.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `CHATGPT_BRIDGE_URL` | `http://127.0.0.1:8765/v1` | Bridge address |
| `CHATGPT_BRIDGE_KEY` | read from `../server/.env` | Bridge API key |
| `CHATGPT_DRAFT_TIMEOUT` | `240` | Seconds to wait for ChatGPT |
| `CHATGPT_TOOLS` | `1` (`0` via the installer) | `0` = only `save_draft`; `1` = also the ChatGPT tools |
| `CLAUDE_DRAFTS_FILE` | `~/.claude-copy/drafts.jsonl` | Where `save_draft` writes |

To set them for Claude Code: `claude mcp add … -e CHATGPT_BRIDGE_KEY=sk-local-… -- uv …`

## Troubleshooting

| Message | Fix |
|---|---|
| `ChatGPT bridge is not running` | `./start.bash` in the repo root |
| `Bridge error 503: Browser extension is not connected` | Open the extension popup; click **Start bridge** if it says STOPPED |
| `Bridge error 503: No chatgpt.com tab is open` | Open https://chatgpt.com in Chrome |
| `Bridge error 401` | The key doesn't match `API_KEY` in `server/.env` |
| `ChatGPT didn't answer within 240s` | Check the ChatGPT tab for a login, captcha or rate-limit message |
| Tool not listed in Claude | `claude mcp list`; re-add it with the command above, then restart Claude |
| Claude says it can't access the MCP / `/mcp` shows **chatgpt-drafts ✘ failed** | Usually `uv` isn't on Claude Code's PATH (common when Claude runs from VS Code or the desktop app). Run `git pull && ./install-drafts.bash --force`: it registers the full path to `uv` and checks the server starts. Then in your current Claude session type `/mcp` and **Reconnect** chatgpt-drafts. No restart needed. |

## Test locally

```bash
uv run fastmcp dev inspector server.py   # MCP Inspector in the browser
uv run fastmcp inspect server.py         # list tools and server info
```
