'use strict';

/**
 * Per-lead-session generations + inbox.
 * One standing co-agent per harness session; reset archives, resume restores.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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
    forkedFrom: null,
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

/**
 * Cross-process mutex for inbox.json.
 *
 * atomicWrite only makes the rename atomic — it does nothing for the
 * load→mutate→save window, so two senders racing would silently drop one of
 * the messages. Every mutation goes through mutateInbox; nothing else may
 * call saveInbox.
 */
const INBOX_LOCK_STALE_MS = 15000;
const INBOX_LOCK_WAIT_MS = 10000;
const INBOX_LOCK_SPIN_MS = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function inboxLockPath(stateDir, leadSid, genId) {
  return path.join(genDir(stateDir, leadSid, genId, false), 'inbox.lock');
}

function acquireInboxLock(stateDir, leadSid, genId) {
  const p = inboxLockPath(stateDir, leadSid, genId);
  ensureDir(path.dirname(p));
  const deadline = Date.now() + INBOX_LOCK_WAIT_MS;
  for (let attempt = 0; attempt < 100000; attempt++) {
    try {
      fs.writeFileSync(p, `${process.pid}\n`, { flag: 'wx' });
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Break the lock if its holder died, or if it outlived any sane hold.
    let stale = false;
    try {
      const heldFor = Date.now() - fs.statSync(p).mtimeMs;
      const holder = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
      stale = heldFor > INBOX_LOCK_STALE_MS
        || (Number.isFinite(holder) && holder !== process.pid && !isAlive(holder));
    } catch {
      stale = true;
    }
    if (stale || Date.now() > deadline) {
      try { fs.unlinkSync(p); } catch { /* raced with the holder; retry */ }
      continue;
    }
    sleepSync(INBOX_LOCK_SPIN_MS);
  }
  throw new Error(`coagent: could not acquire inbox lock at ${p}`);
}

function withInboxLock(stateDir, leadSid, genId, fn) {
  const p = acquireInboxLock(stateDir, leadSid, genId);
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(p); } catch { /* already stolen as stale */ }
  }
}

/** fn(items) -> { items?, value }. Saves only when it hands back a new list. */
function mutateInbox(stateDir, leadSid, genId, fn) {
  return withInboxLock(stateDir, leadSid, genId, () => {
    const out = fn(loadInbox(stateDir, leadSid, genId)) || {};
    if (out.items) saveInbox(stateDir, leadSid, genId, out.items);
    return out.value;
  });
}

const INBOX_KEEP_DONE = 50;

function itemTime(it) {
  return (it && (it.finishedAt || it.startedAt || it.createdAt)) || '';
}

function sortInboxNewestFirst(items) {
  return [...(items || [])].sort((a, b) => itemTime(b).localeCompare(itemTime(a)));
}

/** Waiters in other processes poll by id; never trim a row out from under one. */
const TRIM_GRACE_MS = 10 * 60 * 1000;

function isLive(it) {
  return it.status === 'queued' || it.status === 'running';
}

function pruneInbox(items, keep = INBOX_KEEP_DONE, now = Date.now()) {
  const settled = items.filter((i) => !isLive(i));
  if (settled.length <= keep) return { next: items, dropped: 0 };
  const newestFirst = sortInboxNewestFirst(settled);
  const keepIds = new Set([
    ...items.filter(isLive),
    ...newestFirst.slice(0, keep),
    ...newestFirst.filter((i) => now - Date.parse(itemTime(i)) < TRIM_GRACE_MS),
  ].map((i) => i.id));
  const next = items.filter((i) => keepIds.has(i.id));
  return { next, dropped: items.length - next.length };
}

function trimInbox(stateDir, leadSid, genId, keep = INBOX_KEEP_DONE) {
  return mutateInbox(stateDir, leadSid, genId, (items) => {
    const { next, dropped } = pruneInbox(items, keep);
    return { items: dropped ? next : null, value: dropped };
  });
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
  return mutateInbox(stateDir, leadSid, genId, (items) => {
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
    return { items: pruneInbox(next).next, value: item };
  });
}

