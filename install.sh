#!/usr/bin/env bash
# Install coagent:
#   ~/.local/bin/coagent
#   ~/.claude/bin/coagent   (compat shim)
#   ~/.coagent/{lib,test,README,persona…}
#
# Runtime session state (~/.coagent/state) is left untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${COAGENT_HOME:-$HOME/.coagent}"
BIN_DIR="${COAGENT_BIN_DIR:-$HOME/.local/bin}"
CLAUDE_BIN="${COAGENT_CLAUDE_BIN:-$HOME/.claude/bin}"

mkdir -p "$HOME_DIR/lib" "$HOME_DIR/test" "$BIN_DIR" "$CLAUDE_BIN"

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  "$ROOT/lib/" "$HOME_DIR/lib/"

rsync -a --delete "$ROOT/test/" "$HOME_DIR/test/"
cp "$ROOT/README.md" "$HOME_DIR/README.md"
cp "$ROOT/AGENTS.md" "$HOME_DIR/AGENTS.md"
cp "$ROOT/package.json" "$HOME_DIR/package.json"

if [[ ! -f "$HOME_DIR/persona.md" ]]; then
  cp "$ROOT/persona.md" "$HOME_DIR/persona.md"
fi

install -m 755 "$ROOT/bin/coagent" "$BIN_DIR/coagent"
install -m 755 "$ROOT/claude-shim.sh" "$CLAUDE_BIN/coagent"

echo "installed:"
echo "  binary  $BIN_DIR/coagent"
echo "  shim    $CLAUDE_BIN/coagent"
echo "  home    $HOME_DIR"
echo "  lib     $HOME_DIR/lib"
echo
echo "try:  coagent --help && coagent doctor"
