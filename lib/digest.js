'use strict';

/**
 * Pure digest helpers for coagent (lead transcript → markdown + sidecar JSON).
 * Used by ~/.local/bin/coagent and unit tests.
 */

const DIGEST_MAX_CHARS = 80000;
const RESULT_CLIP = 400;
const RESULT_CLIP_FAIL = 800;
const CONTEXT_USER_TURNS = 3;
const MAX_SNAPSHOT_FILES = 20;
const MAX_SNAPSHOT_EDITS = 15;
const MAX_SNAPSHOT_COMMANDS = 10;
const MAX_SNAPSHOT_FAILURES = 8;

function emptySidecar() {
  return {
    filesTouched: [],
    edits: [],
    commands: [],
    tools: [],
    userTurns: [],
    agentSnippets: [],
    failures: [],
    openQuestions: [],
    outbox: [],
  };
}

function stripNoise(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1')
    .replace(/^.*hook success:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === 'content') && (p.text || (p.content && p.content.text)))
      .map((p) => p.text || (p.content && p.content.text) || '')
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content && typeof content.content.text === 'string') return content.content.text;
  }
  return '';
}

function homeify(s, home) {
  const h = home || '';
  if (!h) return String(s || '');
  const re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return String(s || '').replace(re, '~');
}

function clip(s, n, home) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  const h = homeify(t, home);
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

function summarizeToolInput(input, home) {
  const i = input || {};
  if (typeof i === 'string') return clip(i, 100, home);
  return (
    (i.command && `: ${clip(i.command, 120, home)}`) ||
    (i.file_path && ` ${clip(i.file_path, 100, home)}`) ||
    (i.target_file && ` ${clip(i.target_file, 100, home)}`) ||
    (i.path && ` ${clip(i.path, 100, home)}`) ||
    (i.pattern && ` /${clip(i.pattern, 60, home)}/`) ||
    (i.url && ` ${clip(i.url, 80, home)}`) ||
    (i.query && `: ${clip(i.query, 80, home)}`) ||
    (i.prompt && `: ${clip(i.prompt, 80, home)}`) ||
    (i.description && `: ${clip(i.description, 80, home)}`) ||
    ''
  );
}

function extractPaths(input, home) {
  const i = input || {};
  const paths = [];
  for (const k of ['file_path', 'target_file', 'path', 'paths']) {
    const v = i[k];
    if (typeof v === 'string') paths.push(homeify(v, home));
    else if (Array.isArray(v)) for (const p of v) if (typeof p === 'string') paths.push(homeify(p, home));
  }
  return paths;
}

function exitCodeFrom(text) {
  const s = String(text || '');
  let m = s.match(/exit(?:\s*code)?[:\s]+(\d+)/i);
  if (m) return +m[1];
  m = s.match(/Command failed.*?code\s+(\d+)/i);
  if (m) return +m[1];
  return null;
}

/** Line-based diffstat from old/new text (Grok ACP diff parts). */
function diffstatFromTexts(oldText, newText) {
  const oldLines = oldText == null || oldText === '' ? [] : String(oldText).split('\n');
  const newLines = newText == null || newText === '' ? [] : String(newText).split('\n');
  // Approximate: count lines only in new vs only in old (not LCS — good enough for summaries).
  if (!oldLines.length && newLines.length) {
    return { plus: newLines.length, minus: 0 };
  }
  if (oldLines.length && !newLines.length) {
    return { plus: 0, minus: oldLines.length };
  }
  // Simple line-set heuristic + length delta fallback.
  const oldSet = new Map();
  for (const ln of oldLines) oldSet.set(ln, (oldSet.get(ln) || 0) + 1);
  let minus = 0;
  let plus = 0;
  const newSet = new Map();
  for (const ln of newLines) newSet.set(ln, (newSet.get(ln) || 0) + 1);
  for (const [ln, c] of oldSet) {
    const n = newSet.get(ln) || 0;
    if (c > n) minus += c - n;
  }
  for (const [ln, c] of newSet) {
    const o = oldSet.get(ln) || 0;
    if (c > o) plus += c - o;
  }
  if (plus === 0 && minus === 0 && oldText !== newText) {
    const dl = newLines.length - oldLines.length;
    if (dl > 0) return { plus: dl, minus: 0 };
    if (dl < 0) return { plus: 0, minus: -dl };
    return { plus: 1, minus: 1 };
  }
  return { plus, minus };
}

