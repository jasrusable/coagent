#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../hooks/no-foreground-wait.js');
const { install, withHook } = require('../lib/install-hook.js');

const HOOK = path.join(__dirname, '..', 'hooks', 'no-foreground-wait.js');

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

const bash = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra } });
const denied = (event) => Boolean(decide(event)) && decide(event).hookSpecificOutput.permissionDecision === 'deny';

test('a foreground wait is refused', () => {
  for (const command of ['coagent wait', 'coagent @rev wait', 'coagent wait 3', 'cd x && coagent wait', '(coagent wait)', 'coagent  wait;echo']) {
    assert.ok(denied(bash(command)), command);
  }
});

test('a background wait and other verbs pass', () => {
  assert.ok(!denied(bash('coagent wait', { run_in_background: true })));
  for (const command of ['coagent notify "wait for CI"', 'coagent "please wait"', 'coagent watch', 'coagent waiting', 'echo coagent-wait', 'ls']) {
    assert.ok(!denied(bash(command)), command);
  }
});

test('unreadable input is allowed, not a crash', () => {
  assert.equal(decide(null), null);
  assert.equal(decide({ tool_input: { command: 42 } }), null);
  const done = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(done.status, 0);
  assert.equal(done.stdout, '');
});

test('the hook process prints a deny reply', () => {
  const done = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash('coagent wait')), encoding: 'utf8' });
  assert.equal(done.status, 0);
  assert.equal(JSON.parse(done.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const quiet = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash('ls')), encoding: 'utf8' });
  assert.equal(quiet.stdout, '');
});

test('install replaces the old jq hook and keeps other hooks', () => {
  const settings = {
    permissions: { deny: ['Read(~/.netrc)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/x/.claude/hooks/no-foreground-coagent-wait.sh', if: 'Bash(coagent *)', timeout: 5 }] },
        { matcher: '.*', hooks: [{ type: 'command', command: '/usr/bin/python3 /x/bin/blindfold hook', onFailure: 'block' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  const next = withHook(settings, '/usr/local/bin/node /h/hooks/no-foreground-wait.js');
  assert.equal(next.hooks.PreToolUse.length, 2);
  assert.equal(next.hooks.PreToolUse[0].hooks[0].command, '/usr/local/bin/node /h/hooks/no-foreground-wait.js');
  assert.equal(next.hooks.PreToolUse[1].hooks[0].command, '/usr/bin/python3 /x/bin/blindfold hook');
  assert.deepEqual(next.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(next.permissions, settings.permissions);
  assert.ok(!JSON.stringify(next).includes('no-foreground-coagent-wait.sh'));
});

test('install writes once, with a backup, then is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-hook-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'x' }));
    const first = install(file, '/opt/node bin/node', '/h/hooks/no-foreground-wait.js', 1000);
    assert.ok(first.changed);
    assert.ok(fs.existsSync(first.backup));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.model, 'x');
    assert.equal(written.hooks.PreToolUse[0].hooks[0].command, "'/opt/node bin/node' /h/hooks/no-foreground-wait.js");
    assert.equal(install(file, '/opt/node bin/node', '/h/hooks/no-foreground-wait.js').changed, false);
    const fresh = path.join(dir, 'new.json');
    assert.ok(install(fresh, '/n', '/h.js').changed);
    assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('new.json.bak')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (!process.exitCode) console.log('\nall hook tests passed');
