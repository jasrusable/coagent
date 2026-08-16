# coagent

Harness-agnostic peer agents for Claude Code and Grok Build.

```
you (human) → lead agent → coagent peer(s)
```

This checkout is the source. Runtime home is `~/.coagent/` (session `state/` is not in git). Install with `./install.sh`.

## Layout

| Path | Role |
|------|------|
| `bin/coagent` | CLI (installed to `~/.local/bin/coagent`) |
| `lib/digest.js` | Lead-transcript digest (shared by CLI + tests) |
| `test/digest.test.js` | Digest unit tests |
| `persona.md` | Default peer persona (seeded into `~/.coagent` if missing) |
| `claude-shim.sh` | `~/.claude/bin/coagent` → `~/.local/bin/coagent` |
| `install.sh` | Copy code into home; leave `state/` alone |

## Rules

- Do not commit `~/.coagent/state` or any lead/peer transcripts.
- Keep the digest lib pure and unit-tested; the CLI loads it from `~/.coagent/lib`.
- Peers reply to the lead, not the user. Default peer is `main`.
- `--model` is `backend` or `backend/modelId` (e.g. `claude`, `claude/opus`, `grok`).
- After changing `bin/` or `lib/`, run `./install.sh` and `npm test` before calling it done.

## Commands

```sh
./install.sh
npm test
coagent doctor
coagent --help
```
