#!/usr/bin/env node
'use strict';

const assert = require('assert');
const R = require('../lib/render.js');

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

test('formatGrokUpdate pretty-prints user and assistant chunks', () => {
  const user = R.formatGrokUpdate({
    params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'hello world' } } },
  });
  assert.equal(user, '> hello world');
  const asst = R.formatGrokUpdate({
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } },
  });
  assert.equal(asst, '● hi');
});

test('formatGrokUpdate skips noise', () => {
  assert.equal(R.formatGrokUpdate({ params: { update: { sessionUpdate: 'hook_execution' } } }), null);
});

test('formatChatLine skips system/reasoning', () => {
  assert.equal(R.formatChatLine({ type: 'system', content: 'you are grok' }), null);
  assert.equal(R.formatChatLine({ type: 'user', content: 'do the thing' }), '> do the thing');
  assert.equal(R.formatChatLine({ type: 'assistant', content: [{ type: 'text', text: 'done' }] }), '● done');
});

test('formatConsult is a lead thread not grok soup', () => {
  const text = R.formatConsult({
    id: 'abc',
    status: 'done',
    message: 'Self-check please',
    answer: 'I am the inner Grok',
  }, { age: '2s ago' });
  assert.match(text, /^abc  done  2s ago/);
  assert.match(text, /> Self-check please/);
  assert.match(text, /● I am the inner Grok/);
  assert.doesNotMatch(text, /user_info/);
});

if (!process.exitCode) console.log('\nall render tests passed');
