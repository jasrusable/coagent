# Co-agent

The lead agent's standing colleague. Same idea as Grok is an agent for the human: the co-agent is an agent for the lead.

```
You (human) → Lead (this Grok / Claude) → one co-agent
```

One colleague **per harness session**. A different Grok window has a different co-agent. Messages **resume** that colleague's transcript. `reset` archives the tape and starts a new one; nothing is deleted.

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
coagent "review this diff"             # enqueue, wait, resume the standing thread
coagent --interrupt "stop, do this"    # kill the current turn, this message next
coagent status                         # gen, queue, last reply
coagent watch                          # live tail
coagent reset                          # archive this gen, start a fresh transcript
coagent sessions                       # list generations
coagent resume <id>                    # make an old gen current
coagent log                            # consults in the current gen (newest first)
coagent search "widget"                # search this session's generations
coagent gc                             # drop empty archived gens; trim old inbox rows
coagent doctor
```

Default model, effort, Grok `--agent`, and `--cwd` follow the lead session. Override model this turn with `--model grok-4.6` / `--model claude`. Progress streams on stderr; for a long review, background the command in the harness.

A second `coagent "…"` while one is in flight **queues**. `--interrupt` preempts the current turn and keeps the rest of the queue unless you also pass `--clear-queue`.

`--peer`, `ask`, `bg`, `join`, and `peers` are gone. There is one colleague.

## Layout

```
~/.coagent/state/<leadSessionId>/
  context.md / context.json     # digest of user ⇄ lead
  current                       # generation id
  gens/<genId>/
    meta.json                   # peer session id, model, last marker
    inbox.json                  # queued / running / done consults
    last_reply.md
    outbox/
```

`reset` writes a new `gens/<id>` and points `current` at it. `resume` points back.

## Persona

Default: `~/.coagent/persona.md`. Named: `~/.coagent/personas/<name>.md` via `--persona <name>`.

## Develop

```sh
npm test
./install.sh
```
