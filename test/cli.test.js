#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { parseModelSpec } = require('../bin/coagent');

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

test('parseModelSpec accepts harness names', () => {
  assert.deepEqual(parseModelSpec('grok'), { backendChoice: 'grok', modelId: null, raw: 'grok' });
  assert.deepEqual(parseModelSpec('claude'), { backendChoice: 'claude', modelId: null, raw: 'claude' });
});

test('parseModelSpec accepts backend/id', () => {
  const s = parseModelSpec('claude/opus');
  assert.equal(s.backendChoice, 'claude');
  assert.equal(s.modelId, 'opus');
});

test('parseModelSpec accepts raw grok-4.6', () => {
  const s = parseModelSpec('grok-4.6');
  assert.equal(s.backendChoice, 'grok');
  assert.equal(s.modelId, 'grok-4.6');
});

test('parseModelSpec empty is null', () => {
  assert.equal(parseModelSpec(null).raw, null);
  assert.equal(parseModelSpec('').raw, null);
});

if (!process.exitCode) console.log('\nall cli tests passed');