function parseDiffstatHeuristic(text, toolName) {
  const name = String(toolName || '').toLowerCase();
  const isEdit = /search_replace|edit|write|apply_patch|str_replace|replace_all|notebook/.test(name);
  const s = String(text || '');
  let m = s.match(/\+(\d+)\s+[−\-]\s*(\d+)/);
  if (m) return { plus: +m[1], minus: +m[2] };
  m = s.match(/(\d+)\s+insertion[s]?.*?(\d+)\s+deletion/i);
  if (m) return { plus: +m[1], minus: +m[2] };
  if (!isEdit) return null;
  const plus = (s.match(/^\+[^+]/gm) || []).length;
  const minus = (s.match(/^-[^-]/gm) || []).length;
  if (plus + minus >= 2) return { plus, minus };
  return null;
}

/** Extract edit stats from Grok tool_call_update content diffs / locations. */
function editStatsFromGrokUpdate(update, home) {
  const edits = [];
  const content = update.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && part.type === 'diff') {
        const pth = homeify(part.path || '', home);
        const st = diffstatFromTexts(part.oldText, part.newText);
        if (pth) edits.push({ path: pth, plus: st.plus, minus: st.minus, source: 'diff' });
      }
    }
  }
  if (!edits.length && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      if (loc && loc.path) {
        edits.push({ path: homeify(loc.path, home), plus: null, minus: null, source: 'location' });
      }
    }
  }
  return edits;
}

function pushUnique(arr, v) {
  if (v && !arr.includes(v)) arr.push(v);
}

function renderTimelineAndSide(events, home) {
  const blocks = [];
  const side = emptySidecar();

  for (const e of events) {
    if (e.kind === 'user') {
      const t = stripNoise(e.text || '');
      if (!t) continue;
      blocks.push(`\n**User:** ${t}`);
      side.userTurns.push(clip(t, 400, home));
      const q = t.match(/(?:^|\n)\s*(?:TODO|FIXME|open questions?|questions?)\s*[:\-]\s*([\s\S]{0,400})/i);
      if (q) side.openQuestions.push(clip(q[1], 200, home));
      continue;
    }
    if (e.kind === 'agent') {
      const t = stripNoise(e.text || '');
      if (!t) continue;
      blocks.push(`\n**Lead agent:** ${t}`);
      side.agentSnippets.push(clip(t, 300, home));
      continue;
    }
    if (e.kind === 'tool') {
      const name = e.name || 'tool';
      const summary = `${name}${summarizeToolInput(e.input, home)}`;
      blocks.push(`  ↳ ${summary}`);
      side.tools.push({ name, summary: clip(summary, 160, home) });
      for (const p of extractPaths(e.input, home)) pushUnique(side.filesTouched, p);
      if (e.input && e.input.command) {
        side.commands.push({ cmd: clip(e.input.command, 160, home), exit: null, failed: false });
      }
      continue;
    }
    if (e.kind === 'result') {
      const raw = stripNoise(e.text || '');
      if (!raw && e.exit == null && !e.failed && !(e.edits && e.edits.length)) continue;
      const failed = !!e.failed || (e.exit != null && e.exit !== 0);
      const limit = failed ? RESULT_CLIP_FAIL : RESULT_CLIP;

      if (e.edits && e.edits.length) {
        for (const ed of e.edits) {
          pushUnique(side.filesTouched, ed.path);
          if (ed.plus != null || ed.minus != null) {
            side.edits.push({
              path: ed.path,
              plus: ed.plus || 0,
              minus: ed.minus || 0,
              tool: e.name || null,
            });
            blocks.push(`    ✎ ${ed.path}  +${ed.plus || 0}/-${ed.minus || 0}`);
          } else {
            blocks.push(`    ✎ ${ed.path}`);
          }
        }
      } else {
        const diff = parseDiffstatHeuristic(raw, e.name);
        const paths = extractPaths(e.input, home);
        for (const p of paths) pushUnique(side.filesTouched, p);
        if (diff && (paths[0] || e.path)) {
          const pth = homeify(paths[0] || e.path, home);
          side.edits.push({ path: pth, plus: diff.plus, minus: diff.minus, tool: e.name || null });
          blocks.push(`    ✎ ${pth}  +${diff.plus}/-${diff.minus}`);
        }
      }

      const exit = e.exit != null ? e.exit : exitCodeFrom(raw);
      if (e.input && e.input.command) {
        const last = side.commands[side.commands.length - 1];
        if (last && last.exit == null) {
          last.exit = exit;
          last.failed = failed;
        }
      }
      if (failed) {
        side.failures.push(clip(`${e.name || 'tool'}: ${raw || `exit ${exit}`}`, 240, home));
        blocks.push(`    ✗ ${exit != null ? `exit ${exit} · ` : ''}${clip(raw || 'failed', limit, home)}`);
      } else if (raw && !(e.edits && e.edits.length)) {
        if (/^\d+→/.test(raw) || raw.length > 200) {
          const lines = (raw.match(/\n/g) || []).length + 1;
          blocks.push(`    → ${clip(raw, Math.min(limit, 180), home)} (${lines} lines)`);
        } else {
          blocks.push(`    → ${clip(raw, limit, home)}`);
        }
      } else if (exit != null) {
        blocks.push(`    → exit ${exit}`);
      }
    }
  }

  // Cap snapshot lists.
  side.filesTouched = side.filesTouched.slice(-MAX_SNAPSHOT_FILES);
  side.edits = side.edits.slice(-MAX_SNAPSHOT_EDITS);
  side.commands = side.commands.slice(-MAX_SNAPSHOT_COMMANDS);
  side.failures = side.failures.slice(-MAX_SNAPSHOT_FAILURES);
  side.tools = side.tools.slice(-30);
  side.userTurns = side.userTurns.slice(-10);
  side.agentSnippets = side.agentSnippets.slice(-10);

  return { blocks, side };
}

