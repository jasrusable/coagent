'use strict';

/**
 * Per-lead-session generations + inbox.
 * One standing co-agent per harness session; reset archives, resume restores.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function newId(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(2).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, obj) {
  atomicWrite(p, JSON.stringify(obj, null, 2));
}

function leadDir(stateDir, leadSid, create = true) {
  const d = path.join(stateDir, leadSid);
  if (create) ensureDir(d);
  return d;
}

function gensDir(stateDir, leadSid, create = true) {
  const d = path.join(leadDir(stateDir, leadSid, create), 'gens');
  if (create) ensureDir(d);
  return d;
}

function genDir(stateDir, leadSid, genId, create = true) {
  const d = path.join(gensDir(stateDir, leadSid, create), genId);
  if (create) ensureDir(d);
  return d;
}

function currentPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'current');
}

function readCurrent(stateDir, leadSid) {
  const p = currentPath(stateDir, leadSid);
  if (!fs.existsSync(p)) return null;
  const id = fs.readFileSync(p, 'utf8').trim();
  return id || null;
}

function writeCurrent(stateDir, leadSid, genId) {
  atomicWrite(currentPath(stateDir, leadSid), `${genId}\n`);
}

function liftFile(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  ensureDir(path.dirname(dest));
  try { fs.renameSync(src, dest); } catch {
    try { fs.copyFileSync(src, dest); } catch { /* */ }
  }
}

function liftDir(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    ensureDir(path.dirname(dest));
    try { fs.renameSync(src, dest); return; } catch { /* */ }
  }
  ensureDir(dest);
  for (const f of fs.readdirSync(src)) {
    liftFile(path.join(src, f), path.join(dest, f));
  }
}

function emptyMeta(id) {
  return {
    id,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    sessionId: null,
    backend: null,
    model: null,
    lastUuid: null,
    lastQuestion: null,
    lastQuestionAt: null,
    lastError: null,
    lastMeta: null,
    personaPath: null,
  };
}

function migrateLayout(stateDir, leadSid) {
  const ld = path.join(stateDir, leadSid);
  const legacyFlat = path.join(stateDir, `${leadSid}.json`);
  if (fs.existsSync(legacyFlat)) liftFile(legacyFlat, path.join(ld, 'state.json'));

  const mainD = path.join(ld, 'peers', 'main');
  if (fs.existsSync(mainD) && fs.statSync(mainD).isDirectory()) {
    liftFile(path.join(mainD, 'state.json'), path.join(ld, 'state.json'));
    liftFile(path.join(mainD, 'last_reply.md'), path.join(ld, 'last_reply.md'));
    liftFile(path.join(mainD, 'last_reply.json'), path.join(ld, 'last_reply.json'));
    liftDir(path.join(mainD, 'outbox'), path.join(ld, 'outbox'));
    liftDir(path.join(mainD, 'jobs'), path.join(ld, 'jobs'));
  }

  if (readCurrent(stateDir, leadSid)) return readCurrent(stateDir, leadSid);

  const existingGens = listGenIds(stateDir, leadSid);
  if (existingGens.length) {
    const live = existingGens.find((id) => !loadMeta(stateDir, leadSid, id).archivedAt) || existingGens[0];
    writeCurrent(stateDir, leadSid, live);
    return live;
  }

  const oldState = readJson(path.join(ld, 'state.json'), null);
  const hasLegacy = oldState || fs.existsSync(path.join(ld, 'last_reply.md')) || fs.existsSync(path.join(ld, 'outbox'));
  if (!hasLegacy) return null;

  const id = newId();
  const gd = genDir(stateDir, leadSid, id);
  const meta = emptyMeta(id);
  if (oldState) {
    meta.sessionId = oldState.sessionId || null;
    meta.backend = oldState.backend || oldState.backendChoice || null;
    meta.model = oldState.model || null;
    meta.lastUuid = oldState.lastUuid || null;
    meta.lastQuestion = oldState.lastQuestion || null;
    meta.lastQuestionAt = oldState.lastQuestionAt || null;
    meta.lastError = oldState.lastError || null;
    meta.lastMeta = oldState.lastMeta || null;
    meta.personaPath = oldState.personaPath || null;
    meta.createdAt = oldState.createdAt || meta.createdAt;
  }
  writeJson(path.join(gd, 'meta.json'), meta);
  liftFile(path.join(ld, 'last_reply.md'), path.join(gd, 'last_reply.md'));
  liftFile(path.join(ld, 'last_reply.json'), path.join(gd, 'last_reply.json'));
  liftDir(path.join(ld, 'outbox'), path.join(gd, 'outbox'));
  writeCurrent(stateDir, leadSid, id);
  return id;
}

