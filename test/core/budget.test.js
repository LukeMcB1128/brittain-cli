'use strict';

// PLAN.md §4.1: system prompt + tool schemas for an empty conversation with no
// memory, built exactly as the agent loop sends them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { estimateContextTokens } = require('../../src/lib/context-estimator');
const { createTestHost } = require('../helpers/test-host');

const BUDGET = { code: 3000, chat: 800 };

function payloadTokens(rt, mode, cwd) {
  const system = { role: 'system', content: rt.prompts.promptFor(mode, cwd, 'brittain-4') };
  const tools = rt.prompts.activeToolDefs(mode === 'chat');
  return estimateContextTokens(system) + estimateContextTokens(tools);
}

for (const mode of ['code', 'chat']) {
  test(`${mode} mode fits its token budget (${BUDGET[mode]})`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-budget-'));
    const { rt } = createRuntime({ host: createTestHost(), overrides: { cwd } });
    const tokens = payloadTokens(rt, mode, cwd);
    assert.ok(tokens <= BUDGET[mode], `${mode}: ${tokens} tokens > ${BUDGET[mode]}`);
    // The inspector's number is the same one the loop sends.
    assert.equal(rt.prompts.fixedOverheadTokens(cwd, 'brittain-4', mode), tokens);
  });
}
