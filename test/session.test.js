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
    agent_name: 'grok-build-plan',
    info: { cwd: '/Users/jason/projects/FinWise' },
  }));
  const d = S.detectGrokLeadModel(dir);
  assert.equal(d.modelId, 'grok-4.6');
  assert.equal(d.effort, 'xhigh');
  assert.equal(d.agent, 'grok-build-plan');
  assert.equal(d.cwd, '/Users/jason/projects/FinWise');
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

test('reapStale fails running items when the worker is dead', () => {
  const root = tmpState();
  const lead = 'lead-7';
  const gen = S.ensureCurrent(root, lead);
  const item = S.enqueue(root, lead, gen, 'orphaned');
  S.updateItem(root, lead, gen, item.id, { status: 'running' });
  const lock = path.join(S.genDir(root, lead, gen), 'worker.lock');
  fs.writeFileSync(lock, '1\n');
  const reaped = S.reapStale(root, lead, gen);
  assert.deepEqual(reaped.ids, [item.id]);
  assert.equal(S.findItem(root, lead, gen, item.id).status, 'failed');
  assert.match(S.findItem(root, lead, gen, item.id).error, /stale/);
});

test('currentGeneration does not mint an empty gen', () => {
  const root = tmpState();
  assert.equal(S.currentGeneration(root, 'lead-fresh'), null);
  assert.deepEqual(S.listGenIds(root, 'lead-fresh'), []);
});

test('trimInbox keeps live rows and the newest settled ones', () => {
  const root = tmpState();
  const lead = 'lead-trim';
  const gen = S.ensureCurrent(root, lead);
  for (let i = 0; i < 4; i++) {
    const it = S.enqueue(root, lead, gen, `m${i}`);
    S.updateItem(root, lead, gen, it.id, {
      status: 'done',
      createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      finishedAt: `2026-01-0${i + 1}T00:00:01.000Z`,
    });
  }
  const live = S.enqueue(root, lead, gen, 'live');
  const dropped = S.trimInbox(root, lead, gen, 2);
  assert.equal(dropped, 2);
  const inbox = S.loadInbox(root, lead, gen);
  assert.ok(inbox.some((i) => i.id === live.id));
  assert.equal(inbox.filter((i) => i.status === 'done').length, 2);
});

test('gcEmptyGens removes unused archived gens only', () => {
  const root = tmpState();
  const lead = 'lead-gc';
  const a = S.ensureCurrent(root, lead);
  const b = S.startGeneration(root, lead);
  assert.equal(S.gcEmptyGens(root, lead), 1);
  assert.equal(S.readCurrent(root, lead), b);
  assert.ok(!S.listGenIds(root, lead).includes(a));
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
