---
name: coagent
description: >
  Coagent is your standing inner agent (@main): same working tree, own
  persistent session, replies to you not the user. Send is background and
  returns immediately; the tape continues until reset. That lets you keep
  talking to the user while a colleague reviews, stress-tests, or works
  in parallel, and hand a job to a different model family or effort
  (--model fable, opus, grok; --effort higher or lower).
when-to-use: >
  Reviews; stress-test the thing in front of you (code, idea, requirement,
  whatever it is); parallel work (keep talking to the user, or several
  named colleagues at once); hand a job to a smarter, cheaper, or
  different-family model at higher or lower effort.
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

- **Grok lead:** `spawn_subagent` for Grok-family work. `coagent` for
  persistent named tapes and for `--model fable` / `opus`.
- **Claude Code lead:** `coagent` is the inner-agent path. `wait` is a
  blocking stream — background it.

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

`wait <id>` prints that consult when the turn finishes. That output is the
result. Background it when a long command would be parked, and read the
output when it completes. `agents` shows `starting` until the inner process
is up, then `reading`, with cost once the vendor has reported any.

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

Grok already wakes you when a background agent finishes. Do not arm a
follower. On a Grok lead, workers are told to finish the turn rather than
`ask` / `notify`, because there is usually nobody listening mid-turn.
