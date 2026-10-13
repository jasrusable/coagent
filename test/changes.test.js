#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../lib/changes.js');

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

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-tree-')));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const check = (dir, before) => C.treeWarning(before, C.snapshot(dir));

test('an untouched tree, dirty or clean, is not flagged', () => {
  const dir = repo();
  assert.equal(check(dir, C.snapshot(dir)), null);
  fs.writeFileSync(path.join(dir, 'a.js'), 'dirty before the turn\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked before the turn\n');
  assert.equal(check(dir, C.snapshot(dir)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edits, new files, deletes, and rewrites of an already-dirty file are flagged', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'dirty before\n');
  const before = C.snapshot(dir);
  fs.writeFileSync(path.join(dir, 'a.js'), 'rewritten during\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'b\n');
  fs.rmSync(path.join(dir, '.gitignore'));
  const w = check(dir, before);
  assert.equal(w.changed, true);
  assert.match(w.text, /^⚠ working tree changed during a read-only \(unenforced\) turn: /);
  assert.match(w.text, /a\.js/);
  assert.match(w.text, /sub\/b\.js/);
  assert.match(w.text, /\.gitignore/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reverting a dirty file to HEAD is a change too', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'dirty\n');
  const before = C.snapshot(dir);
  git(dir, 'checkout', '--', 'a.js');
  assert.match(check(dir, before).text, /a\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a commit and a branch switch are flagged by ref', () => {
  const dir = repo();
  const before = C.snapshot(dir);
  git(dir, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(dir, 'c.js'), 'c\n');
  git(dir, 'add', 'c.js');
  git(dir, 'commit', '-q', '-m', 'c');
  const w = check(dir, before);
  assert.equal(w.changed, true);
  assert.match(w.text, /HEAD [0-9a-f]{8} → [0-9a-f]{8}/);
  assert.match(w.text, /branch main → side/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ignored files are out of scope', () => {
  const dir = repo();
  const before = C.snapshot(dir);
  fs.mkdirSync(path.join(dir, 'ignored'));
  fs.writeFileSync(path.join(dir, 'ignored', 'x'), 'x\n');
  assert.equal(check(dir, before), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a subdirectory snapshots the whole work tree', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  const before = C.snapshot(path.join(dir, 'sub'));
  assert.equal(before.root, dir);
  fs.writeFileSync(path.join(dir, 'a.js'), 'changed\n');
  assert.match(check(path.join(dir, 'sub'), before).text, /a\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outside git the change check says it could not run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-nogit-'));
  const before = C.snapshot(dir);
  assert.equal(before, null);
  const w = C.treeWarning(before, null);
  assert.equal(w.changed, false);
  assert.match(w.text, /not a git work tree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parsePorcelain keeps both sides of a rename', () => {
  const entries = C.parsePorcelain('R  new.js\0old.js\0 M a.js\0?? b c.txt\0');
  assert.deepEqual(entries.map((e) => e.file), ['new.js', 'old.js', 'a.js', 'b c.txt']);
});

if (!process.exitCode) console.log('\nall changes tests passed');
