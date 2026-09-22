#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { parseArgs, resolveEffort, buildRules, parseResult, loadPersona, DEFAULT_WAIT_SEC } = require('../bin/coagent');
const fs = require('fs');
const os = require('os');
const path = require('path');
const grok = require('../lib/harness/grok.js');
const claude = require('../lib/harness/claude.js');

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

test('parseArgs treats a message as send', () => {
  const a = parseArgs(['review the diff']);
  assert.deepEqual(a.rest, ['review the diff']);
  assert.equal(a.worker, false);
});

test('parseArgs later / wait / timeout / follow', () => {
  const a = parseArgs(['later', 'also this']);
  assert.deepEqual(a.rest, ['later', 'also this']);
  const b = parseArgs(['--timeout', '30', 'wait']);
  assert.equal(b.timeoutSec, 30);
  assert.deepEqual(b.rest, ['wait']);
  const c = parseArgs(['watch', '-f']);
  assert.equal(c.follow, true);
  assert.deepEqual(c.rest, ['watch']);
});

test('parseArgs rejects --timeout 0 and NaN', () => {
  assert.throws(() => parseArgs(['--timeout', '0', 'wait']), /timeout/);
  assert.throws(() => parseArgs(['--timeout', 'nope', 'wait']), /timeout/);
});

test('parseArgs rejects removed flags', () => {
  assert.throws(() => parseArgs(['--interrupt', 'x']), /gone/);
  assert.throws(() => parseArgs(['--lead', 'claude', 'x']), /gone/);
});

test('DEFAULT_WAIT_SEC is 600', () => {
  assert.equal(DEFAULT_WAIT_SEC, 600);
});