function listGenIds(stateDir, leadSid) {
  const root = path.join(leadDir(stateDir, leadSid, false), 'gens');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => {
    try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
  }).sort((a, b) => {
    const ma = loadMeta(stateDir, leadSid, a).createdAt || '';
    const mb = loadMeta(stateDir, leadSid, b).createdAt || '';
    return mb.localeCompare(ma);
  });
}

function loadMeta(stateDir, leadSid, genId) {
  const p = path.join(genDir(stateDir, leadSid, genId, false), 'meta.json');
  const raw = readJson(p, null);
  if (!raw) return emptyMeta(genId);
  return { ...emptyMeta(genId), ...raw, id: genId };
}

function saveMeta(stateDir, leadSid, meta) {
  writeJson(path.join(genDir(stateDir, leadSid, meta.id), 'meta.json'), meta);
}

function ensureCurrent(stateDir, leadSid) {
  migrateLayout(stateDir, leadSid);
  let id = readCurrent(stateDir, leadSid);
  if (id && fs.existsSync(genDir(stateDir, leadSid, id, false))) return id;
  id = newId();
  saveMeta(stateDir, leadSid, emptyMeta(id));
  writeCurrent(stateDir, leadSid, id);
  return id;
}

function archiveCurrent(stateDir, leadSid) {
  const id = readCurrent(stateDir, leadSid);
  if (!id) return null;
  const meta = loadMeta(stateDir, leadSid, id);
  if (!meta.archivedAt) {
    meta.archivedAt = new Date().toISOString();
    saveMeta(stateDir, leadSid, meta);
  }
  return id;
}

function startGeneration(stateDir, leadSid) {
  archiveCurrent(stateDir, leadSid);
  const id = newId();
  saveMeta(stateDir, leadSid, emptyMeta(id));
  writeCurrent(stateDir, leadSid, id);
  return id;
}

function resumeGeneration(stateDir, leadSid, genId) {
  const gd = genDir(stateDir, leadSid, genId, false);
  if (!fs.existsSync(gd)) return null;
  const cur = readCurrent(stateDir, leadSid);
  if (cur && cur !== genId) archiveCurrent(stateDir, leadSid);
  const meta = loadMeta(stateDir, leadSid, genId);
  meta.archivedAt = null;
  saveMeta(stateDir, leadSid, meta);
  writeCurrent(stateDir, leadSid, genId);
  return meta;
}

function inboxPath(stateDir, leadSid, genId) {
  return path.join(genDir(stateDir, leadSid, genId, false), 'inbox.json');
}

function loadInbox(stateDir, leadSid, genId) {
  return readJson(inboxPath(stateDir, leadSid, genId), []);
}

function saveInbox(stateDir, leadSid, genId, items) {
  writeJson(inboxPath(stateDir, leadSid, genId), items);
}

const INBOX_KEEP_DONE = 50;

function itemTime(it) {
  return (it && (it.finishedAt || it.startedAt || it.createdAt)) || '';
}

function sortInboxNewestFirst(items) {
  return [...(items || [])].sort((a, b) => itemTime(b).localeCompare(itemTime(a)));
}

