#!/usr/bin/env bash
# Sets up "Claude drafts" on this machine:
#   1. chatgpt-drafts MCP (gives Claude the save_draft tool)  -> Claude Code
#   2. Claude Copy VS Code extension (side panel with Copy buttons)
#   3. ~/.claude/CLAUDE.md instruction + permission so Claude saves drafts automatically
# Safe to re-run: steps that are already done are skipped.
#   ./install-drafts.bash                 install (drafts only: Claude writes, save_draft saves)
#   ./install-drafts.bash --with-chatgpt  also enable the ChatGPT drafting tools (needs the
#                                         ChatGPT bridge from this repo running: ./start.bash)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$ROOT/chat-mcp"
VSIX="$(ls -t "$ROOT"/vscode-claude-copy/dist/*.vsix 2>/dev/null | head -1)"
CLAUDE_DIR="$HOME/.claude"
CHATGPT_TOOLS=0
for arg in "$@"; do
  case "$arg" in
    --with-chatgpt) CHATGPT_TOOLS=1 ;;
    --force) ;; # accepted for compatibility; the MCP is always re-registered now
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
skip() { printf '  \033[90m• %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "Claude drafts installer"
echo "  repo: $ROOT"
echo "  claude: $(command -v claude 2>/dev/null) $(claude --version 2>/dev/null)"

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
# CHATGPT_TOOLS=0 hides the ChatGPT tools, so Claude never picks one that needs the bridge.
# Only (re-)register when something differs: removing a server disconnects it from
# every Claude session that is already open.
CURRENT="$(claude mcp get chatgpt-drafts 2>/dev/null)"
if printf '%s' "$CURRENT" | grep -qF "Command: $UV" \
  && printf '%s' "$CURRENT" | grep -qF "Args: --directory $MCP_DIR run server.py" \
  && printf '%s' "$CURRENT" | grep -qF "CHATGPT_TOOLS=$CHATGPT_TOOLS"; then
  skip "chatgpt-drafts already registered with these settings (open sessions stay connected)"
else
  claude mcp remove chatgpt-drafts --scope user >/dev/null 2>&1
  if ! out="$(claude mcp add --scope user chatgpt-drafts -e CHATGPT_TOOLS=$CHATGPT_TOOLS -- "$UV" --directory "$MCP_DIR" run server.py 2>&1)"; then
    printf '%s\n' "$out"
    fail "claude mcp add failed (output above)"
  fi
  if [ "$CHATGPT_TOOLS" = 1 ]; then
    ok "Registered chatgpt-drafts: save_draft + ChatGPT tools (needs ./start.bash for ChatGPT)"
  else
    ok "Registered chatgpt-drafts: save_draft only (no ChatGPT bridge needed)"
  fi
  warn "Open Claude sessions: type /mcp → chatgpt-drafts → Reconnect"
fi
# Confirm Claude Code can actually see it.
if claude mcp list 2>/dev/null | grep -q "^chatgpt-drafts"; then
  ok "claude mcp list shows chatgpt-drafts"
else
  warn "chatgpt-drafts is not in 'claude mcp list'. Claude Code version: $(claude --version 2>/dev/null)"
  warn "Register it by hand:  claude mcp add --scope user chatgpt-drafts -e CHATGPT_TOOLS=$CHATGPT_TOOLS -- \"$UV\" --directory \"$MCP_DIR\" run server.py"
fi
# Prove it starts the way Claude Code will start it (no shell PATH).
if env -i HOME="$HOME" CHATGPT_TOOLS=$CHATGPT_TOOLS "$UV" --directory "$MCP_DIR" run python -c "import server" >/dev/null 2>&1; then
  ok "MCP server starts without your shell's PATH"
else
  warn "MCP server failed to start: run  $UV --directory \"$MCP_DIR\" run server.py  to see the error"
fi
mkdir -p "$HOME/.claude-copy"

# --- 2. VS Code extension -------------------------------------------------------------
echo "2/3  VS Code extension (Drafts Panel for Claude Code)…"
if [ -n "$CODE" ] && [ -n "$VSIX" ]; then
  # Earlier versions were installed as "local.claude-copy"; remove it so there's only one panel.
  "$CODE" --uninstall-extension local.claude-copy >/dev/null 2>&1 && ok "Removed old Claude Copy extension"
  # Skip if this exact version is already installed: reinstalling restarts VS Code's
  # extension host, which drops the "ide" connection of open Claude sessions.
  WANT="$(unzip -p "$VSIX" extension/package.json 2>/dev/null | python3 -c 'import sys,json; p=json.load(sys.stdin); print(p["publisher"]+"."+p["name"]+"@"+p["version"])' 2>/dev/null)"
  if [ -n "$WANT" ] && "$CODE" --list-extensions --show-versions 2>/dev/null | grep -qx "$WANT"; then
    skip "$WANT already installed"
  else
    "$CODE" --install-extension "$VSIX" --force >/dev/null 2>&1 && ok "Installed $(basename "$VSIX")" \
      || warn "Install failed: in VS Code use Extensions → ⋯ → Install from VSIX… → $VSIX"
  fi
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
When I ask you to draft/write a message for Teams, Google Chat, Slack or email, write it yourself and save it with the `save_draft` tool (chatgpt-drafts MCP), passing only the final message text, the platform and a short title, so it appears in my Drafts panel in VS Code. Write the text as Markdown: wrap technical values (project names, account IDs, regions, paths, secret/config keys, commands, hostnames) in `backticks` so they paste as code chips, and use **bold** and lists where helpful. If the tool isn't available, append one JSON line `{"id", "text", "platform", "title", "created_at"}` to `~/.claude-copy/drafts.jsonl` instead.
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
  • VS Code: Cmd+Shift+P → "Reload Window", then click the Drafts icon in the activity bar
  • Claude Code: keep your current session. It picks the MCP up automatically; type /mcp to check
    (if chatgpt-drafts isn't connected there, choose Reconnect). No restart needed.
  • Try: "Draft a Teams message to the team that the release moves to Friday"
DONE
