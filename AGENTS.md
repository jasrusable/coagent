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
| `lib/changes.js` | Git before/after check for `--readonly-unenforced` turns |
| `test/` | Unit + concurrency tests |
| `persona.md` | Last-layer rules (seeded if missing) |
| `skills/coagent/SKILL.md` | Agent skill. Install copies it to `~/.grok/skills/coagent` and links `~/.claude/skills/coagent` there |
| `install.sh` | Copy code into home and install the skill; leave `state/` and an existing `persona.md` alone |

## Rules

- Do not commit `~/.coagent/state` or transcripts.
- The **lead** harness is derived from the environment — never a CLI flag. `COAGENT_HARNESS` is only a human tiebreak when two harnesses claim this session.
- The **inner** family follows `--model` / persona `workerModel` / `model.<agent>`: `fable` / `opus` / `claude-*` → Claude Code; `grok-*` → Grok. Default (no model) stays the lead's family. Switching family on a colleague starts a new tape.
- One inner agent per lead session, plus a roster of prior tapes (`reset` / `sessions` / `resume`). `meta.json` / `roster.json` record which harness a tape belongs to.
- Nothing outside `lib/harness/` may know a vendor's file layout or CLI flags. Adding a harness = adding an adapter.
- Default model and effort follow the lead. `--model` / `--effort` override for that turn; `--model` may cross families (see inner family above).
- `--cwd` is that colleague's directory. It sticks. A different directory starts a new tape, because the session is stored under the directory it was started in. With no `--cwd` and no stored directory, the colleague uses the lead's.
- `@main` follows the lead unless `--model` / `--effort` is set. Named colleagues may default via persona `workerModel` / `workerEffort` / `model.<agent>` / `effort.<agent>`.
- A brief may come from `--brief-file <path>` or stdin (`-`). Prefer it for long briefs: argv is shell-parsed and backticks would execute.
- Questions (`asks`) print whole, never clipped — a clipped question gets answered on a guess. `asks <id>` shows one, answered or not.
- Claude Code leads: `pings --follow` once per session; `agents` warns if in-flight work has no follower.
- Send returns immediately. Busy send interrupts. `later` queues. `stop` kills the running turn.
- `wait` streams the inner tape, then prints consults that finished (`wait <id>` for one turn). `wait <id>` finds that turn when several lead sessions share the checkout and no session id is in the environment. `agents` shows the running turn's model and access, not the previous tape's meta.
- Inner system prompt every turn: identity + lead transcript paths + labeled `persona.md` (grok `--rules`, claude `--append-system-prompt`). Project AGENTS.md / CLAUDE.md come from the colleague's cwd.
- `--readonly` sticks on that colleague. Grok runs `--sandbox read-only` and `dontAsk`, without `--always-approve`. Claude runs `dontAsk`, `--permission-prompts none`, no MCP, and its write, subagent and Bash tools removed: dontAsk still runs whatever the user's allow rules cover, often writes, so a Claude reviewer reads files only and the lead passes it diffs and test output. `--read-write` clears it. Changing access starts a new tape. `coagent reset` clears `@main` only; `coagent @name reset` clears that colleague.
- Grok's sandbox refuses to start when a socket on its fixed deny list is a symlink out of that list (OrbStack's `/var/run/docker.sock`). Send fails fast on Grok `--readonly` there (`preflight()`); never drop the sandbox silently. `--readonly-unenforced` is the opt-in: Grok with dontAsk, no sandbox, a read-only instruction last in the rules, and a git before/after check (`lib/changes.js`) flagged on the consult and as a ping. Claude treats it as `--readonly`. Shown as `read-only (unenforced)` only where it is unenforced.
- Up to 6 colleagues per lead session. `reset` keeps the slot; `coagent @name remove` frees it (refused while busy, under the inbox lock; transcripts stay on disk, roster goes). An idle colleague whose stored `--cwd` is gone does not hold a slot. Only a send needs the stored directory to exist; every other verb works after it is removed.
- After changing `bin/` or `lib/`, run `./install.sh` and `npm test`.

## Commands

```sh
./install.sh
npm test
coagent --help
```
