# Co-agent

Harness-agnostic **peer agents** for Claude Code and Grok Build.

```
You (human) → Lead agent → Coagent peer(s)
```

- **Checkout:** `~/projects/coagent` (this repo)
- **Home:** `~/.coagent/` (runtime; `state/` is not in git)
- **Binary:** `~/.local/bin/coagent`
- **Shim:** `~/.claude/bin/coagent`

## Install

```sh
git clone git@github.com:jasrusable/coagent.git ~/projects/coagent
cd ~/projects/coagent
./install.sh
coagent doctor
```

Re-run `./install.sh` after pulling. Session state in `~/.coagent/state` is left alone. `persona.md` is seeded only if you do not already have one.

## Peers

Each lead conversation can have **multiple independent peers**. Peers share the lead **digest** (conversation context) but have separate:

- chat session / memory
- `state.json`
- outbox
- jobs

| Flag | Behavior |
|------|----------|
| *(none)* | peer **`main`** (default standing peer) |
| `--peer <id>` | resume that peer, or **create** with that id |
| `--peer new` | mint a **UUID**, create, print id |

```bash
coagent "…"                                    # peer main
coagent --peer new "…"                         # new uuid peer
coagent --peer 019f… "…"                       # resume / create that id
coagent --model claude/opus "…"                # harness + model (cannot mismatch)
coagent --peer new --model claude --persona review --save "…"
```

**`--model`** is `backend` or `backend/modelId` (e.g. `claude`, `claude/opus`, `grok`). Not a bare model name — avoids `grok`+`opus` mismatches.
Sticky model + persona path set on **first message** for a peer. Per-call flags override **this turn only**, unless **`--save`**.

## Usage

```bash
coagent "…"
coagent bg [--parallel] [--peer …] "…"
coagent join [jobId] [--raw] [timeout_s]
coagent jobs
coagent peers
coagent status | doctor | lead | digest | transcript
coagent reset [--peer id] [--all]     # clear session thread; keep sticky config
coagent rm --peer <id> [--force]      # delete peer dir (main needs --force)
coagent watch [-f] [--timeout N]
coagent outbox [list|path|cat <file>] # this peer's outbox

coagent --model claude|grok|claude/<id>|grok/<id> …
coagent --persona <name|path> …
```

### Parallelism

- **Different peers** can run at the same time.
- Same peer: default `bg` is one-at-a-time; `bg --parallel` uses an **isolated** session for that job.
- Foreground on peer A does **not** stop peer B.

### join --raw

```bash
coagent join 5a4e0008 --raw
```

## Layout

```
~/.coagent/state/<leadSessionId>/
  context.md / context.json     # shared lead digest
  peers/
    main/
      state.json
      last_reply.md
      outbox/
      jobs/
    <uuid>/
      …
```

Legacy flat `state.json` / `outbox` / `jobs` under the lead dir are **migrated into `peers/main/`** on first use.

## Persona & model

- Default persona: `~/.coagent/persona.md` (instructions + effort/permissions; **prefer not** to put model here).
- Named personas: `~/.coagent/personas/<name>.md` via `--persona <name>`.
- Model: `--model backend[/id]` / `COAGENT_MODEL` / peer sticky. No separate `--backend`.

## Pinning (Grok)

Order: `GROK_SESSION_ID` / `COAGENT_LEAD_SESSION_ID` → ancestor PID → cwd → mtime.

## Doctor

```bash
coagent doctor
```

## Develop

```sh
npm test
./install.sh
```