function updateItem(stateDir, leadSid, genId, itemId, patch) {
  return mutateInbox(stateDir, leadSid, genId, (items) => {
    const i = items.findIndex((x) => x.id === itemId);
    if (i < 0) return { value: null };
    const next = items.map((it, idx) => (idx === i ? { ...it, ...patch } : it));
    return { items: next, value: next[i] };
  });
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

/** Returns only the items this call interrupted, not every historical one. */
function interruptRunning(stateDir, leadSid, genId, { clearQueue = false } = {}) {
  return mutateInbox(stateDir, leadSid, genId, (items) => {
    const changed = [];
    const next = items.map((it) => {
      const cleared = clearQueue && it.status === 'queued';
      if (it.status !== 'running' && !cleared) return it;
      const stopped = {
        ...it,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
        ...(cleared ? { error: 'cleared' } : {}),
      };
      changed.push(stopped);
      return stopped;
    });
    return { items: changed.length ? next : null, value: changed };
  });
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

/**
 * A bare pid is not an identity — the OS recycles it. A recycled pid made
 * workerAlive() true forever (wedging the generation) and let killTree()
 * SIGKILL an unrelated process tree. Pair the pid with its start time so a
 * recycled slot never matches the process we meant.
 */
function procStartedAt(pid) {
  if (!pid) return null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return String(r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

function pidToken(pid) {
  if (!pid) return null;
  const started = procStartedAt(pid);
  return started ? `${pid}@${started}` : String(pid);
}

function tokenPid(token) {
  const pid = parseInt(String(token || '').split('@')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

function tokenAlive(token) {
  const pid = tokenPid(token);
  if (!isAlive(pid)) return false;
  const at = String(token).indexOf('@');
  if (at < 0) return true; // legacy bare-pid record: best effort
  return procStartedAt(pid) === String(token).slice(at + 1);
}

function readLockToken(p) {
  try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

function tryLock(stateDir, leadSid, genId, pid) {
  const p = lockPath(stateDir, leadSid, genId);
  ensureDir(path.dirname(p));
  const mine = pidToken(pid);
  if (fs.existsSync(p)) {
    const existing = readLockToken(p);
    if (existing && existing !== mine && tokenAlive(existing)) return false;
    try { fs.unlinkSync(p); } catch { /* */ }
  }
  try {
    fs.writeFileSync(p, `${mine}\n`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(stateDir, leadSid, genId, pid) {
  const p = lockPath(stateDir, leadSid, genId);
  if (!fs.existsSync(p)) return;
  const existing = readLockToken(p);
  if (existing === pidToken(pid) || !tokenAlive(existing)) {
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
  return tokenAlive(readLockToken(p));
}

/** If the worker is dead, fail any item still marked running so the queue can move. */
function reapStale(stateDir, leadSid, genId) {
  const w = readWorker(stateDir, leadSid, genId);
  if (workerAlive(stateDir, leadSid, genId)) return { ids: [], orphanPid: null };
  // Only claim the orphan if it is still the same process we spawned.
  const orphanPid = w && w.childPid && tokenAlive(w.childToken || w.childPid)
    ? w.childPid
    : null;
  const ids = mutateInbox(stateDir, leadSid, genId, (items) => {
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
    return { items: reaped.length ? next : null, value: reaped };
  });
  return { ids, orphanPid };
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

/**
 * Searches the consult history, not the files. last_reply.{md,json},
 * meta.json and inbox.json all mirror the same text, so grepping the
 * directory returned every match four times over.
 */
function searchGens(stateDir, leadSid, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const hits = [];
  const add = (id, archived, label, itemId, text) => {
    for (const line of String(text || '').split('\n')) {
      if (!line.toLowerCase().includes(q)) continue;
      hits.push({ genId: id, archived, label, itemId, text: line.trim().slice(0, 200) });
    }
  };

  for (const id of listGenIds(stateDir, leadSid)) {
    const meta = loadMeta(stateDir, leadSid, id);
    const archived = !!meta.archivedAt;
    const items = loadInbox(stateDir, leadSid, id);
    for (const it of sortInboxNewestFirst(items)) {
      add(id, archived, 'ask', it.id, it.message);
      add(id, archived, 'reply', it.id, it.answer);
    }
    // Pre-inbox generations (and hand-written notes) only exist as the file.
    if (items.some((it) => it.answer)) continue;
    const md = path.join(genDir(stateDir, leadSid, id, false), 'last_reply.md');
    if (fs.existsSync(md)) add(id, archived, 'reply', null, fs.readFileSync(md, 'utf8'));
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
  TRIM_GRACE_MS,
  isLive,
  itemTime,
  sortInboxNewestFirst,
  pruneInbox,
  trimInbox,
  withInboxLock,
  mutateInbox,
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
  pidToken,
  tokenAlive,
  procStartedAt,
  detectGrokLeadModel,
  detectClaudeLeadModel,
  searchGens,
};
