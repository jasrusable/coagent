# Co-agent

The lead agent's inner agent. Same idea as the lead is an agent for the human: the co-agent is an agent for the lead.

**Completely vibe-coded. No code review.** This grew by prompting and has not been reviewed. Read it before you point it at a repo you care about. The inner agent runs with `--always-approve`.

```
You (human) → Lead (Grok or Claude Code) → inner agent (Grok, Claude, Opus, or Fable)
```

## Why

A lead that does every long job in its own session spends that session's context on the job, and it can only use its own model. Coagent is a colleague the lead keeps on the side, on the same checkout.

- **You keep the lead.** Send returns immediately. The lead goes on talking, editing, and answering you while the colleague works. The next send steers a busy colleague; `later` queues behind the current turn.
- **The colleague remembers.** Its tape lasts until `reset`. A second pass, or "look again now that this is fixed", continues that session.
- **Other model, same tree.** A Grok lead can hand a review to Fable or Opus. A Claude lead can hand one to Grok. Switching family starts that colleague a new tape.
- **A few at once.** Named colleagues (`@review`, `@opus`, …) each have a tape, an inbox, and a lock, up to 6. You still only talk to the lead.
- **Fan-out can be the cheap model.** `@main` follows the lead. Named colleagues can default to a smaller model and a lower effort. One turn can still override with `--model` and `--effort`.
- **The long transcript stays over there.** The lead gets the reply. The search, the files read, and the dead ends stay on the colleague's tape.

The **lead** harness is derived from the environment (who you are talking to).
The **inner** family follows `--model`: `fable` / `opus` / `claude-*` drives
Claude Code; `grok-*` drives Grok. With no model, the inner agent matches the
lead. `coagent doctor` shows the lead. Switching family on a colleague starts a
new tape.

One colleague **per harness session**. Send is background. The inner session persists across messages. `reset` starts a new tape; old ones stay on disk.

### Grok lead vs Claude lead

A **Grok** lead should not arm `pings --follow` as a session ritual. Grok already
wakes the lead when a background agent finishes — that is the notification
path. Prefer Grok's native background agents for Grok-family work. Use
`coagent --model fable` / `opus` only when you want the other family. Check
results with `coagent @name log` (or wait); do not run both systems on one job.

A **Claude Code** lead still needs `coagent pings --follow` once per session.
That harness has no equivalent wake-on-child-done, so without a follower
`notify` is invisible and `ask` parks like a hung worker.

- **Checkout:** `~/projects/coagent`
- **Home:** `~/.coagent/` (`state/` is not in git)
- **Binary:** `~/.local/bin/coagent`

## Install

```sh
git clone git@github.com:jasrusable/coagent.git ~/projects/coagent
cd ~/projects/coagent
./install.sh
coagent doctor
```

## Usage

```bash
coagent "review this"          # send (interrupts if busy); returns immediately
coagent later "also check X"   # queue for after the current turn
coagent stop                   # kill the running turn; queue stays
coagent wait                   # stream until idle; print turns that finished
coagent wait <id>              # stream until that turn; print it
coagent                        # snapshot + recent consults
coagent log                    # consults (your messages + inner replies)
coagent watch                  # live tail of inner updates.jsonl
coagent reset                  # new inner session
coagent sessions               # list inner sessions for this lead
coagent resume <id>            # make an old inner session current
```

Busy send is steer — it stops the current turn and runs the new message next. Use `later` to queue without interrupting.

Ctrl-C on `wait` / `watch` only stops waiting. Use `coagent stop` to stop the inner grok.

It runs `--always-approve`. Don't walk away from destructive work. Reset between unrelated jobs so the tape doesn't rot.

`--model` / `--effort` override that turn. `--model` may pick the other family
(`coagent @review --model fable --effort high "…"` from a Grok lead). The inner system prompt
carries identity + lead transcript paths + `persona.md` every turn — as `--rules`
on Grok, `--append-system-prompt` on Claude. Project `AGENTS.md` / `CLAUDE.md`
files load from the lead's cwd.

## Colleagues (parallel)

Named colleagues run alongside `@main`, each with its own tape, inbox and lock. You manage them; the human talks only to you.

