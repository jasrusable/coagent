#!/usr/bin/env node
'use strict';

/**
 * Cross-process behaviour. The rest of the suite drives lib/session.js in a
 * single process, which is exactly where the queue/interrupt defects hid:
 * every inbox mutation is a load→mutate→save against a shared file.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const S = require('../lib/session.js');

const LIB = require.resolve('../lib/session.js');
const BIN = require.resolve('../bin/coagent');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-conc-'));
}

function runNode(src) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

const q = (v) => JSON.stringify(v);

test('two processes enqueueing at once both survive', async () => {
  const TRIALS = 12;
  for (let i = 0; i < TRIALS; i++) {
    const root = tmpState();
    const lead = 'lead-race';
    const gen = S.ensureCurrent(root, lead);
    const send = (msg) => runNode(
      `const S=require(${q(LIB)});S.enqueue(${q(root)},${q(lead)},${q(gen)},${q(msg)});`,
    );
    await Promise.all([send('from-a'), send('from-b')]);
    const msgs = S.loadInbox(root, lead, gen).map((it) => it.message).sort();
    assert.deepEqual(msgs, ['from-a', 'from-b'], `trial ${i}: lost a send`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a sender cannot clobber the status a worker just wrote', async () => {
  const root = tmpState();
  const lead = 'lead-clobber';
  const gen = S.ensureCurrent(root, lead);
  const running = S.enqueue(root, lead, gen, 'long-running');

  const worker = runNode(`
    const S=require(${q(LIB)});
    for (let i=0;i<60;i++) {
      S.updateItem(${q(root)},${q(lead)},${q(gen)},${q(running.id)},{status:'running',startedAt:new Date().toISOString()});
    }
  `);
  const senders = Array.from({ length: 6 }, (_, i) => runNode(
    `const S=require(${q(LIB)});S.enqueue(${q(root)},${q(lead)},${q(gen)},'extra-${i}');`,
  ));
  await Promise.all([worker, ...senders]);

  const inbox = S.loadInbox(root, lead, gen);
  assert.equal(inbox.length, 7, 'every enqueue should be present');
  const it = inbox.find((x) => x.id === running.id);
  assert.equal(it.status, 'running', 'worker status must not be reverted by a sender');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a stale lock left by a dead process does not wedge the inbox', async () => {
  const root = tmpState();
  const lead = 'lead-stale';
  const gen = S.ensureCurrent(root, lead);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  // A crashed holder leaves the lock file behind; the next writer must break it.
  fs.writeFileSync(path.join(S.genDir(root, lead, gen), 'inbox.lock'), '999999\n');
  const it = S.enqueue(root, lead, gen, 'after-crash');
  assert.ok(S.loadInbox(root, lead, gen).some((x) => x.id === it.id));
  fs.rmSync(root, { recursive: true, force: true });
});

test('trim keeps rows a waiter in another process may still be polling', () => {
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

test('a recycled pid is not mistaken for the original process', () => {
  const livePid = process.pid;
  const realToken = S.pidToken(livePid);
  assert.ok(S.tokenAlive(realToken), 'our own token is alive');
  // Same pid, different start time — what pid reuse actually looks like.
  assert.equal(S.tokenAlive(`${livePid}@Thu Jan  1 00:00:00 2000`), false);
  assert.equal(S.tokenAlive(null), false);
});

test('interruptRunning reports only what it changed', () => {
  const root = tmpState();
  const lead = 'lead-int';
  const gen = S.ensureCurrent(root, lead);
  const a = S.enqueue(root, lead, gen, 'a');
  S.updateItem(root, lead, gen, a.id, { status: 'running' });
  assert.equal(S.interruptRunning(root, lead, gen).length, 1);

  const b = S.enqueue(root, lead, gen, 'b');
  S.updateItem(root, lead, gen, b.id, { status: 'running' });
  const second = S.interruptRunning(root, lead, gen);
  assert.equal(second.length, 1, 'must not re-report the earlier interrupt');
  assert.equal(second[0].id, b.id);
  fs.rmSync(root, { recursive: true, force: true });
});

test('search returns one hit per match, not one per mirror file', () => {
  const root = tmpState();
  const lead = 'lead-search';
  const gen = S.ensureCurrent(root, lead);
  const it = S.enqueue(root, lead, gen, 'look at the widget please');
  S.updateItem(root, lead, gen, it.id, { status: 'done', answer: 'the widget is fine' });
  // The mirrors that used to be grepped separately.
  fs.writeFileSync(path.join(S.genDir(root, lead, gen), 'last_reply.md'), 'the widget is fine\n');
  fs.writeFileSync(path.join(S.genDir(root, lead, gen), 'last_reply.json'), JSON.stringify({ answer: 'the widget is fine' }));

  const hits = S.searchGens(root, lead, 'widget');
  assert.equal(hits.length, 2, `expected ask+reply, got ${hits.length}`);
  assert.deepEqual(hits.map((h) => h.label).sort(), ['ask', 'reply']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--timeout bounds a first send, which becomes its own worker', async () => {
  const home = tmpState();
  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  // A backend that never answers: the old code awaited this to completion
  // before the deadline was ever consulted.
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nsleep 120\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'persona.md'), 'You are a test colleague.\n');

  const sid = 'ffffffff-0000-0000-0000-00000000beef';
  const transcript = path.join(home, `${sid}.jsonl`);
  fs.writeFileSync(transcript, `${[
    JSON.stringify({ type: 'user', sessionId: sid, uuid: 'u1', cwd: home, message: { role: 'user', content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', sessionId: sid, uuid: 'u2', cwd: home, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n')}\n`);

  const started = Date.now();
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, '--timeout', '5', '--lead', 'claude', 'are you bounded?'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        COAGENT_HOME: home,
        COAGENT_LEAD: 'claude',
        COAGENT_LEAD_SESSION_ID: sid,
        COAGENT_LEAD_TRANSCRIPT: transcript,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.stdout.on('data', () => { /* drain */ });
    c.on('close', (code) => resolve({ code, err }));
  });
  const elapsed = (Date.now() - started) / 1000;

  assert.notEqual(r.code, 0, 'a timed-out send must not report success');
  assert.match(r.err, /timed out after 5s/, `stderr was: ${r.err.slice(0, 400)}`);
  assert.ok(elapsed < 45, `--timeout 5 should not take ${elapsed.toFixed(1)}s`);
  fs.rmSync(home, { recursive: true, force: true });
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  - ${t.name}`);
    } catch (e) {
      console.error(`fail - ${t.name}`);
      console.error(e);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log('\nall concurrency tests passed');
})();
