#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/session.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (e) {
    console.error(`fail - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-test-'));
}

test('ensureCurrent creates a generation and reset archives it', () => {
  const root = tmpState();
  const lead = 'lead-1';
  const a = S.ensureCurrent(root, lead);
  assert.ok(a);
  assert.equal(S.readCurrent(root, lead), a);
  const b = S.startGeneration(root, lead);
  assert.notEqual(a, b);
  assert.equal(S.readCurrent(root, lead), b);
  assert.ok(S.loadMeta(root, lead, a).archivedAt);
  assert.equal(S.loadMeta(root, lead, b).archivedAt, null);
  const resumed = S.resumeGeneration(root, lead, a);
  assert.ok(resumed);
  assert.equal(S.readCurrent(root, lead), a);
  assert.equal(S.loadMeta(root, lead, a).archivedAt, null);
  assert.ok(S.loadMeta(root, lead, b).archivedAt);
});

test('migrate lifts peers/main into a generation', () => {
  const root = tmpState();
  const lead = 'lead-2';
  const main = path.join(root, lead, 'peers', 'main');
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, 'state.json'), JSON.stringify({
    sessionId: 'peer-sess',
    backend: 'grok',
    model: 'grok-4.6',
    lastQuestion: 'hello',
  }));
  fs.writeFileSync(path.join(main, 'last_reply.md'), 'prior reply');
  const id = S.migrateLayout(root, lead);
  assert.ok(id);
  const meta = S.loadMeta(root, lead, id);
  assert.equal(meta.sessionId, 'peer-sess');
  assert.equal(meta.model, 'grok-4.6');
  assert.ok(fs.existsSync(path.join(S.genDir(root, lead, id, false), 'last_reply.md')));
});

test('inbox queues FIFO and interrupt marks the running item', () => {
  const root = tmpState();
  const lead = 'lead-3';
  const gen = S.ensureCurrent(root, lead);
  const a = S.enqueue(root, lead, gen, 'first');
  const b = S.enqueue(root, lead, gen, 'second');
  assert.equal(S.nextQueued(root, lead, gen).id, a.id);
  S.updateItem(root, lead, gen, a.id, { status: 'running' });
  S.interruptRunning(root, lead, gen, { clearQueue: false });
  assert.equal(S.findItem(root, lead, gen, a.id).status, 'interrupted');
  assert.equal(S.findItem(root, lead, gen, b.id).status, 'queued');
  const c = S.enqueue(root, lead, gen, 'now', { front: true });
  assert.equal(S.nextQueued(root, lead, gen).id, c.id);
});

test('interrupt --clear-queue drops queued items', () => {
  const root = tmpState();
  const lead = 'lead-4';
  const gen = S.ensureCurrent(root, lead);
  S.enqueue(root, lead, gen, 'keep-running-slot');
  S.updateItem(root, lead, gen, S.nextQueued(root, lead, gen).id, { status: 'running' });
  S.enqueue(root, lead, gen, 'later');
  S.interruptRunning(root, lead, gen, { clearQueue: true });
  const inbox = S.loadInbox(root, lead, gen);
  assert.ok(inbox.every((i) => i.status === 'interrupted'));
  assert.equal(S.nextQueued(root, lead, gen), null);
});

test('detectGrokLeadModel reads summary.json', () => {
  const dir = tmpState();
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    current_model_id: 'grok-4.6',
    reasoning_effort: 'xhigh',
  }));
  const d = S.detectGrokLeadModel(dir);
  assert.equal(d.modelId, 'grok-4.6');
  assert.equal(d.effort, 'xhigh');
});

test('detectClaudeLeadModel reads last assistant model', () => {
  const d = S.detectClaudeLeadModel([
    { type: 'assistant', message: { model: 'claude-old' } },
    { type: 'assistant', message: { model: 'claude-opus-4-6' } },
  ]);
  assert.equal(d.modelId, 'claude-opus-4-6');
});

test('searchGens finds archived replies', () => {
  const root = tmpState();
  const lead = 'lead-5';
  const gen = S.ensureCurrent(root, lead);
  fs.writeFileSync(path.join(S.genDir(root, lead, gen), 'last_reply.md'), 'the widget bug is fixed\n');
  const hits = S.searchGens(root, lead, 'widget');
  assert.ok(hits.some((h) => h.genId === gen && /widget/.test(h.text)));
});

test('stale worker lock can be stolen', () => {
  const root = tmpState();
  const lead = 'lead-6';
  const gen = S.ensureCurrent(root, lead);
  const lock = path.join(S.genDir(root, lead, gen), 'worker.lock');
  fs.writeFileSync(lock, '1\n');
  assert.equal(S.tryLock(root, lead, gen, process.pid), true);
  S.releaseLock(root, lead, gen, process.pid);
  assert.equal(S.workerAlive(root, lead, gen), false);
});

if (!process.exitCode) console.log('\nall session tests passed');
