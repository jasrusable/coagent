'use strict';

/** Clip / pretty-print helpers for watch and log. */

function clip(s, n, home) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (home) {
    const re = new RegExp(String(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    t = t.replace(re, '~');
  }
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === 'content' || p.text))
      .map((p) => p.text || (p.content && p.content.text) || '')
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content && typeof content.content.text === 'string') return content.content.text;
  }
  return '';
}

function summarizeToolInput(input, home) {
  const i = input || {};
  if (typeof i === 'string') return `: ${clip(i, 100, home)}`;
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

function formatGrokUpdate(rec, home) {
  const u = (rec && rec.params && rec.params.update) || {};
  const kind = u.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const t = textFromContent(u.content);
    return t ? `● ${clip(t, 200, home)}` : null;
  }
  if (kind === 'user_message_chunk') {
    const t = textFromContent(u.content);
    return t ? `> ${clip(t, 200, home)}` : null;
  }
  if (kind === 'tool_call') {
    const name = (u._meta && u._meta['x.ai/tool'] && u._meta['x.ai/tool'].name) || u.title || 'tool';
    return `  ↳ ${name}${summarizeToolInput(u.rawInput || {}, home)}`;
  }
  if (kind === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
    const t = textFromContent(u.content);
    const mark = u.status === 'failed' ? '✗' : '→';
    return t ? `      ${mark} ${clip(t, 160, home)}` : null;
  }
  return null;
}

function formatClaudeUpdate(rec, home) {
  const t = rec && rec.type;
  if (t !== 'assistant' && t !== 'user') return null;
  const content = rec.message && rec.message.content;
  if (typeof content === 'string') {
    return content.trim() ? `> ${clip(content, 200, home)}` : null;
  }
  if (!Array.isArray(content)) return null;
  const lines = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text && part.text.trim()) {
      lines.push(`${t === 'assistant' ? '●' : '>'} ${clip(part.text, 200, home)}`);
    } else if (part.type === 'tool_use') {
      lines.push(`  \u21b3 ${part.name || 'tool'}${summarizeToolInput(part.input || {}, home)}`);
    } else if (part.type === 'tool_result') {
      const text = textFromContent(part.content);
      if (text.trim()) lines.push(`      ${part.is_error ? '\u2717' : '\u2192'} ${clip(text, 160, home)}`);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

function formatChatLine(rec, home) {
  const t = rec && rec.type;
  if (!t || t === 'system' || t === 'reasoning') return null;
  const text = textFromContent(rec.content);
  if (!text) return null;
  if (t === 'user') return `> ${clip(text, 240, home)}`;
  if (t === 'assistant') return `● ${clip(text, 240, home)}`;
  if (t === 'tool_result') return `  ↳ ${clip(text, 160, home)}`;
  return null;
}

/** Lead consult: our message + inner reply. Not raw grok chat_history. */
function formatConsult(item, { home, age, answerMax = null } = {}) {
  const it = item || {};
  const head = [it.id, it.status, age].filter(Boolean).join('  ');
  const lines = [head];
  if (it.message) lines.push(`  > ${clip(it.message, 200, home)}`);
  if (it.status === 'done' && it.answer) {
    let ans = String(it.answer).trim();
    if (answerMax != null && ans.length > answerMax) ans = `${ans.slice(0, answerMax)}…`;
    const bodyLines = ans.split('\n');
    const cap = answerMax != null ? 12 : bodyLines.length;
    for (const ln of bodyLines.slice(0, cap)) lines.push(`  ● ${ln}`);
    if (bodyLines.length > cap) lines.push('  ● …');
  } else if (it.status === 'failed') {
    lines.push(`  ✗ ${clip(it.error || 'failed', 200, home)}`);
  } else if (it.status === 'interrupted') {
    lines.push('  ⚠ interrupted');
  }
  return lines.join('\n');
}

module.exports = {
  clip,
  textFromContent,
  summarizeToolInput,
  formatGrokUpdate,
  formatClaudeUpdate,
  formatChatLine,
  formatConsult,
};
