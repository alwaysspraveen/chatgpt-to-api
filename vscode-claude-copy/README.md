# Claude Copy (VS Code extension)

A side panel with the **messages Claude drafts for you**: Teams, Google Chat, Slack or email messages, ready to copy and paste. It shows **only drafts**, not your whole Claude conversation, and doesn't use ChatGPT.

```
You: "Draft a Teams message telling the team the release moves to Friday"
Claude writes it → calls save_draft (chatgpt-drafts MCP) → ~/.claude-copy/drafts.jsonl → Claude Copy panel → [Copy]
```

Other extensions can't read Claude Code's chat panel, so Claude saves each draft with the **`save_draft`** tool, and the panel shows that file.

## Requirements

- The **chatgpt-drafts MCP** registered in Claude Code (see `chat-mcp/README.md` in the repo). Its `save_draft` tool is what Claude calls. It runs locally and doesn't need the ChatGPT bridge.

## Side panel

Click the **Claude Copy** icon in the activity bar. Each draft is shown as the message you're about to send:

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
| **Claude Copy: Copy Last Draft** | `Cmd+Alt+D` / `Ctrl+Alt+D` |
| **Claude Copy: Pick a Draft to Copy…** | status bar **$(copy) Drafts** |
| **Claude Copy: Delete All Drafts** | panel title bar |

## Settings

| Setting | Default | |
|---|---|---|
| `claudeCopy.autoCopyDrafts` | `false` | Copy each new draft to the clipboard as soon as Claude saves it |
| `claudeCopy.format` | `rich` | Format for **Copy**, the shortcut and the status bar: `rich` (formatted), `plain`, or `markdown` (raw, shows `**`) |
| `claudeCopy.draftsFile` | `~/.claude-copy/drafts.jsonl` | Must match the MCP's `CLAUDE_DRAFTS_FILE` if you change it |

## Install

```bash
cd vscode-claude-copy
npx @vscode/vsce package --allow-missing-repository
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension claude-copy-0.5.1.vsix --force
```
Then run **Developer: Reload Window**. Alternatively, in the Extensions view use **⋯ → Install from VSIX…**.
