#!/usr/bin/env bash
# Sets up "Claude drafts" on this machine:
#   1. chatgpt-drafts MCP (gives Claude the save_draft tool)  -> Claude Code
#   2. Claude Copy VS Code extension (side panel with Copy buttons)
#   3. ~/.claude/CLAUDE.md instruction + permission so Claude saves drafts automatically
# Safe to re-run: steps that are already done are skipped.
#   ./install-drafts.bash            install
#   ./install-drafts.bash --force    re-register the MCP even if it exists
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$ROOT/chat-mcp"
VSIX="$(ls -t "$ROOT"/vscode-claude-copy/dist/claude-copy-*.vsix 2>/dev/null | head -1)"
CLAUDE_DIR="$HOME/.claude"
FORCE=false; [ "${1:-}" = "--force" ] && FORCE=true

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
skip() { printf '  \033[90m• %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "Claude drafts installer"

# --- Requirements --------------------------------------------------------------
echo "Checking requirements…"
command -v claude >/dev/null || fail "Claude Code CLI not found. Install it first: https://claude.com/claude-code"
ok "Claude Code CLI"
if ! command -v uv >/dev/null; then
  fail "uv not found. Install it with:  curl -LsSf https://astral.sh/uv/install.sh | sh   (then open a new terminal)"
fi
UV="$(command -v uv)"
ok "uv ($UV)"
CODE=""
for c in code "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
         "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CODE="$c"; break; fi
done
[ -n "$CODE" ] && ok "VS Code" || warn "VS Code CLI not found: the extension step will be skipped (install the .vsix by hand)"
[ -n "$VSIX" ] || warn "No packaged extension in vscode-claude-copy/dist/"

# --- 1. MCP ----------------------------------------------------------------------
echo "1/3  MCP server (save_draft)…"
(cd "$MCP_DIR" && uv sync -q) || fail "uv sync failed in $MCP_DIR"
ok "Python dependencies installed"
# Register with the absolute path to uv: Claude Code started from VS Code or the
# desktop app often doesn't have ~/.local/bin on PATH, so a bare "uv" fails to start.
EXPECTED="$UV --directory $MCP_DIR run server.py"
CURRENT="$(claude mcp get chatgpt-drafts 2>/dev/null | sed -n 's/^ *Command: *//p;s/^ *Args: *//p' | paste -sd' ' -)"
if [ "$CURRENT" = "$EXPECTED" ] && ! $FORCE; then
  skip "chatgpt-drafts already registered (use --force to re-register)"
else
  claude mcp remove chatgpt-drafts --scope user >/dev/null 2>&1
  claude mcp add --scope user chatgpt-drafts -- "$UV" --directory "$MCP_DIR" run server.py >/dev/null \
    || fail "claude mcp add failed"
  ok "Registered chatgpt-drafts with Claude Code (user scope, $UV)"
fi
# Prove it starts the way Claude Code will start it (no shell PATH).
if env -i HOME="$HOME" "$UV" --directory "$MCP_DIR" run python -c "import server" >/dev/null 2>&1; then
  ok "MCP server starts without your shell's PATH"
else
  warn "MCP server failed to start: run  $UV --directory \"$MCP_DIR\" run server.py  to see the error"
fi
mkdir -p "$HOME/.claude-copy"

# --- 2. VS Code extension -------------------------------------------------------------
echo "2/3  VS Code extension (Claude Copy)…"
if [ -n "$CODE" ] && [ -n "$VSIX" ]; then
  "$CODE" --install-extension "$VSIX" --force >/dev/null 2>&1 && ok "Installed $(basename "$VSIX")" \
    || warn "Install failed: in VS Code use Extensions → ⋯ → Install from VSIX… → $VSIX"
else
  skip "Skipped (install by hand: Extensions → ⋯ → Install from VSIX… → $VSIX)"
fi

# --- 3. Claude instruction + permission ----------------------------------------------
echo "3/3  Claude instruction and permission…"
mkdir -p "$CLAUDE_DIR"
touch "$CLAUDE_DIR/CLAUDE.md"
if grep -q "save_draft" "$CLAUDE_DIR/CLAUDE.md"; then
  skip "~/.claude/CLAUDE.md already has the drafting instruction"
else
  cat >> "$CLAUDE_DIR/CLAUDE.md" <<'MD'

## Drafting messages
When I ask you to draft/write a message for Teams, Google Chat, Slack or email, write it yourself and save it with the `save_draft` tool (chatgpt-drafts MCP), passing only the final message text, the platform and a short title, so it appears in my Claude Copy panel in VS Code. If the tool isn't available, append one JSON line `{"id", "text", "platform", "title", "created_at"}` to `~/.claude-copy/drafts.jsonl` instead.
MD
  ok "Added drafting instruction to ~/.claude/CLAUDE.md"
fi

python3 - "$CLAUDE_DIR/settings.json" <<'PY' || fail "Could not update ~/.claude/settings.json (is it valid JSON?)"
import json, os, sys
path, rule = sys.argv[1], "mcp__chatgpt-drafts__save_draft"
data = {}
if os.path.exists(path) and os.path.getsize(path):
    with open(path) as f:
        data = json.load(f)
allow = data.setdefault("permissions", {}).setdefault("allow", [])
if rule in allow:
    print("  \033[90m• save_draft already allowed in ~/.claude/settings.json\033[0m")
else:
    allow.append(rule)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("  \033[32m✓\033[0m Allowed save_draft in ~/.claude/settings.json (no permission prompt)")
PY

cat <<'DONE'

Done. Next:
  • VS Code: Cmd+Shift+P → "Reload Window", then click the 📋 Claude Copy icon in the activity bar
  • Claude Code: start a new session (or /mcp → chatgpt-drafts → Reconnect)
  • Try: "Draft a Teams message to the team that the release moves to Friday"
DONE