```bash
coagent @review "…"                  # address a named colleague (starts one)
coagent @review "new focus…"         # busy colleague is interrupted (steer)
coagent agents                       # who exists, doing what, elapsed, spend
coagent wait --all                   # wait for all; print as each lands
```

### Briefs

There is no digest — your message is the worker's only context. For anything long, pass it as a file rather than an argument: an argv brief is parsed by your shell first, and **backticks in it are command substitution**, so a brief that quotes shell would execute it.

```bash
coagent @review --brief-file brief.md
coagent @review - < brief.md          # same, from stdin
```

### The ping channel

Workers reach you mid-job over an append-only log shared by every colleague of one lead.

```bash
coagent pings --follow    # Claude leads: arm once. Grok leads: skip.
coagent pings             # new flags since last read
coagent pings --all       # whole log
coagent asks              # questions workers are blocked on, in full
coagent asks <id>         # one question, answered or not
coagent answer <id> "…"   # unblock one
```

`--follow` is the delivery path **for a Claude Code lead**. Without it a
`notify` waits for a manual pull and an `ask` parks unseen. `agents` warns
when a Claude lead has in-flight work and nothing is following. A Grok lead
does not get that warning — do not arm a follower there.

Questions are printed **whole, never clipped**. A question read at 160 characters gets answered on a guess, and the guess is indistinguishable from an answer to the worker.

### Inside a worker

A worker's env is scrubbed of lead identity, so it gets only these three verbs — every other one is refused:

| Verb | Use |
|------|-----|
| `coagent notify "…"` | Flag something that changes what should happen next. Never progress or narration. |
| `coagent ask "…"` | Block on a question and print the answer. On `NO ANSWER YET` stop and end the turn; the tape is kept and resumed with the answer. |
| `coagent pings` | What other workers have flagged. |

### Model policy

`@main` follows the lead's model and effort — it is the thinking partner. Named colleagues are fan-out, where inheriting the lead's top model at high effort is pure cost, so they can default cheaper:

```yaml
---
workerModel: claude-sonnet-5     # every named colleague
workerEffort: medium
model.audit: claude-opus-5       # one colleague, overrides the above
---
```

Precedence for model: `--model` → `COAGENT_MODEL` → per-agent policy → `COAGENT_WORKER_MODEL` → `workerModel` → the lead's model → `model:`. For effort: `--effort` → `COAGENT_EFFORT` → per-agent `effort.<name>` → `COAGENT_WORKER_EFFORT` → `workerEffort` → the lead's effort → persona `effort:`. A grok/claude/opus/fable id is allowed from either lead; an unknown id is refused.

`coagent agents` reports each colleague's cumulative spend and turn count, and how long the running turn has been going.

## Transcripts

Grok keeps two files per session, Claude Code keeps one:

| Harness | File | What |
|---------|------|------|
| Grok | `~/.grok/sessions/<cwd>/<id>/updates.jsonl` | Full ACP event log. Append-only. |
| Grok | `~/.grok/sessions/<cwd>/<id>/chat_history.jsonl` | What the model is attending to now. Compact rewrites this. |
| Claude | `~/.claude/projects/<cwd-slug>/<id>.jsonl` | Full append-only transcript. No separate compacted tape. |

The inner system prompt points at the **lead's** copies. `watch` tails the inner
transcript. `log` / `wait` print consults from the inbox (what you asked, what it
answered) — not the raw tape. Grep the tape yourself to search it whole; do not
read it whole.

## Adding a harness

Everything harness-specific lives behind one adapter interface in
`lib/harness/`: `detect()`, `sessionPaths()`, `describeSession()`, `buildArgs()`,
`scrubEnv()`, `acceptsModel()`, `rulesLines()`, `formatUpdate()`. The inbox,
worker, locking, and CLI know nothing about either vendor. `lib/harness/index.js`
picks between adapters by how strongly each one identified the lead (an explicit
path or env var beats a registry match); if two tie, it refuses rather than
guessing, and `COAGENT_HARNESS` is the human's tiebreak.

## Layout

```
~/.coagent/state/<leadSessionId>/
  meta.json          # current inner session id
  roster.json        # prior inner sessions
  inbox.json         # queued / running / done
  last_reply.md
```

## Persona

Default: `~/.coagent/persona.md`. Last layer on top of cwd `AGENTS.md`.

## Develop

```sh
npm test
./install.sh
```
