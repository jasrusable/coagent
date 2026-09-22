#!/usr/bin/env node
'use strict';

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

function runNode(src, extraEnv = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', src], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
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
    S.ensureLead(root, lead);
    const send = (msg) => runNode(
      `const S=require(${q(LIB)});S.enqueue(${q(root)},${q(lead)},${q(msg)});`,
    );
    await Promise.all([send('from-a'), send('from-b')]);
    const msgs = S.loadInbox(root, lead).map((it) => it.message).sort();
    assert.deepEqual(msgs, ['from-a', 'from-b'], `trial ${i}: lost a send`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a sender cannot clobber the status a worker just wrote', async () => {
  const root = tmpState();
  const lead = 'lead-clobber';
  S.ensureLead(root, lead);
  const running = S.enqueue(root, lead, 'long-running');

  const worker = runNode(`
    const S=require(${q(LIB)});
    for (let i=0;i<60;i++) {
      S.updateItem(${q(root)},${q(lead)},${q(running.id)},{status:'running',startedAt:new Date().toISOString()});
    }
  `);
  const senders = Array.from({ length: 6 }, (_, i) => runNode(
    `const S=require(${q(LIB)});S.enqueue(${q(root)},${q(lead)},'extra-${i}');`,
  ));
  await Promise.all([worker, ...senders]);

  const inbox = S.loadInbox(root, lead);
  assert.equal(inbox.length, 7, 'every enqueue should be present');
  const it = inbox.find((x) => x.id === running.id);
  assert.equal(it.status, 'running', 'worker status must not be reverted by a sender');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a stale lock left by a dead process does not wedge the inbox', async () => {
  const root = tmpState();
  const lead = 'lead-stale';
  S.ensureLead(root, lead);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  fs.writeFileSync(path.join(S.leadDir(root, lead), 'inbox.lock'), '999999\n');
  const it = S.enqueue(root, lead, 'after-crash');
  assert.ok(S.loadInbox(root, lead).some((x) => x.id === it.id));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a recycled pid is not mistaken for the original process', () => {
  const livePid = process.pid;
  const realToken = S.pidToken(livePid);
  assert.ok(S.tokenAlive(realToken), 'our own token is alive');
  assert.equal(S.tokenAlive(`${livePid}@Thu Jan  1 00:00:00 2000`), false);
  assert.equal(S.tokenAlive(null), false);
});

test('interruptRunning reports only what it changed', () => {
  const root = tmpState();
  const lead = 'lead-int';
  S.ensureLead(root, lead);
  const a = S.enqueue(root, lead, 'a');
  S.updateItem(root, lead, a.id, { status: 'running' });
  assert.equal(S.interruptRunning(root, lead).length, 1);

  const b = S.enqueue(root, lead, 'b');
  S.updateItem(root, lead, b.id, { status: 'running' });
  const second = S.interruptRunning(root, lead);
  assert.equal(second.length, 1, 'must not re-report the earlier interrupt');
  assert.equal(second[0].id, b.id);
  fs.rmSync(root, { recursive: true, force: true });
});

function setupLeadHome() {
  const home = tmpState();
  const grokHome = path.join(home, 'grok');
  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(grokHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'persona.md'), 'You are a test colleague.\n');

  const cwd = process.cwd();
  const sid = 'ffffffff-0000-0000-0000-00000000beef';
  const sessDir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'updates.jsonl'), '');
  fs.writeFileSync(path.join(sessDir, 'chat_history.jsonl'), '');
  fs.writeFileSync(path.join(sessDir, 'summary.json'), JSON.stringify({
    current_model_id: 'grok-4.6',
    reasoning_effort: 'high',
    info: { cwd },
  }));
  return { home, grokHome, binDir, sid, cwd };
}

function runCoagent(args, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      c.kill('SIGKILL');
      resolve({ code: -1, out, err: err + '\n(test timeout)' });
    }, timeoutMs);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

test('send returns while grok is still running', async () => {
  const { home, grokHome, binDir, sid } = setupLeadHome();
  fs.writeFileSync(path.join(binDir, 'grok'), '#!/bin/sh\nsleep 30\necho \'{"sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","result":"late"}\'\n', { mode: 0o755 });

  const started = Date.now();
  const r = await runCoagent(['hello there'], {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
    COAGENT_LEAD_SESSION_ID: sid,
  });
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(r.code, 0, r.err || r.out);
  assert.match(r.out, /sent|send-now|starting/);
  assert.ok(elapsed < 8, `send should return immediately, took ${elapsed.toFixed(1)}s`);

  await runCoagent(['stop'], {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
    COAGENT_LEAD_SESSION_ID: sid,
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('wait times out without killing the inner grok as the waiter', async () => {
  const { home, grokHome, binDir, sid } = setupLeadHome();
  fs.writeFileSync(path.join(binDir, 'grok'), '#!/bin/sh\nsleep 30\necho \'{"sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","result":"late"}\'\n', { mode: 0o755 });

  await runCoagent(['hello there'], {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
    COAGENT_LEAD_SESSION_ID: sid,
  });

  const started = Date.now();
  const r = await runCoagent(['wait', '--timeout', '2'], {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
    COAGENT_LEAD_SESSION_ID: sid,
  });
  const elapsed = (Date.now() - started) / 1000;
  assert.notEqual(r.code, 0);
  assert.match(r.err, /timed out after 2s/);
  assert.ok(elapsed < 10, `wait --timeout 2 took ${elapsed.toFixed(1)}s`);

  await runCoagent(['stop'], {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
    COAGENT_LEAD_SESSION_ID: sid,
  });
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