function formatSidecarSummary(side) {
  const lines = ['## Snapshot'];
  if (side.filesTouched.length) {
    lines.push(`**Files (${side.filesTouched.length}):** ${side.filesTouched.join(', ')}`);
  }
  if (side.edits.length) {
    lines.push('**Edits:**');
    for (const e of side.edits) {
      if (e.plus != null) lines.push(`- ${e.path} +${e.plus}/-${e.minus}${e.tool ? ` (${e.tool})` : ''}`);
      else lines.push(`- ${e.path}${e.tool ? ` (${e.tool})` : ''}`);
    }
  }
  const failedCmds = side.commands.filter((c) => c.failed);
  if (failedCmds.length) {
    lines.push('**Failed commands:**');
    for (const c of failedCmds) lines.push(`- exit ${c.exit ?? '?'} · ${c.cmd}`);
  } else if (side.commands.length) {
    lines.push(`**Recent commands:** ${side.commands.map((c) => c.cmd).join(' · ')}`);
  }
  if (side.failures.length) {
    lines.push('**Failures:**');
    for (const f of side.failures) lines.push(`- ${f}`);
  }
  if (side.outbox && side.outbox.length) {
    lines.push(`**Outbox:** ${side.outbox.map((o) => o.name || o).join(', ')}`);
  }
  if (side.openQuestions.length) {
    lines.push('**Open questions (from user text):**');
    for (const q of side.openQuestions) lines.push(`- ${q}`);
  }
  if (lines.length === 1) return '';
  return `${lines.join('\n')}\n`;
}

function mergeSide(a, b) {
  const out = emptySidecar();
  for (const k of Object.keys(out)) {
    out[k] = [...(a[k] || []), ...(b[k] || [])];
  }
  out.filesTouched = [...new Set(out.filesTouched)].slice(-MAX_SNAPSHOT_FILES);
  out.edits = out.edits.slice(-MAX_SNAPSHOT_EDITS);
  out.commands = out.commands.slice(-MAX_SNAPSHOT_COMMANDS);
  out.failures = out.failures.slice(-MAX_SNAPSHOT_FAILURES);
  return out;
}

