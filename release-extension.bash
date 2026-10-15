#!/usr/bin/env bash
# Releases a new version of the "Drafts Panel for Claude Code" VS Code extension.
#
#   ./release-extension.bash patch -m "Fix copy on Windows"        0.6.0 -> 0.6.1
#   ./release-extension.bash minor                                  asks for changelog notes
#   ./release-extension.bash 0.8.0 -m "…" --publish                 publish with your token
#   ./release-extension.bash patch -m "…" --push-as alwaysspraveen  push as that GitHub user
#
# Steps: bump version → changelog → build .vsix into dist/ → publish (or open the
# upload page) → commit + push so ./install-drafts.bash gets the same version.
#
# Options:
#   patch|minor|major|X.Y.Z   how to bump the version (required)
#   -m, --message "text"      changelog notes; use "; " to separate several bullets
#   --publish                 publish with vsce (needs `npx @vscode/vsce login alwaysspraveen`
#                             once, or VSCE_PAT set); otherwise you upload in the browser
#   --push-as <github-user>   push using that account's `gh` token (gh auth login first)
#   --no-push                 commit locally, don't push
#   --no-git                  don't commit or push
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="$ROOT/vscode-claude-copy"
PORTAL="https://marketplace.visualstudio.com/manage/publishers"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }

BUMP=""; NOTES=""; PUBLISH=false; PUSH=true; GIT=true; PUSH_AS=""
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) BUMP="$1" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1" ;;
    -m|--message) shift; NOTES="${1:-}" ;;
    --publish) PUBLISH=true ;;
    --push-as) shift; PUSH_AS="${1:-}" ;;
    --no-push) PUSH=false ;;
    --no-git) GIT=false; PUSH=false ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
  shift
done
[ -n "$BUMP" ] || fail "Say how to bump the version: patch, minor, major or X.Y.Z (see --help)"
command -v node >/dev/null || fail "Node.js is required (for npx @vscode/vsce)"

cd "$EXT" || fail "Missing $EXT"
OLD="$(node -p "require('./package.json').version")"
ID="$(node -p "const p=require('./package.json'); p.publisher+'.'+p.name")"
echo "Releasing $ID (currently $OLD)"

# --- 1. Version -----------------------------------------------------------------
NEW="$(node - "$BUMP" "$OLD" <<'JS'
const [bump, old] = process.argv.slice(2);
const [a, b, c] = old.split('.').map(Number);
const next = bump === 'major' ? [a + 1, 0, 0] : bump === 'minor' ? [a, b + 1, 0] : bump === 'patch' ? [a, b, c + 1] : bump.split('.').map(Number);
const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
if (next.some(Number.isNaN) || cmp(next, [a, b, c]) <= 0) { console.error(`New version must be higher than ${old}`); process.exit(1); }
console.log(next.join('.'));
JS
)" || fail "Invalid version"
node -e "const f='package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f));p.version='$NEW';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
ok "Version $OLD → $NEW"

# --- 2. Changelog -----------------------------------------------------------------
if [ -z "$NOTES" ]; then
  echo "  What changed in $NEW? One line per bullet, empty line to finish:"
  while IFS= read -r line && [ -n "$line" ]; do NOTES="${NOTES:+$NOTES; }$line"; done
fi
[ -n "$NOTES" ] || NOTES="Maintenance release"
node - "$NEW" "$NOTES" <<'JS'
const fs = require('fs');
const [ver, notes] = process.argv.slice(2);
const bullets = notes.split(/;\s+/).filter(Boolean).map((n) => `- ${n.trim()}`).join('\n');
let log = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '# Changelog\n';
log = log.replace(/^# Changelog\s*\n/, `# Changelog\n\n## ${ver}\n${bullets}\n\n`);
fs.writeFileSync('CHANGELOG.md', log);
JS
ok "CHANGELOG.md updated"

# --- 3. Build --------------------------------------------------------------------------
rm -f dist/*.vsix
mkdir -p dist
npx -y @vscode/vsce@3.2.1 package -o dist/ >/tmp/vsce-package.log 2>&1 || { cat /tmp/vsce-package.log; fail "Build failed (output above)"; }
VSIX="$EXT/dist/$(node -p "require('./package.json').name")-$NEW.vsix"
[ -f "$VSIX" ] || fail "Expected $VSIX"
ok "Built $(basename "$VSIX")"

# --- 4. Publish ------------------------------------------------------------------------
if $PUBLISH; then
  npx -y @vscode/vsce@3.2.1 publish --packagePath "$VSIX" \
    || fail "Publish failed. Log in once with: npx @vscode/vsce login ${ID%%.*}   (or set VSCE_PAT)"
  ok "Published $ID@$NEW (live in a few minutes)"
else
  warn "Upload it in the browser: $PORTAL/${ID%%.*} → Drafts Panel → ⋯ → Update → choose the file below"
  echo "      $VSIX"
  if [ "$(uname)" = Darwin ] && [ -z "${RELEASE_NO_OPEN:-}" ]; then open "$PORTAL/${ID%%.*}" 2>/dev/null; open -R "$VSIX" 2>/dev/null; fi
fi

# --- 5. Git ----------------------------------------------------------------------------
if $GIT; then
  cd "$ROOT"
  git add vscode-claude-copy && git commit -q -m "Drafts Panel $NEW" -m "$NOTES" && ok "Committed \"Drafts Panel $NEW\"" \
    || warn "Nothing committed"
  if $PUSH; then
    if [ -n "$PUSH_AS" ]; then
      git -c credential.helper= \
          -c credential.helper="!f() { echo username=$PUSH_AS; echo \"password=\$(gh auth token -u $PUSH_AS)\"; }; f" \
          push -q && ok "Pushed as $PUSH_AS" || fail "Push failed (is $PUSH_AS logged in with gh?)"
    else
      git push -q && ok "Pushed" || fail "Push failed (try --push-as <github-user>)"
    fi
  fi
fi

echo
echo "Done: $ID $NEW"
echo "  • Marketplace users get it automatically once it's live"
echo "  • Teammates: git pull && ./install-drafts.bash"
