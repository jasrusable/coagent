#!/usr/bin/env node
'use strict';

// Claude Code PreToolUse hook: refuse `coagent wait` run in the foreground.
// A foreground wait re-blocks the lead's turn, the exact problem running the
// waiter in the background exists to solve. Matches only `coagent wait` and
// `coagent @name wait`, never `coagent notify "…wait…"`. Node stdlib only.
//
// A guard for a habit, not a security boundary: anything it can't read is
// allowed, and the hook entry doesn't set onFailure.

const WAIT_RE = /(^|[;&|(`]|\s)coagent\s+(@\S+\s+)?wait(\s|[;&|)`]|$)/;

const REASON =
  'Foreground `coagent wait` blocks your turn, the thing backgrounding exists to prevent. Re-run this exact ' +
  'command with run_in_background: true; you are re-invoked when it finishes. Reply to the user now instead of waiting.';

function decide(event) {
  const input = (event && (event.tool_input || event.toolInput)) || {};
  if (input.run_in_background === true) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!WAIT_RE.test(command)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  };
}

function main() {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return;
    }
    const reply = decide(event);
    if (reply) process.stdout.write(JSON.stringify(reply));
  });
}

if (require.main === module) main();

module.exports = { decide, WAIT_RE };