function eventsFromGrokRecs(recs, home) {
  const events = [];
  let userBuf = '';
  let agentBuf = '';
  const toolById = new Map();

  const flushUser = () => {
    if (userBuf) events.push({ kind: 'user', text: userBuf });
    userBuf = '';
  };
  const flushAgent = () => {
    if (agentBuf) events.push({ kind: 'agent', text: agentBuf });
    agentBuf = '';
  };

  for (const rec of recs) {
    // Accept normalized {update} or raw wire {params:{update}}
    const u = rec.update || (rec.params && rec.params.update) || {};
    const kind = u.sessionUpdate;
    if (kind === 'user_message_chunk') {
      flushAgent();
      userBuf += textFromContent(u.content) || '';
      continue;
    }
    if (kind === 'agent_message_chunk') {
      flushUser();
      agentBuf += textFromContent(u.content) || '';
      continue;
    }
    if (kind === 'agent_thought_chunk') continue;

    if (kind === 'tool_call') {
      flushUser();
      flushAgent();
      const name =
        (u._meta && u._meta['x.ai/tool'] && u._meta['x.ai/tool'].name) ||
        u.title ||
        'tool';
      const input = u.rawInput || (u._meta && u._meta['x.ai/tool'] && u._meta['x.ai/tool'].input) || {};
      if (u.toolCallId) toolById.set(u.toolCallId, { name, input });
      events.push({ kind: 'tool', name, input });
      continue;
    }
    if (kind === 'tool_call_update') {
      if (u.status && u.status !== 'completed' && u.status !== 'failed') {
        // Intermediate updates may still carry diff previews — capture edits early.
        const midEdits = editStatsFromGrokUpdate(u, home);
        if (!midEdits.length) continue;
      }
      flushUser();
      flushAgent();
      const meta = u.toolCallId ? toolById.get(u.toolCallId) : null;
      const text = stripNoise(textFromContent(u.content) || textFromContent(u.rawOutput));
      const failed = u.status === 'failed';
      const edits = editStatsFromGrokUpdate(u, home);
      // Avoid double-counting: only emit result once per completed/failed, but if
      // status is missing and we have diffs, still emit.
      if (u.status && u.status !== 'completed' && u.status !== 'failed' && edits.length) {
        // Preview-only — attach as result without failing.
        events.push({
          kind: 'result',
          text: '',
          failed: false,
          name: meta && meta.name,
          input: meta && meta.input,
          edits,
        });
        continue;
      }
      if (u.status && u.status !== 'completed' && u.status !== 'failed') continue;
      events.push({
        kind: 'result',
        text,
        failed,
        exit: failed ? 1 : exitCodeFrom(text),
        name: meta && meta.name,
        input: meta && meta.input,
        edits,
      });
    }
  }
  flushUser();
  flushAgent();
  return events;
}

function claudeResultText(rec) {
  const c = rec.message && rec.message.content;
  if (Array.isArray(c)) {
    const tr = c.find((p) => p && p.type === 'tool_result');
    if (tr) {
      if (typeof tr.content === 'string') return tr.content;
      if (Array.isArray(tr.content)) {
        return tr.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
      }
    }
  }
  const r = rec.toolUseResult;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    const parts = [r.stdout, r.stderr].filter(Boolean);
    if (r.exitCode != null && r.exitCode !== 0) parts.push(`exit ${r.exitCode}`);
    return parts.join(' ');
  }
  return '';
}

function eventsFromClaudeRecs(recs) {
  const events = [];
  const toolById = new Map();
  for (const rec of recs) {
    if (rec.isSidechain) continue;
    const c = rec.message && rec.message.content;
    if (rec.type === 'user') {
      const human = stripNoise(textFromContent(c));
      if (human) {
        events.push({ kind: 'user', text: human });
        continue;
      }
      let toolId = null;
      if (Array.isArray(c)) {
        const tr = c.find((p) => p && p.type === 'tool_result');
        if (tr) toolId = tr.tool_use_id || tr.toolUseId || null;
      }
      const meta = toolId ? toolById.get(toolId) : null;
      const text = claudeResultText(rec);
      const r = rec.toolUseResult;
      const exit = r && typeof r === 'object' && r.exitCode != null ? r.exitCode : exitCodeFrom(text);
      events.push({
        kind: 'result',
        text,
        exit,
        failed: exit != null && exit !== 0,
        name: meta && meta.name,
        input: meta && meta.input,
      });
      continue;
    }
    if (rec.type === 'assistant' && Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text' && p.text && p.text.trim()) {
          events.push({ kind: 'agent', text: p.text });
        } else if (p.type === 'tool_use') {
          if (p.id) toolById.set(p.id, { name: p.name, input: p.input });
          events.push({ kind: 'tool', name: p.name, input: p.input });
        }
      }
    }
  }
  return events;
}

/**
 * Build digest body + side from pre-parsed records.
 * @param {object} opts
 * @param {'claude'|'grok'} opts.harness
 * @param {array} opts.records - claude jsonl objs OR {eventId, update} grok recs
 * @param {string|null} opts.sinceMarker
 * @param {string} [opts.home]
 * @param {array} [opts.outboxIndex] - [{name,size,mtime}]
 */
