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

function buildArgs({ prompt, effort, model, permissionMode, rules, sessionId, resume, agent, cwd }) {
  const base = [
    '-p', prompt,
    '--output-format', 'json',
    '--verbatim',
    '--always-approve',
    '--permission-mode', permissionMode || 'bypassPermissions',
    '--rules', rules,
  ];
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
  scrubEnv,
  acceptsModel,
  rulesLines,
  formatUpdate: (rec, home) => require('../render.js').formatGrokUpdate(rec, home),
};
