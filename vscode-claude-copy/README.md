# Drafts Panel for Claude Code

A side panel with the **messages Claude Code drafts for you**: Teams, Google Chat, Slack or email messages, ready to copy and paste. One click copies them **with formatting**, so Teams shows real bold and bullet lists instead of `**` symbols.

> Unofficial community extension; not affiliated with or endorsed by Anthropic.

```
You: "Draft a Teams message telling the team the release moves to Friday"
Claude Code writes it → saves it with the save_draft tool → it appears in the Drafts panel → [Copy for Teams]
```

VS Code extensions can't read Claude Code's chat, so Claude saves each draft with a small **`save_draft` MCP tool**, and this panel shows them. Only drafts are saved, not your conversation.

## Requirements

- [Claude Code](https://claude.com/claude-code) and [uv](https://docs.astral.sh/uv/)
- The `save_draft` MCP tool. One command sets it up, along with this extension and the instruction that tells Claude to use it:
  ```bash
  git clone https://github.com/alwaysspraveen/chatgpt-to-api.git
  cd chatgpt-to-api && ./install-drafts.bash
  ```
  Details: [chat-mcp/README.md](https://github.com/alwaysspraveen/chatgpt-to-api/blob/main/chat-mcp/README.md)
- Formatted copy works on **macOS**. On other systems, Copy falls back to plain text.

## Side panel

Click the **Drafts** icon in the activity bar. Each draft is shown as the message you're about to send:

- **Destination label:** Teams (purple), Google Chat (green), Slack, Email, or Text.
- **Rendered preview:** bold, lists, code and links as they'll look after pasting. Long drafts fade out at the bottom; **click the message** to expand or collapse it.
- **Copy for Teams / Copy for Chat / Copy email:** copies with formatting, so Teams, Outlook and Google Chat show real bold and bullets.
- **Plain:** copies with no formatting.
- **Trash icon:** deletes the draft. The ⌫ icon in the panel title deletes all drafts.
- **Grouping and search:** drafts are grouped by **Today / Yesterday / date**, newest first. A **search box** appears once you have 4 or more drafts.
- **Theme:** follows your VS Code theme (light, dark, high contrast). Drag the panel into the **Secondary Side Bar** if you want it on the right.

## Shortcuts and commands

| Command | Shortcut (mac / win-linux) |
|---|---|
| **Drafts Panel: Copy Last Draft** | `Cmd+Alt+D` / `Ctrl+Alt+D` |
| **Drafts Panel: Pick a Draft to Copy…** | status bar **$(copy) Drafts** |
| **Drafts Panel: Delete All Drafts** | panel title bar |

## Settings

| Setting | Default | |
|---|---|---|
| `claudeCopy.autoCopyDrafts` | `false` | Copy each new draft to the clipboard as soon as Claude saves it |
| `claudeCopy.format` | `rich` | Format for **Copy**, the shortcut and the status bar: `rich` (formatted), `plain`, or `markdown` (raw, shows `**`) |
| `claudeCopy.draftsFile` | `~/.claude-copy/drafts.jsonl` | Must match the MCP's `CLAUDE_DRAFTS_FILE` if you change it |

## Install

Install **Drafts Panel for Claude Code** from the Extensions view, or run `./install-drafts.bash` from the [repository](https://github.com/alwaysspraveen/chatgpt-to-api), which also sets up the `save_draft` tool.

## Privacy

Drafts are stored locally in `~/.claude-copy/drafts.jsonl`. Nothing is sent anywhere by this extension.
