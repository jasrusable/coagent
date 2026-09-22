'use strict';

/**
 * Per-lead-session state: one current inner Grok, a roster of prior tapes,
 * and a locked inbox for queue / send-now / stop.
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

function emptyMeta() {
  return {
    sessionId: null,
    harness: null,
    cwd: null,
    model: null,
    effort: null,
    agent: null,
    lastQuestion: null,
    lastQuestionAt: null,
    lastError: null,
    lastMeta: null,
    personaPath: null,
    createdAt: new Date().toISOString(),
  };
}

function metaPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'meta.json');
}

function loadMeta(stateDir, leadSid) {
  const raw = readJson(metaPath(stateDir, leadSid), null);
  if (!raw) return emptyMeta();
  return { ...emptyMeta(), ...raw };
}

function saveMeta(stateDir, leadSid, meta) {
  writeJson(metaPath(stateDir, leadSid), { ...emptyMeta(), ...meta });
}

function ensureLead(stateDir, leadSid) {
  leadDir(stateDir, leadSid, true);
  if (!fs.existsSync(metaPath(stateDir, leadSid))) saveMeta(stateDir, leadSid, emptyMeta());
  return loadMeta(stateDir, leadSid);
}

function rosterPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'roster.json');
}

function loadRoster(stateDir, leadSid) {
  const raw = readJson(rosterPath(stateDir, leadSid), null);
  const sessions = Array.isArray(raw && raw.sessions) ? raw.sessions : [];
  return { sessions };
}

function saveRoster(stateDir, leadSid, roster) {
  writeJson(rosterPath(stateDir, leadSid), { sessions: roster.sessions || [] });
}

function addToRoster(stateDir, leadSid, entry) {
  const roster = loadRoster(stateDir, leadSid);
  if (roster.sessions.some((s) => s.id === entry.id)) return roster;
  roster.sessions = [{
    id: entry.id,
    createdAt: entry.createdAt || new Date().toISOString(),
    cwd: entry.cwd || null,
    model: entry.model || null,
    harness: entry.harness || null,
  }, ...roster.sessions];
  saveRoster(stateDir, leadSid, roster);
  return roster;
}

function inboxPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'inbox.json');
}

function loadInbox(stateDir, leadSid) {
  return readJson(inboxPath(stateDir, leadSid), []);
}

function saveInbox(stateDir, leadSid, items) {
  writeJson(inboxPath(stateDir, leadSid), items);
}

const INBOX_LOCK_STALE_MS = 15000;
const INBOX_LOCK_WAIT_MS = 10000;
const INBOX_LOCK_SPIN_MS = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function inboxLockPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'inbox.lock');
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireInboxLock(stateDir, leadSid) {
  const p = inboxLockPath(stateDir, leadSid);
  ensureDir(path.dirname(p));
  const deadline = Date.now() + INBOX_LOCK_WAIT_MS;
  for (let attempt = 0; attempt < 100000; attempt++) {
    try {
      fs.writeFileSync(p, `${process.pid}\n`, { flag: 'wx' });
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
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

function withInboxLock(stateDir, leadSid, fn) {
  const p = acquireInboxLock(stateDir, leadSid);
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(p); } catch { /* already stolen as stale */ }
  }
}

function mutateInbox(stateDir, leadSid, fn) {
  return withInboxLock(stateDir, leadSid, () => {
    const out = fn(loadInbox(stateDir, leadSid)) || {};
    if (out.items) saveInbox(stateDir, leadSid, out.items);
    return out.value;
  });
}

const INBOX_KEEP_DONE = 50;
const TRIM_GRACE_MS = 10 * 60 * 1000;

function isLive(it) {
  return it.status === 'queued' || it.status === 'running';
}

function itemTime(it) {
  return (it && (it.finishedAt || it.startedAt || it.createdAt)) || '';
}

