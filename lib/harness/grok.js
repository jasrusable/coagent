'use strict';

// Grok harness adapter: how coagent finds the lead Grok, reads its tape,
// and drives an inner `grok`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const GROK_HOME = process.env.GROK_HOME || path.join(HOME, '.grok');
const SESSIONS = path.join(GROK_HOME, 'sessions');
const ACTIVE = path.join(GROK_HOME, 'active_sessions.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function ancestorPids() {
  const out = [];
  let pid = process.pid;
  for (let i = 0; i < 48; i++) {
    out.push(pid);
    let ppid;
    try {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' });
      ppid = parseInt(String(r.stdout || '').trim(), 10);
    } catch { break; }
    if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
    pid = ppid;
  }
  return out;
}

function cwdChain() {
  const chain = [];
  let cur = process.cwd();
  for (let i = 0; i < 20; i++) {
    chain.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return chain;
}

function sessionDir(sessionId, cwd) {
  if (!sessionId) return null;
  if (cwd) {
    const p = path.join(SESSIONS, encodeURIComponent(cwd), sessionId);
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(SESSIONS)) return null;
  try {
    for (const d of fs.readdirSync(SESSIONS)) {
      const p = path.join(SESSIONS, d, sessionId);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* */ }
  return null;
}

function sessionPaths(sessionId, cwd) {
  const dir = sessionDir(sessionId, cwd);
  if (!dir) return { dir: null, transcript: null, context: null };
  return {
    dir,
    transcript: path.join(dir, 'updates.jsonl'),
    context: path.join(dir, 'chat_history.jsonl'),
  };
}

function makeLead(sessionId, pin, dir) {
  const resolved = dir || sessionDir(sessionId, process.cwd()) || sessionDir(sessionId);
  const paths = resolved
    ? {
      dir: resolved,
      transcript: path.join(resolved, 'updates.jsonl'),
      context: path.join(resolved, 'chat_history.jsonl'),
    }
    : { dir: null, transcript: null, context: null };
  return {
    harness: 'grok',
    sessionId,
    pin,
    sessionDir: paths.dir,
    transcriptPath: paths.transcript,
    contextPath: paths.context,
  };
}

function readActive() {
  if (!fs.existsSync(ACTIVE)) return [];
  const raw = readJson(ACTIVE, []);
  return Array.isArray(raw) ? raw : (raw.sessions || []);
}

function leadFromTranscript(p) {
  // …/sessions/<encoded-cwd>/<sid>/updates.jsonl
  if (path.basename(p) !== 'updates.jsonl') return null;
  const dir = path.dirname(p);
  return makeLead(path.basename(dir), 'explicit-path', dir);
}

function detect() {
  const envSid = process.env.COAGENT_LEAD_SESSION_ID || process.env.GROK_SESSION_ID || null;
  if (envSid) {
    const dir = sessionDir(envSid, process.cwd()) || sessionDir(envSid);
    if (dir) return makeLead(envSid, process.env.GROK_SESSION_ID === envSid ? 'env' : 'coagent-env', dir);
    // Worker / tests may know the id before the session dir exists.
    if (process.env.GROK_SESSION_ID === envSid) return makeLead(envSid, 'env-id', null);
    return null;
  }

  const active = readActive();
  const ancestors = new Set(ancestorPids());
  const byAncestor = active.filter((s) => s && s.session_id && s.pid && ancestors.has(s.pid) && isAlive(s.pid));
  if (byAncestor.length > 1) return { ambiguous: `${byAncestor.length} Grok sessions in ancestry` };
  if (byAncestor.length === 1) {
    const s = byAncestor[0];
    const dir = sessionDir(s.session_id, s.cwd);
    if (dir) return makeLead(s.session_id, 'ancestor-pid', dir);
  }

  const chain = cwdChain();
  const byCwd = active.filter((s) => s && s.session_id && s.cwd && chain.includes(s.cwd) && (!s.pid || isAlive(s.pid)));
  if (byCwd.length > 1) return { ambiguous: `${byCwd.length} active Grok sessions for this cwd` };
  if (byCwd.length === 1) {
    const s = byCwd[0];
    const dir = sessionDir(s.session_id, s.cwd);
    if (dir) return makeLead(s.session_id, 'cwd-active', dir);
  }
  return null;
}

function describeSession(paths) {
  const empty = { modelId: null, effort: null, agent: null, cwd: null, title: null };
  const dir = paths && paths.dir;
  if (!dir || !fs.existsSync(dir)) return empty;
  const summary = readJson(path.join(dir, 'summary.json'), {});
  const signals = readJson(path.join(dir, 'signals.json'), {});
  return {
    modelId: summary.current_model_id || summary.model || signals.primaryModelId || null,
    effort: summary.reasoning_effort || null,
    agent: summary.agent_name || null,
    cwd: (summary.info && summary.info.cwd) || null,
    title: summary.generated_title || summary.title || null,
  };
}

// usage.json stores costUsdTicks at 1e10 per USD.
const TICKS_PER_USD = 1e10;

function runningCost(paths) {
  const dir = paths && paths.dir;
  if (!dir) return null;
  const session = readJson(path.join(dir, 'usage.json'), {}).session;
  const n = session && session.costUsdTicks;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n / TICKS_PER_USD;
}

// Unenforced read-only exists because the sandbox cannot start on some Macs
// (see sandboxBlocker). Nothing in grok stops its writes there: dontAsk did
// not, in testing. The rules and an after-turn tree check are all it has.
function readOnlyKind(access) {
  if (access === 'read-only') return 'enforced';
  if (access === 'read-only-unenforced') return 'unenforced';
  return null;
}

// grok's sandbox denies these container-runtime sockets. If one is a symlink
// to a path outside this list it refuses to start, under every profile, and
// the list is not configurable. OrbStack does exactly that:
// /var/run/docker.sock -> ~/.orbstack/run/docker.sock.
const RUNTIME_SOCKETS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/podman/podman.sock',
  '/var/run/podman/podman.sock',
  '/run/containerd/containerd.sock',
  '/var/run/containerd/containerd.sock',
  '~/.docker/desktop/docker.sock',
  '~/.docker/run/docker.sock',
];

// Tests point this at temp paths; a real machine's /var/run is not theirs.
function socketList() {
  const env = process.env.COAGENT_GROK_SOCKETS;
  return env ? env.split(':').filter(Boolean) : RUNTIME_SOCKETS;
}

function expandHome(p, home) {
  return p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
}

// The listed path with only its directories resolved (/var is /private/var on
// macOS). Resolving the last component would follow the very link in question.
function withRealDir(p) {
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

function linkTarget(p) {
  try { return fs.realpathSync(p); } catch {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
}

// { endpoint, target } for the first listed socket that is a symlink out of
// the list, or null when grok's sandbox can start.
function sandboxBlocker({ endpoints = socketList(), home = HOME } = {}) {
  const listed = endpoints.map((p) => expandHome(p, home));
  const allowed = new Set(listed.flatMap((p) => [p, withRealDir(p)]));
  for (const endpoint of listed) {
    let st;
    try { st = fs.lstatSync(endpoint); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    const target = linkTarget(endpoint);
    if (!allowed.has(target)) return { endpoint, target };
  }
  return null;
}

const tilde = (p) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);

function preflight(access, opts) {
  if (readOnlyKind(access) !== 'enforced') return null;
  const b = sandboxBlocker(opts);
  if (!b) return null;
  return [
    `grok's read-only sandbox cannot start here: ${tilde(b.endpoint)} is a symlink to ${tilde(b.target)},`,
    `outside grok's fixed runtime-socket deny list (OrbStack does this), so grok refuses to run.`,
    `coagent will not drop the sandbox silently. Either:`,
    `  --model opus --readonly     enforced read-only, via Claude`,
    `  --readonly-unenforced       Grok without the sandbox; told not to write, changes flagged, not stopped`,
  ].join('\n');
}

function buildArgs({ prompt, effort, model, permissionMode, rules, sessionId, resume, agent, cwd, access }) {
  // Read-only is the sandbox (project writes refused) plus dontAsk, so a
  // command that is not already a read still fails in a headless run.
  // --always-approve would skip that check. Unenforced keeps dontAsk and
  // drops only the sandbox.
  const readOnly = readOnlyKind(access);
  const base = [
    '-p', prompt,
    '--output-format', 'json',
    '--verbatim',
    '--permission-mode', readOnly ? 'dontAsk' : (permissionMode || 'bypassPermissions'),
    '--rules', rules,
  ];
  if (readOnly === 'enforced') base.push('--sandbox', 'read-only');
  if (!readOnly) base.push('--always-approve');
  if (effort) base.push('--effort', effort);
  if (model) base.push('--model', model);
  if (agent) base.push('--agent', agent);
  if (cwd) base.push('--cwd', cwd);
  if (resume) return [...base, '--resume', sessionId];
  return [...base, '--session-id', sessionId];
}

function scrubEnv(env) {
  delete env.GROK_AGENT;
  delete env.GROK_SESSION_ID;
  return env;
}

function acceptsModel(id) {
  return /^grok/i.test(String(id || ''));
}

function rulesLines(lead) {
  return [
    `Lead full history (ACP event log — grep, do not read the whole file): ${lead.transcriptPath || '(unknown)'}`,
    `Lead current model context (compacted): ${lead.contextPath || '(unknown)'}`,
  ];
}

module.exports = {
  id: 'grok',
  label: 'Grok',
  binName: 'grok',
  home: GROK_HOME,
  detect,
  leadFromTranscript,
  sessionPaths,
  describeSession,
  buildArgs,
  readOnlyKind,
  preflight,
  sandboxBlocker,
  RUNTIME_SOCKETS,
  runningCost,
  scrubEnv,
  acceptsModel,
  rulesLines,
  formatUpdate: (rec, home) => require('../render.js').formatGrokUpdate(rec, home),
};