function buildDigestFromRecords(opts) {
  const {
    harness,
    records,
    sinceMarker = null,
    home = '',
    outboxIndex = [],
    transcriptPath = '',
    pin = null,
  } = opts;

  const getMarker = harness === 'claude'
    ? (r) => r.uuid || null
    : (r) => r.eventId
      || (r.params && r.params._meta && r.params._meta.eventId)
      || null;
  const toEvents = harness === 'claude'
    ? (recs) => eventsFromClaudeRecs(recs)
    : (recs) => eventsFromGrokRecs(recs, home);

  const markers = records.map(getMarker);
  const lastMarker = markers.reduce((acc, m) => (m || acc), null);

  let startIdx = 0;
  let isDelta = false;
  let markerFound = false;
  if (sinceMarker) {
    const i = markers.findIndex((m) => m === sinceMarker);
    if (i >= 0) {
      startIdx = i + 1;
      isDelta = true;
      markerFound = true;
    }
  }

  const deltaRecs = records.slice(startIdx);
  const deltaEvents = toEvents(deltaRecs);
  const fullEvents = toEvents(records);

  let useFallback = false;
  let fallbackNote = '';
  if (sinceMarker && !markerFound) {
    useFallback = true;
    fallbackNote = 'marker not found — replaying recent context + full tail';
  } else if (
    isDelta
    && deltaEvents.filter((e) => e.kind === 'user' || e.kind === 'agent').length === 0
    && fullEvents.filter((e) => e.kind === 'user').length > 0
  ) {
    useFallback = true;
    fallbackNote = 'delta has no user/agent text — anchoring last user turns';
  }

  let contextPrefix = [];
  let contextSide = emptySidecar();
  if (useFallback) {
    let ctxEvents;
    if (!markerFound) {
      ctxEvents = fullEvents.slice(Math.max(0, fullEvents.length - 80));
      isDelta = false;
    } else {
      const users = fullEvents.filter((e) => e.kind === 'user').slice(-CONTEXT_USER_TURNS);
      const fails = fullEvents.filter((e) => e.kind === 'result' && e.failed).slice(-3);
      ctxEvents = [...users, ...fails];
    }
    const rendered = renderTimelineAndSide(ctxEvents, home);
    contextPrefix = rendered.blocks;
    contextSide = rendered.side;
  }

  const main = renderTimelineAndSide(
    (!markerFound && useFallback) ? [] : deltaEvents,
    home,
  );

  let blocks = (!markerFound && useFallback)
    ? contextPrefix
    : (useFallback ? [...contextPrefix, '\n---\n_Δ since last coagent reply:_', ...main.blocks] : main.blocks);

  let side = (!markerFound && useFallback)
    ? contextSide
    : (useFallback ? mergeSide(contextSide, main.side) : main.side);

  const fullSide = renderTimelineAndSide(fullEvents, home).side;
  side = {
    ...side,
    filesTouched: [...new Set([
      ...(fullSide.filesTouched || []).slice(-MAX_SNAPSHOT_FILES),
      ...side.filesTouched,
    ])].slice(-MAX_SNAPSHOT_FILES),
    edits: [...(fullSide.edits || []).slice(-MAX_SNAPSHOT_EDITS), ...side.edits]
      .slice(-MAX_SNAPSHOT_EDITS),
    outbox: outboxIndex.slice(0, 30),
  };

  const snapshot = formatSidecarSummary(side);
  let body = `${snapshot}${blocks.join('\n')}`.trim();
  let omitted = false;
  if (body.length > DIGEST_MAX_CHARS) {
    body = body.slice(body.length - DIGEST_MAX_CHARS);
    omitted = true;
  }

  const header = [
    isDelta
      ? '# Conversation update — new messages and lead actions since your last reply'
      : '# Live conversation — user ⇄ lead agent (including the lead\'s actions/tool calls)',
    `_source: ${transcriptPath} · lead=${harness}${isDelta ? ' · delta' : ' · full'}` +
      `${pin ? ` · pin=${pin}` : ''}_`,
    fallbackNote ? `_fallback: ${fallbackNote}_` : '',
    isDelta && !blocks.length && !snapshot
      ? '_(nothing new since your last reply — the lead\'s message below stands alone)_'
      : '',
    omitted ? '_[older entries trimmed; read the raw transcript for full history]_' : '',
    '',
  ].filter(Boolean).join('\n');

  return {
    markdown: `${header}\n${body}\n`,
    side,
    lastMarker,
    isDelta,
    fallbackNote,
    hardFallback: !!(fallbackNote && /marker not found/i.test(fallbackNote)),
  };
}

module.exports = {
  DIGEST_MAX_CHARS,
  MAX_SNAPSHOT_FILES,
  emptySidecar,
  stripNoise,
  textFromContent,
  homeify,
  clip,
  summarizeToolInput,
  extractPaths,
  diffstatFromTexts,
  editStatsFromGrokUpdate,
  eventsFromGrokRecs,
  eventsFromClaudeRecs,
  renderTimelineAndSide,
  formatSidecarSummary,
  buildDigestFromRecords,
};
