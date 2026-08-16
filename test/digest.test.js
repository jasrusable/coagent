#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const digest = require(path.join(__dirname, '..', 'lib', 'digest.js'));

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

test('diffstatFromTexts counts added/removed lines', () => {
  const st = digest.diffstatFromTexts('a\nb\nc', 'a\nb\nc\nd\ne');
  assert.ok(st.plus >= 2, `expected plus>=2 got ${st.plus}`);
  assert.equal(st.minus, 0);
  const st2 = digest.diffstatFromTexts('a\nb\nc', 'a');
  assert.ok(st2.minus >= 2, `expected minus>=2 got ${st2.minus}`);
});

test('editStatsFromGrokUpdate reads diff parts', () => {
  const edits = digest.editStatsFromGrokUpdate({
    content: [{
      type: 'diff',
      path: '/Users/me/proj/file.ts',
      oldText: 'const x = 1;\n',
      newText: 'const x = 1;\nconst y = 2;\n',
    }],
  }, '/Users/me');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, '~/proj/file.ts');
  assert.ok(edits[0].plus >= 1);
});

test('eventsFromGrokRecs strips thoughts and captures tools', () => {
  const recs = [
    { eventId: '1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } } },
    { eventId: '2', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret thought' } } },
    { eventId: '3', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi back' } } },
    {
      eventId: '4',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read_file',
        rawInput: { target_file: '/tmp/a' },
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      },
    },
    {
      eventId: '5',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
    },
  ];
  const events = digest.eventsFromGrokRecs(recs, '/tmp');
  assert.ok(events.some((e) => e.kind === 'user' && e.text.includes('hello')));
  assert.ok(events.some((e) => e.kind === 'agent' && e.text.includes('hi back')));
  assert.ok(!JSON.stringify(events).includes('secret thought'));
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'read_file'));
  assert.ok(events.some((e) => e.kind === 'result' && (e.text || '').includes('file body')));
});

test('buildDigestFromRecords produces snapshot + edit from grok diff', () => {
  const recs = [
    { eventId: 'a', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'edit the file' } } },
    {
      eventId: 'b',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        rawInput: { file_path: '/Users/me/x.js', old_string: 'a', new_string: 'b' },
        _meta: { 'x.ai/tool': { name: 'search_replace' } },
      },
    },
    {
      eventId: 'c',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e1',
        status: 'completed',
        content: [{
          type: 'diff',
          path: '/Users/me/x.js',
          oldText: 'line1\n',
          newText: 'line1\nline2\n',
        }],
      },
    },
  ];
  const d = digest.buildDigestFromRecords({
    harness: 'grok',
    records: recs,
    sinceMarker: null,
    home: '/Users/me',
    outboxIndex: [{ name: 'review.md', size: 10, mtime: 't' }],
    transcriptPath: '/tmp/updates.jsonl',
    pin: 'test',
  });
  assert.ok(d.markdown.includes('**User:**'));
  assert.ok(d.markdown.includes('✎') || d.side.edits.length >= 1, 'expected edit stats');
  assert.ok(d.side.outbox.some((o) => o.name === 'review.md'));
  assert.ok(d.side.filesTouched.length <= digest.MAX_SNAPSHOT_FILES);
  assert.equal(d.isDelta, false);
  assert.equal(d.lastMarker, 'c');
});

test('delta fallback when marker missing', () => {
  const recs = [
    { eventId: '1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'u1' } } },
    { eventId: '2', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'u2' } } },
  ];
  const d = digest.buildDigestFromRecords({
    harness: 'grok',
    records: recs,
    sinceMarker: 'missing-marker',
    home: '',
    outboxIndex: [],
    transcriptPath: 't',
  });
  assert.ok(d.hardFallback);
  assert.ok(/marker not found/.test(d.fallbackNote));
});

test('claude events map tool_use', () => {
  const recs = [
    { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'go' }] } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'tid', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tid', content: 'ok' }] },
      toolUseResult: { stdout: 'ok', exitCode: 0 },
    },
  ];
  const events = digest.eventsFromClaudeRecs(recs);
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'Bash'));
  assert.ok(events.some((e) => e.kind === 'result'));
});

test('buildDigestFromRecords includes an inline slice of recent speech', () => {
  const recs = [
    { eventId: '1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'please fix the widget' } } },
    { eventId: '2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will look at the widget' } } },
  ];
  const d = digest.buildDigestFromRecords({
    harness: 'grok',
    records: recs,
    sinceMarker: null,
    home: '',
    outboxIndex: [],
    transcriptPath: 't',
  });
  assert.ok(d.inline, 'expected inline digest');
  assert.ok(d.inline.includes('widget'), 'inline should contain recent user text');
  assert.ok(d.inline.length <= digest.INLINE_MAX_CHARS + 10);
});

if (!process.exitCode) console.log('\nall digest tests passed');
