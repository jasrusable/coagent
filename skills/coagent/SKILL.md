---
name: coagent
description: >
  A persistent named sub-agent. You give it a name, it works in the
  background on the same files you have open, and its conversation
  continues until you reset it, so a later message is a follow-up to
  that same agent. You send a task. The command returns immediately,
  with an id, before the work is finished. It writes its answer back
  to you, not to the user. You can have up to six. Each can use a
  different model from you: fable and opus run as Claude, grok-* runs
  as Grok. Unless you pass --readonly, it may edit the repo and it
  skips approval prompts.
when-to-use: >
  A code review, a second look at a change, or a long look through the
  repo that should go on while you keep talking to the user. Also when
  you want a named agent you can send follow-ups to, when that work
  should be done by a different model, or when several of those agents
  should run at the same time.
---

# Co-agent

You (the lead) have an inner agent the way the user has you. Same tree, own
session, replies to you. The human never talks to it.

**If you are that inner agent, stop. Do not run `coagent`.**

CLI: `coagent`. Send returns immediately. The inner session persists until
`reset`. The default bypasses approvals. `--readonly` is enforced by the
harness and sticks on that colleague.

## When

| Need | Use |
|------|-----|
| One slow command (test, build, grep) | Bash, backgrounded |
| Grok-family one-shot work | `spawn_subagent` — Grok wakes you when the child finishes |
| Standing colleague, named parallel tapes, spend, or the other model family | `coagent` |

Do not run `spawn_subagent` and `coagent` on the same job. The user talks
only to you; you manage the colleagues.

A Claude lead backgrounds `wait` because it blocks. A Grok lead backgrounds
`coagent @name wait <id>` in the same shell. A login shell (`bash -lc`) does
not see the session id.

`coagent doctor` prints which lead you are.

## Talk to it

Your message *is* the job. There is no digest of prior consults. The inner
agent also has paths to the lead transcript and can grep them — do not paste
the whole user conversation, and do not tell it to read those files whole.

For anything long, `--brief-file path`. An argv brief is parsed by the
shell first; backticks in it execute.

```bash
coagent "review the diff"
coagent @review --brief-file /tmp/review.md --model fable --effort high --cwd /path/to/worktree --readonly
```

Busy send interrupts that colleague (steer). `later` queues behind the
current turn.

```bash
coagent later "also check migrations"
coagent stop                  # kill the running turn; queue stays
```

Keep talking to the user after send. Collect the answer when you need it:

| Command | What you get |
|---------|----------------|
| `coagent` | Snapshot: who is working, recent consults |
| `coagent log` | Consults — what you asked, what it answered |
| `coagent wait` / `wait <id>` | Stream until idle (or that turn), then print consults in full |
| `coagent wait --all` | Every colleague; print as each lands |
| `coagent watch` | Raw inner transcript |
| `coagent agents` | Roster, state, elapsed, spend |

`wait <id>` finds that turn when several leads share this checkout and no
session id is set, and refuses when the id is missing or in more than one
inbox. `agents` shows the running turn's model and read-only flag, not the
previous tape: `starting` until the inner process is up, then `reading`.

## Tapes

`coagent reset` starts a new tape for `@main`. Named colleagues keep theirs.
`coagent @name reset` (or `coagent reset @name`) starts a new tape for that
colleague, and the next send does not resume the old one. Old tapes stay on
disk (`sessions`, `resume <id>`). Reset between unrelated jobs. If you do
not reset that name, the next send continues its tape, so say that prior
conclusions are stale.

`@main` is the default thinking partner and follows your model and effort.
`coagent @name "…"` starts or continues a named colleague — own tape,
inbox, and lock. Cap is 6; reuse or reset rather than minting another.

`--cwd <dir>` is that colleague's working tree. It sticks. A different
directory starts a new tape. With none set, the colleague uses the lead's
checkout.

`--readonly` sticks. Grok runs in the read-only sandbox, without
always-approve. Claude runs dontAsk, with write tools and MCP removed, and
a prompt is denied instead of asked. `--read-write` clears it. A change
starts a new tape. A sentence in the brief does not.

## Models

`--model` on a send may pick the other family: `fable` / `opus` /
`claude-*` drive Claude Code; `grok-*` drives Grok. No `--model` stays
your family. Switching family on a colleague starts a new tape.

`--effort` sets reasoning effort (`minimal`, `low`, `medium`, `high`,
`xhigh`, `max`). No `--effort` follows the lead. Named colleagues may
default cheaper via persona `workerEffort` / `effort.<agent>`.

## Mid-job

Workers can ping you while they run.

- `notify` — a finding that changes the plan. Never progress.
- `ask` — the worker blocks until you `coagent answer <id> "…"`. Print
  asks in full; a clipped question gets a guessed answer.

Claude Code has no wake-on-child-done. Arm **once per session**:

```bash
coagent pings --follow
coagent pings                 # new flags since last read
coagent asks
coagent answer <id> "…"
```

A coagent turn does not wake a Grok lead. Background `coagent @name wait <id>`
to collect it. Do not arm `pings --follow`. Workers finish the turn instead
of `ask` / `notify`.
