'use strict';

// Which harness is the lead? Derived from the environment (who the human is
// talking to). The inner agent can be a different family: --model fable/opus
// drives Claude, grok-* drives Grok, regardless of the lead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const claude = require('./claude.js');
const grok = require('./grok.js');

// Probe order only matters for reporting; selection is by pin strength.
const ADAPTERS = [claude, grok];

function byId(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

// Inner family from a model id. Claude matches opus/fable/sonnet/haiku;
// Grok matches everything else that looks like a grok id.
function adapterForModel(id) {
  if (!id) return null;
  return ADAPTERS.find((a) => a.acceptsModel(id)) || null;
}

// How much we trust a lead: an explicit path or env var beats a registry guess.
const PIN_RANK = {
  'explicit-path': 0,
  env: 1,
  'coagent-env': 1,
  'env-id': 1,
  'ancestor-pid': 2,
  'cwd-active': 3,
};
const rank = (pin) => (PIN_RANK[pin] != null ? PIN_RANK[pin] : 9);

function fromTranscript(p) {
  for (const a of ADAPTERS) {
    const lead = a.leadFromTranscript(p);
    if (lead) return { harness: a, lead };
  }
  return null;
}

// Returns { harness, lead } or { error }.
function resolve() {
  const explicit = process.env.COAGENT_LEAD_TRANSCRIPT || null;
  const pinnedId = process.env.COAGENT_HARNESS || null;

  if (pinnedId) {
    const a = byId(pinnedId);
    if (!a) return { error: `unknown harness ${pinnedId}` };
    if (explicit && fs.existsSync(explicit)) {
      const hit = a.leadFromTranscript(explicit);
      if (hit) return { harness: a, lead: hit };
    }
    const lead = a.detect();
    if (lead && lead.sessionId) return { harness: a, lead };
    return { error: `no lead ${a.label} session found (COAGENT_HARNESS=${pinnedId})` };
  }

  if (explicit && fs.existsSync(explicit)) {
    const hit = fromTranscript(explicit);
    if (hit) return hit;
  }

  const hits = [];
  const ambiguous = [];
  for (const a of ADAPTERS) {
    const lead = a.detect();
    if (!lead) continue;
    if (lead.ambiguous) { ambiguous.push(`${a.label}: ${lead.ambiguous}`); continue; }
    hits.push({ harness: a, lead });
  }

  if (!hits.length) {
    const why = ambiguous.length ? ambiguous.join('; ') : 'set CLAUDE_CODE_SESSION_ID or GROK_SESSION_ID';
    return { error: `no lead session found (${why})` };
  }

  hits.sort((x, y) => rank(x.lead.pin) - rank(y.lead.pin));
  const best = rank(hits[0].lead.pin);
  const tied = hits.filter((h) => rank(h.lead.pin) === best);
  if (tied.length > 1) {
    const list = tied.map((h) => `${h.harness.label} ${h.lead.sessionId} (${h.lead.pin})`).join(', ');
    return { error: `ambiguous lead — ${tied.length} harnesses claim this session: ${list}` };
  }
  return hits[0];
}

// PATH first so a test or a shim on PATH wins, but never a cmux wrapper shim:
// the inner agent is a detached background child and should not register as one
// of the user's own sessions.
function resolveBin(adapter) {
  const override = process.env[`COAGENT_${adapter.id.toUpperCase()}_BIN`];
  if (override) return override;
  let found = null;
  try {
    const r = spawnSync('which', [adapter.binName], { encoding: 'utf8' });
    if (r.status === 0) found = String(r.stdout || '').trim() || null;
  } catch { /* */ }
  if (found && !found.includes('cmux-cli-shims')) return found;
  const local = path.join(HOME, '.local', 'bin', adapter.binName);
  if (fs.existsSync(local)) return local;
  return found || adapter.binName;
}

module.exports = { ADAPTERS, byId, adapterForModel, resolve, resolveBin, rank };
