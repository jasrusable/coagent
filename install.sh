#!/usr/bin/env bash
# Install coagent:
#   ~/.local/bin/coagent
#   ~/.claude/bin/coagent          (compat shim)
#   ~/.coagent/{lib,test,README,persona…}
#   ~/.grok/skills/coagent/SKILL.md
#   ~/.claude/skills/coagent       → the grok skill dir
#   ~/.coagent/hooks/no-foreground-wait.js, registered as a PreToolUse hook
#     in ~/.claude/settings.json (replacing the old jq-based one; backup kept)
#
# Needs only bash, coreutils and node.
# Runtime session state (~/.coagent/state) is left untouched.
# An existing persona.md is left untouched. The skill is replaced.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${COAGENT_HOME:-$HOME/.coagent}"
BIN_DIR="${COAGENT_BIN_DIR:-$HOME/.local/bin}"
CLAUDE_BIN="${COAGENT_CLAUDE_BIN:-$HOME/.claude/bin}"
GROK_SKILLS="${COAGENT_GROK_SKILLS:-$HOME/.grok/skills}"
CLAUDE_SKILLS="${COAGENT_CLAUDE_SKILLS:-$HOME/.claude/skills}"
CLAUDE_SETTINGS="${COAGENT_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

# Replace a directory's contents with the checkout's (what rsync -a --delete did).
mirror() {
  rm -rf "$2.new"
  cp -R "$1" "$2.new"
  rm -rf "$2"
  mv "$2.new" "$2"
}

mkdir -p "$HOME_DIR" "$BIN_DIR" "$CLAUDE_BIN"

mirror "$ROOT/lib" "$HOME_DIR/lib"
mirror "$ROOT/test" "$HOME_DIR/test"
mirror "$ROOT/hooks" "$HOME_DIR/hooks"
cp "$ROOT/README.md" "$HOME_DIR/README.md"
cp "$ROOT/AGENTS.md" "$HOME_DIR/AGENTS.md"
cp "$ROOT/package.json" "$HOME_DIR/package.json"

if [[ ! -f "$HOME_DIR/persona.md" ]]; then
  cp "$ROOT/persona.md" "$HOME_DIR/persona.md"
fi

install -m 755 "$ROOT/bin/coagent" "$BIN_DIR/coagent"
install -m 755 "$ROOT/claude-shim.sh" "$CLAUDE_BIN/coagent"

SKILL_DEST="$GROK_SKILLS/coagent"
mkdir -p "$SKILL_DEST" "$CLAUDE_SKILLS"
cp "$ROOT/skills/coagent/SKILL.md" "$SKILL_DEST/SKILL.md"
# One file. Claude discovers skills beside its own; point that name here.
if [[ -d "$CLAUDE_SKILLS/coagent" && ! -L "$CLAUDE_SKILLS/coagent" ]]; then
  cp "$ROOT/skills/coagent/SKILL.md" "$CLAUDE_SKILLS/coagent/SKILL.md"
else
  ln -sfn "$SKILL_DEST" "$CLAUDE_SKILLS/coagent"
fi

# The hook runs from an absolute node, so it works whatever PATH Claude Code
# was started with. An fnm shell's node is a per-shell link that disappears,
# so use the version it points to.
NODE="${COAGENT_NODE:-$(command -v node)}"
case "$NODE" in
  *fnm_multishells*) NODE="$(cd "$(dirname "$NODE")" && pwd -P)/node" ;;
esac

echo "installed:"
echo "  binary  $BIN_DIR/coagent"
echo "  shim    $CLAUDE_BIN/coagent"
echo "  home    $HOME_DIR"
echo "  lib     $HOME_DIR/lib"
echo "  skill   $SKILL_DEST/SKILL.md"
echo "  skill   $CLAUDE_SKILLS/coagent"
mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
"$NODE" "$ROOT/lib/install-hook.js" "$CLAUDE_SETTINGS" "$NODE" "$HOME_DIR/hooks/no-foreground-wait.js"
echo
echo "try:  coagent --help && coagent doctor"
