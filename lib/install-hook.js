#!/usr/bin/env node
'use strict';

// Register (or update) coagent's PreToolUse hook in a Claude Code settings
// file. Idempotent. Replaces an older entry for the same guard (the jq-based
// ~/.claude/hooks/no-foreground-coagent-wait.sh) and leaves every other hook
// alone. Keeps a backup when it changes the file.
//
//   node lib/install-hook.js <settings.json> <node> <hook.js>

const fs = require('fs');

const MARKERS = ['no-foreground-wait.js', 'no-foreground-coagent-wait'];

function quote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function isOurs(handler) {
  return Boolean(handler) && typeof handler.command === 'string' && MARKERS.some((m) => handler.command.includes(m));
}

function withHook(settings, command) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const groups = (next.hooks.PreToolUse || [])
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((group) => group.hooks.length > 0);
  const entry = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command, if: 'Bash(coagent *)', timeout: 5 }],
  };
  next.hooks.PreToolUse = [entry, ...groups];
  return next;
}

function install(settingsPath, node, hook, now = Date.now()) {
  const exists = fs.existsSync(settingsPath);
  const current = exists ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  const command = `${quote(node)} ${quote(hook)}`;
  const next = withHook(current, command);
  const before = JSON.stringify(current);
  if (JSON.stringify(next) === before) return { changed: false, command };
  let backup = null;
  if (exists) {
    backup = `${settingsPath}.bak-coagent-${Math.floor(now / 1000)}`;
    fs.copyFileSync(settingsPath, backup);
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, command, backup };
}

if (require.main === module) {
  const [settingsPath, node, hook] = process.argv.slice(2);
  if (!settingsPath || !node || !hook) {
    console.error('usage: install-hook.js <settings.json> <node> <hook.js>');
    process.exit(2);
  }
  const result = install(settingsPath, node, hook);
  console.log(result.changed ? `  hook    ${settingsPath} (${result.command})` : `  hook    ${settingsPath} (already up to date)`);
  if (result.backup) console.log(`  backup  ${result.backup}`);
}

module.exports = { install, withHook, isOurs, quote };