test('buildRules names identity, forbids recursion, points at the tapes, labels persona', () => {
  const rules = buildRules({
    personaBody: 'Be terse.',
    personaPath: '/tmp/persona.md',
    ha: grok,
    leadHa: grok,
    lead: {
      sessionId: 'lead-1',
      transcriptPath: '/tmp/updates.jsonl',
      contextPath: '/tmp/chat_history.jsonl',
    },
  });
  assert.match(rules, /lead Grok agent's co-agent/);
  assert.match(rules, /coagent notify/);
  assert.match(rules, /coagent ask/);
  assert.match(rules, /NO ANSWER YET/);
  assert.match(rules, /coagent pings/);
  assert.match(rules, /lead-1/);
  assert.match(rules, /\/tmp\/updates\.jsonl/);
  assert.match(rules, /\/tmp\/chat_history\.jsonl/);
  assert.match(rules, /Persona \(\/tmp\/persona\.md\):/);
  assert.match(rules, /Be terse/);
});

test('buildRules notes a cross-family inner agent', () => {
  const rules = buildRules({
    personaBody: 'Be terse.',
    personaPath: '/tmp/persona.md',
    ha: claude,
    leadHa: grok,
    lead: {
      sessionId: 'lead-1',
      transcriptPath: '/tmp/updates.jsonl',
      contextPath: '/tmp/chat_history.jsonl',
    },
  });
  assert.match(rules, /lead Grok agent's co-agent/);
  assert.match(rules, /You run as Claude Code/);
});

test('buildRules names the harness and only the tapes it has', () => {
  const rules = buildRules({
    personaBody: 'Be terse.',
    personaPath: '/tmp/persona.md',
    ha: claude,
    lead: { sessionId: 'lead-2', transcriptPath: '/tmp/lead-2.jsonl', contextPath: null },
  });
  assert.match(rules, /lead Claude Code agent's co-agent/);
  assert.match(rules, /\/tmp\/lead-2\.jsonl/);
  assert.ok(!rules.includes('chat_history'));
});

test('grok args resume vs create', () => {
  const common = {
    prompt: 'hello',
    effort: 'high',
    model: 'grok-4.6',
    permissionMode: 'bypassPermissions',
    rules: 'rules',
    cwd: '/tmp',
  };
  const create = grok.buildArgs({ ...common, sessionId: 'sid', resume: false });
  assert.ok(create.includes('--session-id'));
  assert.ok(create.includes('--verbatim'));
  assert.ok(create.includes('--always-approve'));
  assert.ok(create.includes('--rules'));
  assert.ok(create.includes('--cwd'));
  const resume = grok.buildArgs({ ...common, sessionId: 'sid', resume: true });
  assert.ok(resume.includes('--resume'));
  assert.ok(!resume.includes('--session-id'));
});

test('claude args map rules to --append-system-prompt and skip grok-only flags', () => {
  const common = {
    prompt: 'hello',
    effort: 'high',
    model: 'claude-opus-5',
    permissionMode: 'bypassPermissions',
    rules: 'rules',
    cwd: '/tmp',
  };
  const create = claude.buildArgs({ ...common, sessionId: 'sid', resume: false });
  assert.ok(create.includes('--session-id'));
  assert.ok(create.includes('--append-system-prompt'));
  assert.ok(create.includes('--permission-mode'));
  assert.equal(create[create.indexOf('--effort') + 1], 'high');
  for (const gone of ['--rules', '--verbatim', '--always-approve', '--cwd']) {
    assert.ok(!create.includes(gone), `${gone} should not be passed to claude`);
  }
  const resume = claude.buildArgs({ ...common, sessionId: 'sid', resume: true });
  assert.ok(resume.includes('--resume'));
  assert.ok(!resume.includes('--session-id'));
});

test('claude drops an effort level it does not understand', () => {
  const args = claude.buildArgs({ prompt: 'x', effort: 'ludicrous', rules: 'r', sessionId: 'sid' });
  assert.ok(!args.includes('--effort'));
});

test('a model never crosses families', () => {
  assert.ok(grok.acceptsModel('grok-4.6'));
  assert.ok(!grok.acceptsModel('claude-opus-5'));
  assert.ok(claude.acceptsModel('claude-opus-5'));
  assert.ok(claude.acceptsModel('opus'));
  assert.ok(claude.acceptsModel('fable'));
  assert.ok(!claude.acceptsModel('grok-4.6'));
});

test('adapterForModel picks the inner family from the model id', () => {
  const H = require('../lib/harness/index.js');
  assert.equal(H.adapterForModel('grok-4.6').id, 'grok');
  assert.equal(H.adapterForModel('claude-opus-5').id, 'claude');
  assert.equal(H.adapterForModel('opus').id, 'claude');
  assert.equal(H.adapterForModel('fable').id, 'claude');
  assert.equal(H.adapterForModel('fable-5.1').id, 'claude');
  assert.equal(H.adapterForModel('unknown-vendor-9'), null);
});

test('claude child env is scrubbed of the lead identity', () => {
  const env = claude.scrubEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'lead',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
    PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

test('parseResult reads json from either harness', () => {
  const g = parseResult(JSON.stringify({ sessionId: 'abc', result: 'done', durationMs: 1200 }));
  assert.equal(g.sessionId, 'abc');
  assert.equal(g.answer, 'done');
  assert.equal(g.durMs, 1200);
  const c = parseResult(JSON.stringify({
    session_id: 'def', result: 'ok', duration_ms: 900, is_error: false,
  }));
  assert.equal(c.sessionId, 'def');
  assert.equal(c.answer, 'ok');
  assert.equal(c.durMs, 900);
  assert.equal(c.isError, false);
});

test('parseArgs reads a brief from a file or stdin', () => {
  const a = parseArgs(['@review', '--brief-file', 'b.md']);
  assert.equal(a.briefFile, 'b.md');
  assert.equal(a.agentName, 'review');
  assert.deepEqual(a.rest, []);
  assert.equal(parseArgs(['--brief-file=b.md']).briefFile, 'b.md');
  assert.equal(parseArgs(['--brief=b.md']).briefFile, 'b.md');
  // a bare - is stdin, and must not survive into rest as a bogus verb
  const d = parseArgs(['@review', '-']);
  assert.equal(d.briefFile, '-');
  assert.deepEqual(d.rest, []);
});

test('parseArgs still rejects unknown options', () => {
  assert.throws(() => parseArgs(['--brief-file']), /needs a path/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('parseArgs reads --effort', () => {
  assert.equal(parseArgs(['--effort', 'medium', 'review']).effort, 'medium');
  assert.equal(parseArgs(['--effort=xhigh']).effort, 'xhigh');
  assert.equal(parseArgs(['-e', 'low', 'x']).effort, 'low');
  assert.throws(() => parseArgs(['--effort', 'ludicrous']), /effort/);
  assert.throws(() => parseArgs(['--effort']), /effort/);
});

test('resolveEffort prefers asked, then policy, then lead, then persona', () => {
  assert.equal(resolveEffort({ asked: 'low', policy: 'medium', lead: 'high', persona: 'max' }), 'low');
  assert.equal(resolveEffort({ asked: null, policy: 'medium', lead: 'high', persona: 'max' }), 'medium');
  assert.equal(resolveEffort({ asked: null, policy: null, lead: 'high', persona: 'max' }), 'high');
  assert.equal(resolveEffort({ asked: null, policy: null, lead: null, persona: 'max' }), 'max');
  assert.equal(resolveEffort({ asked: null, policy: null, lead: null, persona: null }), null);
});

test('grok describeSession reads reasoning_effort from summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-grok-'));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    current_model_id: 'grok-4.6',
    reasoning_effort: 'medium',
  }));
  const d = grok.describeSession({ dir });
  assert.equal(d.modelId, 'grok-4.6');
  assert.equal(d.effort, 'medium');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseResult reads cost and turns from either casing', () => {
  const a = parseResult(JSON.stringify({ result: 'x', total_cost_usd: 0.42, num_turns: 7 }));
  assert.equal(a.costUsd, 0.42);
  assert.equal(a.numTurns, 7);
  const b = parseResult(JSON.stringify({ result: 'x', totalCostUsd: 1.5, numTurns: 2 }));
  assert.equal(b.costUsd, 1.5);
  assert.equal(b.numTurns, 2);
  // absent is null, not 0 — 0 would read as a free turn
  const c = parseResult(JSON.stringify({ result: 'x' }));
  assert.equal(c.costUsd, null);
  assert.equal(c.numTurns, null);
  // a zero cost is still a real reading
  const d = parseResult(JSON.stringify({ result: 'x', total_cost_usd: 0, num_turns: 0 }));
  assert.equal(d.costUsd, 0);
  assert.equal(d.numTurns, 0);
});

test('persona parses per-agent model policy', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-')), 'persona.md');
  fs.writeFileSync(f, [
    '---',
    'model: claude-opus-5',
    'effort: high',
    'workerModel: claude-sonnet-5',
    'workerEffort: medium',
    'model.audit: claude-opus-5',
    'effort.audit: xhigh',
    '---',
    'Be terse.',
  ].join('\n'));
  const p = loadPersona(f);
  assert.equal(p.model, 'claude-opus-5');
  assert.equal(p.workerModel, 'claude-sonnet-5');
  assert.equal(p.workerEffort, 'medium');
  assert.equal(p.agentModel.audit, 'claude-opus-5');
  assert.equal(p.agentEffort.audit, 'xhigh');
  // the bare keys must not leak into the per-agent maps
  assert.equal(p.agentModel.model, undefined);
  assert.deepEqual(Object.keys(p.agentModel), ['audit']);
  assert.equal(p.persona, 'Be terse.');
});

test('persona without policy keys yields empty maps', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-')), 'persona.md');
  fs.writeFileSync(f, '---\neffort: high\n---\nx');
  const p = loadPersona(f);
  assert.equal(p.workerModel, null);
  assert.equal(p.workerEffort, null);
  assert.deepEqual(p.agentModel, {});
  assert.deepEqual(p.agentEffort, {});
});

if (!process.exitCode) console.log('\nall cli tests passed');
