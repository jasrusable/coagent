# coagent

The lead's standing colleague. One per harness session. Messages resume. `reset` archives.

```
you (human) → lead agent → one co-agent
```

This checkout is the source. Runtime home is `~/.coagent/` (`state/` is not in git). Install with `./install.sh`.

## Layout

| Path | Role |
|------|------|
| `bin/coagent` | CLI |
| `lib/digest.js` | Lead-transcript digest |
| `lib/session.js` | Generations, inbox, locks |
| `test/` | Digest + session unit tests |
| `persona.md` | Default persona (seeded if missing) |
| `install.sh` | Copy code into home; leave `state/` alone |

## Rules

- Do not commit `~/.coagent/state` or transcripts.
- One co-agent per lead session id. Do not add `--peer` / UUID farms / `ask`.
- Default model is the lead's current model. `--model` is a this-turn override.
- `coagent "…"` enqueues and waits. `--interrupt` preempts. `reset` archives.
- After changing `bin/` or `lib/`, run `./install.sh` and `npm test`.

## Commands

```sh
./install.sh
npm test
coagent doctor
coagent --help
```
