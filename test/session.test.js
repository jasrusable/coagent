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

test('ensureLead creates meta; reset-style clear leaves roster', () => {
  const root = tmpState();
  const lead = 'lead-1';
  S.ensureLead(root, lead);
  S.saveMeta(root, lead, { ...S.loadMeta(root, lead), sessionId: 'sess-a' });
  S.addToRoster(root, lead, { id: 'sess-a', cwd: '/tmp' });
  assert.equal(S.loadMeta(root, lead).sessionId, 'sess-a');
  assert.equal(S.loadRoster(root, lead).sessions[0].id, 'sess-a');
  S.saveMeta(root, lead, S.emptyMeta());
  assert.equal(S.loadMeta(root, lead).sessionId, null);
  assert.equal(S.loadRoster(root, lead).sessions[0].id, 'sess-a');
  fs.rmSync(root, { recursive: true, force: true });
});

test('inbox queues FIFO and interrupt marks the running item', () => {
  const root = tmpState();
  const lead = 'lead-3';
  S.ensureLead(root, lead);
  const a = S.enqueue(root, lead, 'first');
  const b = S.enqueue(root, lead, 'second');
  assert.equal(S.nextQueued(root, lead).id, a.id);
  S.updateItem(root, lead, a.id, { status: 'running' });
  S.interruptRunning(root, lead);
  assert.equal(S.findItem(root, lead, a.id).status, 'interrupted');
  assert.equal(S.findItem(root, lead, b.id).status, 'queued');
  const c = S.enqueue(root, lead, 'now', { front: true });
  assert.equal(S.nextQueued(root, lead).id, c.id);
  fs.rmSync(root, { recursive: true, force: true });
});

test('interrupt does not drop queued items', () => {
  const root = tmpState();
  const lead = 'lead-4';
  S.ensureLead(root, lead);
  const a = S.enqueue(root, lead, 'a');
  S.enqueue(root, lead, 'b');
  S.updateItem(root, lead, a.id, { status: 'running' });
  const changed = S.interruptRunning(root, lead);
  assert.equal(changed.length, 1);
  assert.equal(S.loadInbox(root, lead).filter((i) => i.status === 'queued').length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findLeadByItemId returns the one inbox that holds the id', () => {
  const root = tmpState();
  const a = path.join('lead-a', 'agents', 'fable');
  const b = path.join('lead-b', 'agents', 'fable');
  S.ensureLead(root, a);
  S.ensureLead(root, b);
  const item = S.enqueue(root, a, 'review', { model: 'fable', harness: 'claude', access: 'read-only' });
  assert.equal(item.model, 'fable');
  assert.equal(item.harness, 'claude');
  assert.deepEqual(S.findLeadByItemId(root, item.id), [
    { leadSessionId: 'lead-a', agentName: 'fable' },
  ]);
  assert.deepEqual(S.findLeadByItemId(root, item.id, 'main'), []);
  S.saveInbox(root, b, S.loadInbox(root, a));
  assert.equal(S.findLeadByItemId(root, item.id).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('addToRoster does not duplicate', () => {
  const root = tmpState();
  const lead = 'lead-r';
  S.ensureLead(root, lead);
  S.addToRoster(root, lead, { id: 'x' });
  S.addToRoster(root, lead, { id: 'x' });
  S.addToRoster(root, lead, { id: 'y' });
  assert.deepEqual(S.loadRoster(root, lead).sessions.map((s) => s.id), ['y', 'x']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('prune keeps recently settled rows', () => {
  const now = Date.now();
  const settled = (id, ageMs) => ({
    id,
    status: 'done',
    createdAt: new Date(now - ageMs).toISOString(),
    finishedAt: new Date(now - ageMs).toISOString(),
  });
  const items = [
    settled('old-1', 60 * 60 * 1000),
    settled('old-2', 59 * 60 * 1000),
    settled('just-finished', 1000),
  ];
  const { next } = S.pruneInbox(items, 1, now);
  const kept = next.map((i) => i.id);
  assert.ok(kept.includes('just-finished'), 'recently settled row must survive the trim');
  assert.ok(kept.includes('old-1') === false || kept.includes('old-2') === false, 'old rows still trim');
});

test('busy is true when queued or running', () => {
  const root = tmpState();
  const lead = 'lead-b';
  S.ensureLead(root, lead);
  assert.equal(S.busy(root, lead), false);
  const a = S.enqueue(root, lead, 'hi');
  assert.equal(S.busy(root, lead), true);
  S.updateItem(root, lead, a.id, { status: 'done', finishedAt: new Date().toISOString() });
  assert.equal(S.busy(root, lead), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('clearInbox drops everything', () => {
  const root = tmpState();
  const lead = 'lead-c';
  S.ensureLead(root, lead);
  S.enqueue(root, lead, 'a');
  S.clearInbox(root, lead);
  assert.equal(S.loadInbox(root, lead).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

if (!process.exitCode) console.log('\nall session tests passed');
