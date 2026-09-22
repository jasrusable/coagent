#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HARNESS = require.resolve('../lib/harness/index.js');
const H = require('../lib/harness/index.js');
const BIN = require.resolve('../bin/coagent');
const claude = require('../lib/harness/claude.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const q = (v) => JSON.stringify(v);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-harness-')); }

function slug(cwd) { return String(cwd).replace(/[^a-zA-Z0-9]/g, '-'); }

// A minimal Claude transcript: enough records for detection and rendering.
function writeClaudeTranscript(configDir, cwd, sid, extra = []) {
  const dir = path.join(configDir, 'projects', slug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const rows = [
    { type: 'ai-title', aiTitle: 'A test tape', sessionId: sid },
    { type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      cwd,
      sessionId: sid,
      effort: 'high',
      message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    },
    ...extra,
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function resolveIn(env) {
  const r = spawnSync(process.execPath, ['-e', `
    const H = require(${q(HARNESS)});
    const r = H.resolve();
    console.log(JSON.stringify(r.error ? { error: r.error } : { id: r.harness.id, pin: r.lead.pin, sid: r.lead.sessionId }));
  `], { encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(r.stdout.trim() || '{}');
}

const CLEAN = {
  CLAUDE_CODE_SESSION_ID: undefined,
  GROK_SESSION_ID: undefined,
  COAGENT_LEAD_SESSION_ID: undefined,
  COAGENT_LEAD_TRANSCRIPT: undefined,
  COAGENT_HARNESS: undefined,
};

test('claude paths and session facts come off the transcript', () => {
  const home = tmp();
  const cwd = '/Users/test/proj';
  const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
  const file = writeClaudeTranscript(home, cwd, sid);
  const r = spawnSync(process.execPath, ['-e', `
    const c = require(${q(require.resolve('../lib/harness/claude.js'))});
    const p = c.sessionPaths(${q(sid)}, ${q(cwd)});
    console.log(JSON.stringify({ p, d: c.describeSession(p) }));
  `], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  const { p, d } = JSON.parse(r.stdout.trim());
  assert.equal(p.transcript, file);
  assert.equal(p.context, null, 'claude has a single tape');
  assert.equal(d.modelId, 'claude-opus-5');
  assert.equal(d.effort, 'high');
  assert.equal(d.cwd, cwd);
  assert.equal(d.title, 'A test tape');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an interrupted turn does not become the inner model', () => {
  const home = tmp();
  const cwd = '/Users/test/proj';
  const sid = 'aaaaaaaa-1111-2222-3333-666666666666';
  // Claude stamps interrupted/errored assistant records with model <synthetic>;
  // 3 of 97 real transcripts ended on one when this was written.
  writeClaudeTranscript(home, cwd, sid, [{
    type: 'assistant',
    cwd,
    sessionId: sid,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Request interrupted' }] },
  }]);
  const r = spawnSync(process.execPath, ['-e', `
    const c = require(${q(require.resolve('../lib/harness/claude.js'))});
    console.log(JSON.stringify(c.describeSession(c.sessionPaths(${q(sid)}, ${q(cwd)}))));
  `], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  const d = JSON.parse(r.stdout.trim());
  assert.equal(d.modelId, 'claude-opus-5', 'must keep the last real model, not <synthetic>');
  fs.rmSync(home, { recursive: true, force: true });
});

test('claude session is found even when the cwd slug does not match', () => {
  const home = tmp();
  const sid = 'aaaaaaaa-1111-2222-3333-555555555555';
  writeClaudeTranscript(home, '/somewhere/else', sid);
  const r = spawnSync(process.execPath, ['-e', `
    const c = require(${q(require.resolve('../lib/harness/claude.js'))});
    console.log(JSON.stringify(c.sessionPaths(${q(sid)}, '/not/the/place')));
  `], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  assert.ok(JSON.parse(r.stdout.trim()).transcript, 'should fall back to scanning projects/');
  fs.rmSync(home, { recursive: true, force: true });
});

test('formatUpdate renders claude text, tool calls and results', () => {
  const out = claude.formatUpdate({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'looking now' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ],
    },
  }, os.homedir());
  assert.match(out, /● looking now/);
  assert.match(out, /Bash: ls -la/);
  const res = claude.formatUpdate({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'total 0', is_error: false }] },
  }, os.homedir());
  assert.match(res, /→ total 0/);
  assert.equal(claude.formatUpdate({ type: 'permission-mode', mode: 'default' }, os.homedir()), null);
});

test('the lead harness is derived from the environment', () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, sid);
  const picked = resolveIn({ ...CLEAN, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: sid });
  assert.equal(picked.id, 'claude');
  assert.equal(picked.pin, 'env');
  assert.equal(picked.sid, sid);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a live claude session beats a stale grok registry entry', () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = 'cccccccc-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, sid);

  const grokHome = path.join(home, 'grok');
  const stale = 'dddddddd-1111-2222-3333-444444444444';
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), stale);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
  fs.writeFileSync(path.join(grokHome, 'active_sessions.json'), JSON.stringify([
    { session_id: stale, cwd },
  ]));

  const picked = resolveIn({ ...CLEAN, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: sid, GROK_HOME: grokHome });
  assert.equal(picked.id, 'claude', `cwd-match should lose to an env-pinned lead: ${JSON.stringify(picked)}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('two equally-pinned leads refuse to guess', () => {
  const home = tmp();
  const cwd = process.cwd();
  const csid = 'eeeeeeee-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, csid);

  const grokHome = path.join(home, 'grok');
  const gsid = 'ffffffff-1111-2222-3333-444444444444';
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), gsid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');

  const both = { ...CLEAN, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: csid, GROK_HOME: grokHome, GROK_SESSION_ID: gsid };
  const picked = resolveIn(both);
  assert.match(picked.error || '', /ambiguous lead/);

  const pinned = resolveIn({ ...both, COAGENT_HARNESS: 'grok' });
  assert.equal(pinned.id, 'grok', 'COAGENT_HARNESS is the tiebreak');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a co-agent cannot spawn a co-agent of its own', () => {
  // Its own harness env makes a worker resolve ITSELF as a lead, so the guard
  // is the only thing between us and recursive agent spawning.
  const blocked = spawnSync(process.execPath, [BIN, 'do some work'], {
    encoding: 'utf8',
    env: { ...process.env, COAGENT_PING_FILE: '/tmp/coagent-guard-test.jsonl' },
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /only notify, ask, pings are available to you/);

  const allowed = spawnSync(process.execPath, [BIN, 'notify', 'hello'], {
    encoding: 'utf8',
    env: { ...process.env, COAGENT_PING_FILE: '/tmp/coagent-guard-test.jsonl' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  fs.rmSync('/tmp/coagent-guard-test.jsonl', { force: true });
});

test('the ping cursor never eats a ping on a line boundary', () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = '99999999-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, sid);
  fs.writeFileSync(path.join(home, 'persona.md'), 'test\n');

  const env = {
    ...process.env,
    ...CLEAN,
    COAGENT_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_SESSION_ID: sid,
  };
  const pingFile = path.join(home, 'state', sid, 'pings.jsonl');
  const notify = (from, text) => spawnSync(process.execPath, [BIN, 'notify', text], {
    encoding: 'utf8',
    env: { ...env, COAGENT_PING_FILE: pingFile, COAGENT_PING_FROM: from },
  });
  const read = (...args) => spawnSync(process.execPath, [BIN, 'pings', ...args], { encoding: 'utf8', env }).stdout;

  notify('one', 'first');
  assert.match(read(), /@one {2}first/);
  assert.match(read(), /no new pings/, 'a second read must not repeat');

  // The cursor now sits exactly on a newline — the case that used to drop one.
  notify('two', 'second');
  const after = read();
  assert.match(after, /@two {2}second/, 'a ping after a boundary read must survive');
  assert.ok(!after.includes('first'), 'and must not replay what was already read');

  notify('three', 'third');
  notify('four', 'fourth');
  const both = read();
  assert.match(both, /@three {2}third/);
  assert.match(both, /@four {2}fourth/);

  assert.match(read('--all'), /first[\s\S]*fourth/, '--all replays the whole log');
  assert.match(read(), /no new pings/, 'and leaves the cursor clean');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a timed-out ask is distinguishable by status, not just by its message', () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = '77777777-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, sid);
  fs.writeFileSync(path.join(home, 'persona.md'), 'test\n');
  const env = {
    ...process.env,
    ...CLEAN,
    COAGENT_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_SESSION_ID: sid,
  };
  const pingFile = path.join(home, 'state', sid, 'pings.jsonl');

  const timedOut = spawnSync(process.execPath, [BIN, 'ask', '--timeout', '1', 'nobody will answer'], {
    encoding: 'utf8',
    env: { ...env, COAGENT_PING_FILE: pingFile, COAGENT_PING_FROM: 'w1' },
  });
  assert.equal(timedOut.status, 3, 'a wrapper must be able to branch on status, not parse the message');
  assert.match(timedOut.stdout, /NO ANSWER YET/);
  assert.match(timedOut.stdout, /do not guess/);

  const listed = spawnSync(process.execPath, [BIN, 'asks'], { encoding: 'utf8', env }).stdout;
  assert.match(listed, /parked/, 'an abandoned question must not look like a live one');

  // The question survives parking, so a late answer still resumes the tape.
  const id = listed.trim().split(/\s+/)[0];
  const answered = spawnSync(process.execPath, [BIN, 'answer', id, 'here you go'], { encoding: 'utf8', env });
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(spawnSync(process.execPath, [BIN, 'asks'], { encoding: 'utf8', env }).stdout, /no open questions/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('resolveBin never picks a cmux wrapper shim', () => {
  const home = tmp();
  const shimDir = path.join(home, 'cmux-cli-shims', 'abc');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, ['-e', `
    const H = require(${q(HARNESS)});
    console.log(H.resolveBin(H.byId('claude')));
  `], { encoding: 'utf8', env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, COAGENT_CLAUDE_BIN: '' } });
  assert.ok(!r.stdout.includes('cmux-cli-shims'), r.stdout);
  fs.rmSync(home, { recursive: true, force: true });
});

function runCoagent(args, env, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: -1, out, err: `${err}\n(test timeout)` }); }, timeoutMs);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

test('adapterForModel maps opus/fable to claude and grok-* to grok', () => {
  assert.equal(H.adapterForModel('fable').id, 'claude');
  assert.equal(H.adapterForModel('fable-5.1').id, 'claude');
  assert.equal(H.adapterForModel('opus').id, 'claude');
  assert.equal(H.adapterForModel('grok-4.6').id, 'grok');
  assert.equal(H.adapterForModel('not-a-model'), null);
});

test('a grok lead can drive an inner claude with --model fable', async () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = '33333333-1111-2222-3333-444444444444';
  const grokHome = path.join(home, 'grok');
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    current_model_id: 'grok-4.6',
    agent_name: 'grok-build-plan',
  }));
  fs.writeFileSync(path.join(home, 'persona.md'), 'You are a test colleague.\n');

  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  const argLog = path.join(home, 'args.txt');
  const whichBin = path.join(home, 'which.txt');
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
echo claude >> ${whichBin}
for a in "$@"; do echo "$a" >> ${argLog}; done
echo '{"session_id":"44444444-1111-2222-3333-444444444444","result":"fable says hi","duration_ms":42}'
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'grok'), `#!/bin/sh
echo grok >> ${whichBin}
echo '{"sessionId":"should-not-run","result":"wrong family"}'
`, { mode: 0o755 });

  const env = {
    ...process.env,
    ...CLEAN,
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
  };
  const sent = await runCoagent(['--model', 'fable', 'review this'], env);
  assert.equal(sent.code, 0, sent.err || sent.out);

  const waited = await runCoagent(['wait', '--timeout', '15'], env);
  assert.equal(waited.code, 0, waited.err || waited.out);
  assert.match(waited.out, /fable says hi/);

  const which = fs.readFileSync(whichBin, 'utf8');
  assert.match(which, /claude/);
  assert.ok(!which.includes('grok'), 'must not spawn the lead family');
  const args = fs.readFileSync(argLog, 'utf8');
  assert.match(args, /--append-system-prompt/);
  assert.match(args, /--model\nfable/);
  assert.ok(!args.includes('--rules'), 'grok flags must not reach claude');
  assert.ok(!args.includes('grok-build-plan'), 'lead grok agent name must not be passed to claude');

  const meta = JSON.parse(fs.readFileSync(path.join(home, 'state', sid, 'agents', 'main', 'meta.json'), 'utf8'));
  assert.equal(meta.harness, 'claude');
  assert.equal(meta.model, 'fable');

  fs.rmSync(home, { recursive: true, force: true });
});

test('inner grok inherits the lead effort and --effort overrides it', async () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = '55555555-1111-2222-3333-444444444444';
  const grokHome = path.join(home, 'grok');
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    current_model_id: 'grok-4.6',
    reasoning_effort: 'medium',
  }));
  fs.writeFileSync(path.join(home, 'persona.md'), '---\neffort: high\n---\nYou are a test colleague.\n');

  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  const argLog = path.join(home, 'args.txt');
  fs.writeFileSync(path.join(binDir, 'grok'), `#!/bin/sh
for a in "$@"; do echo "$a" >> ${argLog}; done
echo '{"sessionId":"66666666-1111-2222-3333-444444444444","result":"ok","durationMs":1}'
`, { mode: 0o755 });

  const env = {
    ...process.env,
    ...CLEAN,
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    GROK_HOME: grokHome,
    GROK_SESSION_ID: sid,
  };

  const inherited = await runCoagent(['ping'], env);
  assert.equal(inherited.code, 0, inherited.err || inherited.out);
  const waited = await runCoagent(['wait', '--timeout', '15'], env);
  assert.equal(waited.code, 0, waited.err || waited.out);
  let args = fs.readFileSync(argLog, 'utf8');
  assert.match(args, /--effort\nmedium/, 'lead effort should win over persona high');

  fs.writeFileSync(argLog, '');
  const overridden = await runCoagent(['--effort', 'low', 'again'], env);
  assert.equal(overridden.code, 0, overridden.err || overridden.out);
  const waited2 = await runCoagent(['wait', '--timeout', '15'], env);
  assert.equal(waited2.code, 0, waited2.err || waited2.out);
  args = fs.readFileSync(argLog, 'utf8');
  assert.match(args, /--effort\nlow/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('a claude lead drives an inner claude end to end', async () => {
  const home = tmp();
  const cwd = process.cwd();
  const sid = '11111111-1111-2222-3333-444444444444';
  writeClaudeTranscript(home, cwd, sid);
  fs.writeFileSync(path.join(home, 'persona.md'), 'You are a test colleague.\n');

  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  const argLog = path.join(home, 'args.txt');
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
for a in "$@"; do echo "$a" >> ${argLog}; done
echo '{"session_id":"22222222-1111-2222-3333-444444444444","result":"inner says hi","duration_ms":42}'
`, { mode: 0o755 });

  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    COAGENT_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_SESSION_ID: sid,
    GROK_SESSION_ID: undefined,
    COAGENT_HARNESS: undefined,
  };
  const sent = await runCoagent(['what is up'], env);
  assert.equal(sent.code, 0, sent.err || sent.out);

  const waited = await runCoagent(['wait', '--timeout', '15'], env);
  assert.equal(waited.code, 0, waited.err || waited.out);
  assert.match(waited.out, /inner says hi/);

  const args = fs.readFileSync(argLog, 'utf8');
  assert.match(args, /--append-system-prompt/, 'persona must reach claude as an appended system prompt');
  assert.match(args, /--session-id/);
  assert.ok(!args.includes('--rules'), 'grok-only flags must not reach claude');
  assert.ok(!args.includes('--always-approve'), 'grok-only flags must not reach claude');
  assert.match(args, /co-agent/, 'rules must tell the inner agent it is the co-agent');

  const meta = JSON.parse(fs.readFileSync(path.join(home, 'state', sid, 'agents', 'main', 'meta.json'), 'utf8'));
  assert.equal(meta.harness, 'claude', 'the harness is recorded with the tape');
  assert.equal(meta.sessionId, '22222222-1111-2222-3333-444444444444');

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
  if (!process.exitCode) console.log('\nall harness tests passed');
})();
