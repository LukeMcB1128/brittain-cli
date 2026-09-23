'use strict';

// A model stuck deliberating in its reasoning is stopped mid-stream and told
// to act — not compacted, since its context is fine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

const LOOP = [
  'The background renders but the calculator does not.',
  'Let me check the bundle again to see whether the component is included.',
  'Actually, let me reconsider — it could be the CSS.',
  'Let me first look at index.css once more.',
  'Wait, I should check the bundle instead.',
  'Actually, let me think about this differently.',
  'Let me just curl the page again.',
  'Actually, I realize I should open it in the browser.',
].join(' ').repeat(2);

async function run(t, turns) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-delib-')));
  const runtime = createRuntime({ host: createTestHost({ settings: settingsFor('ollama', fake) }), overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: 'the calculator is not appearing', cwd });
  const infos = seen.filter((e) => e.channel === 'stream:info').map((e) => e.payload);
  return { runtime, result, infos, fake };
}

test('a deliberation loop is cut off and answered with a commit-and-act directive', async (t) => {
  const { runtime, result, infos } = await run(t, [{ thinking: LOOP, split: 20 }, { text: 'Read the console: a TypeError in Calculator.' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Read the console: a TypeError in Calculator.');
  assert.ok(infos.some((info) => /LIVE GUARD: deliberation loop/.test(info)));
  assert.ok(infos.some((info) => /commit-and-act directive \(1\/2\)/.test(info)));
  assert.equal(infos.some((info) => /compact/i.test(info)), false, 'dithering is not compacted');
  const nudge = runtime.rt.session.conversation.find((m) => m.meta === 'nudge');
  assert.match(nudge.content, /planning in circles/);
});

test('still looping after two directives, the turn stops', async (t) => {
  const { result, infos, fake } = await run(t, [
    { thinking: LOOP, split: 20 }, { thinking: LOOP, split: 20 }, { thinking: LOOP, split: 20 }, { text: 'never reached' },
  ]);
  assert.notEqual(result.content, 'never reached');
  assert.ok(infos.some((info) => /Still looping after 2 nudges/.test(info)));
  assert.equal(fake.chats.filter((body) => body.tools).length, 3);
});
