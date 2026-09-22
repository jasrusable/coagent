# coagent

The lead agent's inner agent. One per harness session. Send is background. Messages resume a persistent tape.

```
you (human) → lead (grok | claude) → inner agent (grok | claude/opus/fable)
```

This checkout is the source. Runtime home is `~/.coagent/` (`state/` is not in git). Install with `./install.sh`.

## Layout

| Path | Role |
|------|------|
| `bin/coagent` | CLI |
| `lib/session.js` | Inbox, roster, worker lock |
| `lib/harness/` | Per-harness adapters (`grok.js`, `claude.js`) + selection (`index.js`) |
| `lib/render.js` | Watch/log pretty-print |
| `test/` | Unit + concurrency tests |
| `persona.md` | Last-layer rules (seeded if missing) |
| `install.sh` | Copy code into home; leave `state/` alone |

## Rules

- Do not commit `~/.coagent/state` or transcripts.
- The **lead** harness is derived from the environment — never a CLI flag. `COAGENT_HARNESS` is only a human tiebreak when two harnesses claim this session.
- The **inner** family follows `--model` / persona `workerModel` / `model.<agent>`: `fable` / `opus` / `claude-*` → Claude Code; `grok-*` → Grok. Default (no model) stays the lead's family. Switching family on a colleague starts a new tape.
- One inner agent per lead session, plus a roster of prior tapes (`reset` / `sessions` / `resume`). `meta.json` / `roster.json` record which harness a tape belongs to.
- Nothing outside `lib/harness/` may know a vendor's file layout or CLI flags. Adding a harness = adding an adapter.
- Default model/effort/cwd follow the lead. `--model` / `--effort` override for that turn; `--model` may cross families (see inner family above).
- `@main` follows the lead unless `--model` / `--effort` is set. Named colleagues may default via persona `workerModel` / `workerEffort` / `model.<agent>` / `effort.<agent>`.
- A brief may come from `--brief-file <path>` or stdin (`-`). Prefer it for long briefs: argv is shell-parsed and backticks would execute.
- Questions (`asks`) print whole, never clipped — a clipped question gets answered on a guess. `asks <id>` shows one, answered or not.
- Claude Code leads: `pings --follow` once per session; `agents` warns if in-flight work has no follower.
- Send returns immediately. Busy send interrupts. `later` queues. `stop` kills the running turn.
- `wait` streams the inner tape, then prints consults that finished (`wait <id>` for one turn).
- Inner system prompt every turn: identity + lead transcript paths + labeled `persona.md` (grok `--rules`, claude `--append-system-prompt`). Project AGENTS.md / CLAUDE.md come from the lead's cwd.
- After changing `bin/` or `lib/`, run `./install.sh` and `npm test`.

## Commands

```sh
./install.sh
npm test
coagent --help
```
