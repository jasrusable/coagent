'use strict';

// Claude Code harness adapter: how coagent finds the lead Claude session,
// reads its transcript, and drives an inner `claude`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = path.join(CONFIG, 'projects');

// Claude names a project dir after its cwd with each non-alphanumeric character
// replaced by a dash: /Users/jason/x → -Users-jason-x
function slug(cwd) { return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'); }

function transcriptFor(sessionId, cwd) {
  if (!sessionId) return null;
  if (cwd) {
    const p = path.join(PROJECTS, slug(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(PROJECTS)) return null;
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* */ }
  return null;
}

// Claude keeps one append-only transcript; there is no separate compacted tape.
function sessionPaths(sessionId, cwd) {
  const t = transcriptFor(sessionId, cwd);
  if (!t) return { dir: null, transcript: null, context: null };
  return { dir: path.dirname(t), transcript: t, context: null };
}

function makeLead(sessionId, pin, transcript) {
  const t = transcript || transcriptFor(sessionId, process.cwd()) || transcriptFor(sessionId);
  return {
    harness: 'claude',
    sessionId,
    pin,
    sessionDir: t ? path.dirname(t) : null,
    transcriptPath: t || null,
    contextPath: null,
  };
}

function leadFromTranscript(p) {
  if (!p.endsWith('.jsonl') || path.basename(p) === 'updates.jsonl') return null;
  return makeLead(path.basename(p, '.jsonl'), 'explicit-path', p);
}

function detect() {
  const envSid = process.env.COAGENT_LEAD_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!envSid) return null;
  const own = process.env.CLAUDE_CODE_SESSION_ID === envSid;
  const t = transcriptFor(envSid, process.cwd()) || transcriptFor(envSid);
  if (t) return makeLead(envSid, own ? 'env' : 'coagent-env', t);
  // A brand-new session may not have flushed a transcript yet.
  if (own) return makeLead(envSid, 'env-id', null);
  return null;
}

// Read the tail of a large append-only transcript rather than the whole file.
const TAIL_BYTES = 512 * 1024;

function tailRecords(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let chunk;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0 && chunk.includes('\n')) chunk = chunk.slice(chunk.indexOf('\n') + 1);
  const out = [];
  for (const line of chunk.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial write */ }
  }
  return out;
}

function acceptsModel(id) {
  return /^(claude|opus|sonnet|haiku|fable)/i.test(String(id || ''));
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function describeSession(paths) {
  const empty = { modelId: null, effort: null, agent: null, cwd: null, title: null };
  const file = paths && paths.transcript;
  if (!file || !fs.existsSync(file)) return empty;
  let records;
  try { records = tailRecords(file); } catch { return empty; }
  const out = { ...empty };
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'ai-title' && rec.aiTitle) out.title = rec.aiTitle;
    if (rec.cwd) out.cwd = rec.cwd;
    if (rec.type !== 'assistant') continue;
    const model = rec.message && rec.message.model;
    // Interrupted and errored turns are stamped `<synthetic>`; they describe no
    // real model, so they must not become the inner agent's --model.
    if (!model || !acceptsModel(model)) continue;
    out.modelId = model;
    if (rec.effort && EFFORTS.has(rec.effort)) out.effort = rec.effort;
  }
  return out;
}

// Write and subagent tools. Bash stays: dontAsk plus --permission-prompts none
// denies anything that is not already a read, which is what a review runs.
const READ_ONLY_DENIED_TOOLS = 'Edit,Write,NotebookEdit,Task';

function runningCost() {
  // Dollars arrive on the turn result, not in a file this process can read
  // while the turn is still open.
  return null;
}

function buildArgs({ prompt, effort, model, permissionMode, rules, sessionId, resume, agent, access }) {
  // No --cwd: the child is spawned in the colleague's directory.
  // --append-system-prompt is the analogue of grok's --rules, and disables
  // system-prompt snapshotting so the persona is re-applied on every resumed turn.
  const readOnly = access === 'read-only';
  const base = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', readOnly ? 'dontAsk' : (permissionMode || 'bypassPermissions'),
    '--append-system-prompt', rules,
  ];
  if (readOnly) {
    base.push(
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--disallowed-tools', READ_ONLY_DENIED_TOOLS,
    );
  }
  if (effort && EFFORTS.has(effort)) base.push('--effort', effort);
  if (model) base.push('--model', model);
  if (agent) base.push('--agent', agent);
  if (resume) return [...base, '--resume', sessionId];
  return [...base, '--session-id', sessionId];
}

// Without this the inner claude inherits the lead's identity and messaging
// socket, and reports itself as a child of the lead session.
function scrubEnv(env) {
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_EFFORT',
    'CLAUDE_PID',
  ]) delete env[k];
  return env;
}


function rulesLines(lead) {
  return [
    `Lead transcript (append-only JSONL — grep, do not read the whole file): ${lead.transcriptPath || '(unknown)'}`,
  ];
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  binName: 'claude',
  home: CONFIG,
  detect,
  leadFromTranscript,
  sessionPaths,
  describeSession,
  buildArgs,
  runningCost,
  scrubEnv,
  acceptsModel,
  rulesLines,
  formatUpdate: (rec, home) => require('../render.js').formatClaudeUpdate(rec, home),
};
