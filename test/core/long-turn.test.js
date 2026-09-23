'use strict';

// A replay of a real session: on a 32k model, "give me a quick report" read
// file after file in one turn. Compaction could not keep anything (a turn was
// the smallest unit it would keep), and the request that finally went out was
// over the window and came back as a provider 400.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

const WINDOW = 32_768;
// contextLength − response reserve − safety margin, as the agent loop computes it.
const HARD_INPUT = WINDOW - 4096 - 2048;
const REQUEST = 'Look into this repo and give me a quick report';
const FILES = 10;

const estimate = (body) => Math.round(JSON.stringify([...(body.messages || []), ...(body.tools || [])]).length / 4);

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-long-')));
  for (let i = 0; i < FILES; i++) {
    const lines = Array.from({ length: 900 }, (_, n) => `// file ${i} line ${n}: const value${n} = compute(${n}, "${i}");`);
    fs.writeFileSync(path.join(dir, `module${i}.js`), lines.join('\n'));
  }
  return dir;
}

function summaryText(index) {
  return [
    `GOAL: ${REQUEST}.`,
    'CONSTRAINTS: none stated.',
    `DECISIONS: read each module in turn (pass ${index}).`,
    'STATE: several modules were read; each defines computed constants.',
    'NEXT: read the remaining modules, then write the report.',
    Array.from({ length: 120 }, (_, n) => `note${index}_${n}`).join(' '),
  ].join('\n');
}

test('one long turn on a 32k model compacts inside the turn and never overruns the window', async (t) => {
  const cwd = repo();
  let reads = 0;
  let summaries = 0;
  const agentRequests = [];
  const fake = await createFakeProvider({
    contextLength: WINDOW,
    respond: (body) => {
      if (!body.tools) {
        const system = String(body.messages?.[0]?.content || '');
        if (/Create a clear title/.test(system)) return { text: 'Repo report' };
        summaries += 1;
        return { text: summaryText(summaries) };
      }
      agentRequests.push(body);
      if (reads < FILES) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'Ten modules, each defining computed constants. Report done.' };
    },
  }).start();
  t.after(() => fake.stop());

  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: REQUEST, cwd });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.content, 'Ten modules, each defining computed constants. Report done.');
  assert.equal(reads, FILES, 'every file was read');

  // Compaction happened, inside the turn, and was reported as such.
  const compactions = runtime.rt.session.usage.metrics.compactions;
  assert.ok(compactions >= 1, `compactions: ${compactions}`);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /current request (and \d+ recent steps? )?kept verbatim/.test(e.payload)));
  assert.equal(seen.some((e) => e.channel === 'stream:info' && /Auto-compact failed/.test(e.payload)), false);

  // No request the model received was larger than it can take.
  for (const body of agentRequests) {
    assert.ok(estimate(body) <= HARD_INPUT, `a request of ~${estimate(body)} tokens exceeded ${HARD_INPUT}`);
  }

  // Each file read was capped to an eighth of the window.
  for (const body of agentRequests) {
    for (const message of body.messages.filter((m) => m.role === 'tool')) {
      assert.ok(message.content.length <= 16_384, `tool result of ${message.content.length} chars`);
    }
  }

  // The request survived verbatim, with the summary of what came before it.
  const last = agentRequests.at(-1).messages;
  assert.ok(last.some((m) => m.role === 'user' && m.content === REQUEST));
  assert.ok(last.some((m) => /Summary of the conversation so far/.test(m.content)));
  // Each compaction's ledger covers the reads since the one before; older
  // ones are carried by the summary (as in the source).
  assert.ok(last.some((m) => /SESSION LEDGER/.test(m.content) && /module\d\.js/.test(m.content)), 'the ledger lists earlier reads');
});

test('/compact works partway through a long turn', async (t) => {
  const cwd = repo();
  let reads = 0;
  const fake = await createFakeProvider({
    contextLength: 65_536,
    respond: (body) => {
      if (!body.tools) return { text: /Create a clear title/.test(String(body.messages?.[0]?.content)) ? 'T' : summaryText(1) };
      if (reads < 4) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'done' };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  await runtime.commands.chat({ text: REQUEST, cwd });
  // One turn only: before, this was refused as "the most recent turn is too large".
  const result = await runtime.commands.compact();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inTurn, true);
  assert.ok(result.after < result.before);
  assert.equal(runtime.rt.session.conversation.filter((m) => m.role === 'user' && m.content === REQUEST).length, 1);
});

test('a request that cannot fit even after compacting is refused with a clear message, not sent', async (t) => {
  const cwd = repo();
  const fake = await createFakeProvider({ contextLength: 4096, turns: [{ text: 'should never be asked' }] }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const result = await runtime.commands.chat({ text: 'x '.repeat(3000), cwd });
  assert.equal(result.ok, false);
  assert.match(result.error, /4,096-token window leaves room for [\d,]+\. .*Start a new chat with \/clear, or switch to a model with a larger window\./);
  assert.equal(fake.chats.length, 0, 'nothing was sent to the model');
});
