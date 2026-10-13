'use strict';

// Before/after picture of a git work tree, for turns where only the prompt
// stops the inner agent writing. Covers HEAD, the branch, and every tracked or
// untracked (not ignored) path that differs from HEAD. It cannot tell who made
// a change: the lead editing the same checkout shows up too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HASH_MAX_BYTES = 32 * 1024 * 1024;
const SHOW_FILES = 8;

// --no-optional-locks: the inner agent may be using git in the same tree.
function git(cwd, args) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

// Content, not just status: a file already modified before the turn stays
// " M" however much the turn rewrites it.
function fingerprint(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return 'missing'; }
  if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
  if (!st.isFile()) return st.isDirectory() ? 'dir' : 'other';
  if (st.size > HASH_MAX_BYTES) return `big:${st.size}:${st.mtimeMs}`;
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

// `-z` records are "XY path"; a rename or copy is followed by its old path.
function parsePorcelain(out) {
  const parts = String(out || '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    entries.push({ xy, file: rec.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      if (parts[i]) entries.push({ xy, file: parts[i] });
    }
  }
  return entries;
}

function firstLine(out) {
  return String(out || '').trim() || null;
}

// null when cwd is not inside a git work tree.
function snapshot(cwd) {
  const top = firstLine(git(cwd, ['rev-parse', '--show-toplevel']));
  if (!top) return null;
  const status = git(top, ['status', '--porcelain=v1', '-z', '-uall']);
  if (status == null) return null;
  const files = Object.fromEntries(parsePorcelain(status).map(({ xy, file }) => (
    [file, `${xy} ${fingerprint(path.join(top, file))}`]
  )));
  return {
    root: top,
    head: firstLine(git(top, ['rev-parse', '-q', '--verify', 'HEAD'])),
    branch: firstLine(git(top, ['symbolic-ref', '-q', '--short', 'HEAD'])),
    files,
  };
}

const short = (sha) => (sha ? sha.slice(0, 8) : '(none)');

function diffSnapshots(before, after) {
  const keys = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  return {
    files: keys.filter((k) => before.files[k] !== after.files[k]),
    refs: [
      before.head !== after.head && `HEAD ${short(before.head)} → ${short(after.head)}`,
      before.branch !== after.branch && `branch ${before.branch || '(detached)'} → ${after.branch || '(detached)'}`,
    ].filter(Boolean),
  };
}

// { changed, text } to show the lead, or null when the tree is untouched.
function treeWarning(before, after) {
  if (!before) return { changed: false, text: '⚠ read-only (unenforced): not a git work tree, so changes were not checked' };
  if (!after) return { changed: false, text: '⚠ read-only (unenforced): could not re-read the git tree after the turn' };
  const { files, refs } = diffSnapshots(before, after);
  if (!files.length && !refs.length) return null;
  const more = files.length > SHOW_FILES ? ` (+${files.length - SHOW_FILES} more)` : '';
  const listed = files.length ? [`${files.slice(0, SHOW_FILES).join(', ')}${more}`] : [];
  return {
    changed: true,
    text: `⚠ working tree changed during a read-only (unenforced) turn: ${[...refs, ...listed].join('; ')}`,
  };
}

module.exports = { snapshot, diffSnapshots, treeWarning, parsePorcelain };
