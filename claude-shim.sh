#!/usr/bin/env bash
# Compat shim — real binary lives at ~/.local/bin/coagent (harness-agnostic).
exec "${HOME}/.local/bin/coagent" "$@"