function sortInboxNewestFirst(items) {
  return [...(items || [])].sort((a, b) => itemTime(b).localeCompare(itemTime(a)));
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

function enqueue(stateDir, leadSid, message, { front = false, cwd = null, access = null } = {}) {
  return mutateInbox(stateDir, leadSid, (items) => {
    const item = {
      id: newId(),
      message,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cwd: cwd || null,
      access: access || null,
    };
    const next = front ? [item, ...items] : [...items, item];
    return { items: pruneInbox(next).next, value: item };
  });
}

function updateItem(stateDir, leadSid, itemId, patch) {
  return mutateInbox(stateDir, leadSid, (items) => {
    const i = items.findIndex((x) => x.id === itemId);
    if (i < 0) return { value: null };
    const next = items.map((it, idx) => (idx === i ? { ...it, ...patch } : it));
    return { items: next, value: next[i] };
  });
}

function findItem(stateDir, leadSid, itemId) {
  return loadInbox(stateDir, leadSid).find((x) => x.id === itemId) || null;
}

function nextQueued(stateDir, leadSid) {
  return loadInbox(stateDir, leadSid).find((x) => x.status === 'queued') || null;
}

function runningItem(stateDir, leadSid) {
  return loadInbox(stateDir, leadSid).find((x) => x.status === 'running') || null;
}

function liveItems(stateDir, leadSid) {
  return loadInbox(stateDir, leadSid).filter(isLive);
}

function clearInbox(stateDir, leadSid) {
  return mutateInbox(stateDir, leadSid, () => ({ items: [], value: true }));
}

/** Returns only the items this call interrupted. */
function interruptRunning(stateDir, leadSid) {
  return mutateInbox(stateDir, leadSid, (items) => {
    const changed = [];
    const next = items.map((it) => {
      if (it.status !== 'running') return it;
      const stopped = {
        ...it,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
      };
      changed.push(stopped);
      return stopped;
    });
    return { items: changed.length ? next : null, value: changed };
  });
}

function lastReplyPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'last_reply.md');
}

function lastReplyMetaPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'last_reply.json');
}

function lockPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'worker.lock');
}

function workerPath(stateDir, leadSid) {
  return path.join(leadDir(stateDir, leadSid, false), 'worker.json');
}

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
  if (at < 0) return true;
  return procStartedAt(pid) === String(token).slice(at + 1);
}

function readLockToken(p) {
  try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

function tryLock(stateDir, leadSid, pid) {
  const p = lockPath(stateDir, leadSid);
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

function releaseLock(stateDir, leadSid, pid) {
  const p = lockPath(stateDir, leadSid);
  if (!fs.existsSync(p)) return;
  const existing = readLockToken(p);
  if (existing === pidToken(pid) || !tokenAlive(existing)) {
    try { fs.unlinkSync(p); } catch { /* */ }
  }
}

function readWorker(stateDir, leadSid) {
  return readJson(workerPath(stateDir, leadSid), null);
}

function writeWorker(stateDir, leadSid, info) {
  writeJson(workerPath(stateDir, leadSid), info);
}

function workerAlive(stateDir, leadSid) {
  const p = lockPath(stateDir, leadSid);
  if (!fs.existsSync(p)) return false;
  return tokenAlive(readLockToken(p));
}

function busy(stateDir, leadSid) {
  return workerAlive(stateDir, leadSid) || liveItems(stateDir, leadSid).length > 0;
}

function reapStale(stateDir, leadSid) {
  const w = readWorker(stateDir, leadSid);
  if (workerAlive(stateDir, leadSid)) return { ids: [], orphanPid: null };
  const orphanPid = w && w.childPid && tokenAlive(w.childToken || w.childPid)
    ? w.childPid
    : null;
  const ids = mutateInbox(stateDir, leadSid, (items) => {
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

module.exports = {
  newId,
  ensureDir,
  atomicWrite,
  readJson,
  writeJson,
  leadDir,
  emptyMeta,
  loadMeta,
  saveMeta,
  ensureLead,
  loadRoster,
  saveRoster,
  addToRoster,
  INBOX_KEEP_DONE,
  TRIM_GRACE_MS,
  isLive,
  itemTime,
  sortInboxNewestFirst,
  pruneInbox,
  withInboxLock,
  mutateInbox,
  loadInbox,
  saveInbox,
  enqueue,
  updateItem,
  findItem,
  nextQueued,
  runningItem,
  liveItems,
  clearInbox,
  interruptRunning,
  lastReplyPath,
  lastReplyMetaPath,
  tryLock,
  releaseLock,
  readWorker,
  writeWorker,
  workerAlive,
  busy,
  reapStale,
  isAlive,
  pidToken,
  tokenAlive,
  tokenPid,
  procStartedAt,
};