function trimInbox(stateDir, leadSid, genId, keep = INBOX_KEEP_DONE) {
  const items = loadInbox(stateDir, leadSid, genId);
  const live = items.filter((i) => i.status === 'queued' || i.status === 'running');
  const settled = items.filter((i) => i.status !== 'queued' && i.status !== 'running');
  if (settled.length <= keep) return 0;
  const keepSettled = sortInboxNewestFirst(settled).slice(0, keep);
  const keepIds = new Set([...keepSettled, ...live].map((i) => i.id));
  const next = items.filter((i) => keepIds.has(i.id));
  saveInbox(stateDir, leadSid, genId, next);
  return settled.length - keepSettled.length;
}

function currentGeneration(stateDir, leadSid) {
  migrateLayout(stateDir, leadSid);
  const id = readCurrent(stateDir, leadSid);
  if (!id) return null;
  if (!fs.existsSync(genDir(stateDir, leadSid, id, false))) return null;
  return id;
}

function gcEmptyGens(stateDir, leadSid) {
  migrateLayout(stateDir, leadSid);
  const cur = readCurrent(stateDir, leadSid);
  let removed = 0;
  for (const id of listGenIds(stateDir, leadSid)) {
    if (id === cur) continue;
    const inbox = loadInbox(stateDir, leadSid, id);
    const meta = loadMeta(stateDir, leadSid, id);
    if (inbox.length === 0 && !meta.sessionId) {
      fs.rmSync(genDir(stateDir, leadSid, id, false), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function enqueue(stateDir, leadSid, genId, message, { front = false } = {}) {
  const items = loadInbox(stateDir, leadSid, genId);
  const item = {
    id: newId(),
    message,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  const next = front ? [item, ...items] : [...items, item];
  saveInbox(stateDir, leadSid, genId, next);
  trimInbox(stateDir, leadSid, genId);
  return item;
}

function updateItem(stateDir, leadSid, genId, itemId, patch) {
  const items = loadInbox(stateDir, leadSid, genId);
  const i = items.findIndex((x) => x.id === itemId);
  if (i < 0) return null;
  items[i] = { ...items[i], ...patch };
  saveInbox(stateDir, leadSid, genId, items);
  return items[i];
}

function findItem(stateDir, leadSid, genId, itemId) {
  return loadInbox(stateDir, leadSid, genId).find((x) => x.id === itemId) || null;
}

function nextQueued(stateDir, leadSid, genId) {
  return loadInbox(stateDir, leadSid, genId).find((x) => x.status === 'queued') || null;
}

function runningItem(stateDir, leadSid, genId) {
  return loadInbox(stateDir, leadSid, genId).find((x) => x.status === 'running') || null;
}

function interruptRunning(stateDir, leadSid, genId, { clearQueue = false } = {}) {
  const items = loadInbox(stateDir, leadSid, genId);
  let changed = false;
  const next = items.map((it) => {
    if (it.status === 'running') {
      changed = true;
      return { ...it, status: 'interrupted', finishedAt: new Date().toISOString() };
    }
    if (clearQueue && it.status === 'queued') {
      changed = true;
      return { ...it, status: 'interrupted', finishedAt: new Date().toISOString(), error: 'cleared' };
    }
    return it;
  });
  if (changed) saveInbox(stateDir, leadSid, genId, next);
  return next.filter((it) => it.status === 'interrupted');
}

function lockPath(stateDir, leadSid, genId) {
  return path.join(genDir(stateDir, leadSid, genId, false), 'worker.lock');
}

function workerPath(stateDir, leadSid, genId) {
  return path.join(genDir(stateDir, leadSid, genId, false), 'worker.json');
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tryLock(stateDir, leadSid, genId, pid) {
  const p = lockPath(stateDir, leadSid, genId);
  ensureDir(path.dirname(p));
  if (fs.existsSync(p)) {
    const existing = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    if (isAlive(existing) && existing !== pid) return false;
    try { fs.unlinkSync(p); } catch { /* */ }
  }
  try {
    fs.writeFileSync(p, `${pid}\n`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(stateDir, leadSid, genId, pid) {
  const p = lockPath(stateDir, leadSid, genId);
  if (!fs.existsSync(p)) return;
  const existing = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  if (existing === pid || !isAlive(existing)) {
    try { fs.unlinkSync(p); } catch { /* */ }
  }
}

function readWorker(stateDir, leadSid, genId) {
  return readJson(workerPath(stateDir, leadSid, genId), null);
}

function writeWorker(stateDir, leadSid, genId, info) {
  writeJson(workerPath(stateDir, leadSid, genId), info);
}

function workerAlive(stateDir, leadSid, genId) {
  const p = lockPath(stateDir, leadSid, genId);
  if (!fs.existsSync(p)) return false;
  const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return isAlive(pid);
}

/** If the worker is dead, fail any item still marked running so the queue can move. */
function reapStale(stateDir, leadSid, genId) {
  const w = readWorker(stateDir, leadSid, genId);
  if (workerAlive(stateDir, leadSid, genId)) return { ids: [], orphanPid: null };
  const orphanPid = (w && w.childPid) || null;
  const items = loadInbox(stateDir, leadSid, genId);
  const reaped = [];
  const next = items.map((it) => {
    if (it.status !== 'running') return it;
    reaped.push(it.id);
    return {
      ...it,
      status: 'failed',
      error: 'stale (worker gone)',
      finishedAt: new Date().toISOString(),
    };
  });
  if (reaped.length) saveInbox(stateDir, leadSid, genId, next);
  return { ids: reaped, orphanPid };
}

function detectGrokLeadModel(sessionDir) {
  const empty = { modelId: null, effort: null, agent: null, cwd: null };
  if (!sessionDir || !fs.existsSync(sessionDir)) return empty;
  const summary = readJson(path.join(sessionDir, 'summary.json'), {});
  const signals = readJson(path.join(sessionDir, 'signals.json'), {});
  const modelId = summary.current_model_id
    || summary.model
    || signals.primaryModelId
    || null;
  const effort = summary.reasoning_effort || null;
  const agent = summary.agent_name || null;
  const cwd = (summary.info && summary.info.cwd) || null;
  return { modelId, effort, agent, cwd };
}

function detectClaudeLeadModel(records) {
  const empty = { modelId: null, effort: null, agent: null, cwd: null };
  if (!Array.isArray(records)) return empty;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    const model = (rec && rec.message && rec.message.model) || rec.model || null;
    if (model) return { modelId: model, effort: null, agent: null, cwd: null };
  }
  return empty;
}

function searchGens(stateDir, leadSid, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const id of listGenIds(stateDir, leadSid)) {
    const gd = genDir(stateDir, leadSid, id, false);
    const meta = loadMeta(stateDir, leadSid, id);
    const files = [
      path.join(gd, 'last_reply.md'),
      path.join(gd, 'last_reply.json'),
      path.join(gd, 'meta.json'),
      inboxPath(stateDir, leadSid, id),
    ];
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(q)) {
          hits.push({
            genId: id,
            archived: !!meta.archivedAt,
            file: f,
            line: idx + 1,
            text: line.trim().slice(0, 200),
          });
        }
      });
    }
  }
  return hits;
}

module.exports = {
  newId,
  ensureDir,
  atomicWrite,
  readJson,
  writeJson,
  leadDir,
  gensDir,
  genDir,
  readCurrent,
  writeCurrent,
  migrateLayout,
  listGenIds,
  loadMeta,
  saveMeta,
  INBOX_KEEP_DONE,
  itemTime,
  sortInboxNewestFirst,
  trimInbox,
  currentGeneration,
  gcEmptyGens,
  ensureCurrent,
  archiveCurrent,
  startGeneration,
  resumeGeneration,
  loadInbox,
  saveInbox,
  enqueue,
  updateItem,
  findItem,
  nextQueued,
  runningItem,
  interruptRunning,
  tryLock,
  releaseLock,
  readWorker,
  writeWorker,
  workerAlive,
  reapStale,
  isAlive,
  detectGrokLeadModel,
  detectClaudeLeadModel,
  searchGens,
};
