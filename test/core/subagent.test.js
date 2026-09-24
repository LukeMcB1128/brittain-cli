'use strict';

// run_subagent: a read-only scout with its own context, whose report is the
// only thing the lead conversation receives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { SUBAGENT_MAX_STEPS } = require('../../src/core/subagent');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

const SECRET_FILE = 'the calculator renders into #root';

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sub-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), `// ${SECRET_FILE}\nrender(<Calculator />);\n`);
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=hunter2\n');
  return dir;
}

const isSubagent = (body) => /research subagent/.test(String(body.messages?.[0]?.content || ''));
const isTitle = (body) => /Create a clear title/.test(String(body.messages?.[0]?.content || ''));
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] });

// `lead` and `scout` are scripts: arrays of turns, or functions of the body.
async function run(t, { lead, scout, settings = {}, approvals = [], text = 'why is the calculator missing?', contextLength }) {
  const script = (turns) => (typeof turns === 'function' ? turns : (() => { let i = 0; return () => turns[Math.min(i++, turns.length - 1)]; })());
  const nextLead = script(lead);
  const nextScout = script(scout);
  const bodies = { lead: [], scout: [] };
  const fake = await createFakeProvider({
    ...(contextLength ? { contextLength } : {}),
    respond: (body) => {
      if (isTitle(body)) return { text: 'T' };
      if (isSubagent(body)) { bodies.scout.push(body); return nextScout(body); }
      bodies.lead.push(body);
      return nextLead(body);
    },
  }).start();
  t.after(() => fake.stop());
  const cwd = project();
  const host = createTestHost({ settings: { ...settingsFor('ollama', fake), ...settings }, approvals });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text, cwd });
  return { result, runtime, seen, bodies, host, cwd, fake };
}

const delegate = call('run_subagent', { task: 'Find where the calculator is rendered and report the file and line.' });

test('the subagent explores in its own context and only its report reaches the lead', async (t) => {
  const { result, runtime, seen, bodies } = await run(t, {
    lead: [delegate, { text: 'It renders in src/index.js line 2.' }],
    scout: [
      call('browse_files', { path: '.' }),
      call('read_file', { path: 'src/index.js' }),
      { text: 'src/index.js:2 renders <Calculator /> into #root.' },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.content, 'It renders in src/index.js line 2.');
  // The scout got the task and nothing of the lead's conversation.
  assert.equal(bodies.scout[0].messages.length, 2);
  assert.equal(bodies.scout[0].messages[1].content, 'Find where the calculator is rendered and report the file and line.');
  assert.ok(bodies.scout[0].tools.every((tool) => !['write_file', 'run_command', 'ask_user', 'run_subagent'].includes(tool.function.name)));
  // The lead saw the report, never the file.
  const toolMessage = runtime.rt.session.conversation.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /^Subagent report \(2 tool calls\):\nsrc\/index\.js:2 renders/);
  assert.equal(JSON.stringify(bodies.lead).includes(SECRET_FILE), false);
  assert.ok(JSON.stringify(bodies.scout).includes(SECRET_FILE));
  // The terminal was told what the scout did.
  const phases = seen.filter((e) => e.channel === 'stream:subagent').map((e) => e.payload.phase);
  assert.deepEqual(phases, ['start', 'tool', 'tool', 'done']);
  assert.equal(runtime.rt.session.usage.metrics.subagentRuns, 1);
  // The scout's model calls count toward the message.
  assert.equal(runtime.rt.session.usage.main.calls >= 5, true);
});

test('the subagent cannot write, run commands, or delegate', async (t) => {
  const { cwd, bodies } = await run(t, {
    lead: [delegate, { text: 'done' }],
    scout: [
      call('write_file', { path: 'pwned.txt', content: 'x' }),
      call('run_command', { command: 'touch ran.txt' }),
      call('run_subagent', { task: 'recurse' }),
      { text: 'Could not change anything.' },
    ],
  });
  assert.equal(fs.existsSync(path.join(cwd, 'pwned.txt')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'ran.txt')), false);
  const results = bodies.scout.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(results.length, 3);
  for (const result of results) assert.match(result, /not available to subagents/);
});

test('a sensitive read by the subagent still asks the human', async (t) => {
  const { host, bodies, runtime } = await run(t, {
    lead: [delegate, { text: 'done' }],
    scout: [call('read_file', { path: '.env' }), { text: 'Denied.' }],
    settings: { autoApprove: true },
    approvals: [false],
  });
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.sensitive, true);
  assert.equal(JSON.stringify(bodies.scout).includes('hunter2'), false);
  assert.equal(JSON.stringify(runtime.rt.session.conversation).includes('hunter2'), false);
});

test('a subagent that keeps exploring is made to report, with tools off', async (t) => {
  let n = 0;
  const { runtime, bodies, seen } = await run(t, {
    lead: [delegate, { text: 'done' }],
    scout: (body) => (body.tools ? call('get_file_lines', { path: 'src/index.js', start: (n++ % 2) + 1 }) : { text: 'Partial: index.js renders the calculator.' }),
  });
  const withTools = bodies.scout.filter((body) => body.tools);
  assert.equal(withTools.length, SUBAGENT_MAX_STEPS);
  const wrap = bodies.scout.at(-1);
  assert.equal(wrap.tools, undefined);
  assert.match(wrap.messages.at(-1).content, /tool budget is exhausted/);
  const toolMessage = runtime.rt.session.conversation.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /Partial: index\.js renders the calculator\./);
  const done = seen.find((e) => e.channel === 'stream:subagent' && e.payload.phase === 'done');
  assert.ok(done.payload.steps > 0);
});

test('the subagentModel setting picks the scout model', async (t) => {
  const { bodies } = await run(t, {
    lead: [delegate, { text: 'done' }],
    scout: [{ text: 'report' }],
    settings: { subagentModel: 'scout-model' },
  });
  assert.equal(bodies.scout[0].model, 'scout-model');
  assert.equal(bodies.lead[0].model, 'alpha-model');
});

test('an empty task is refused without starting a subagent', async (t) => {
  const { runtime, bodies } = await run(t, {
    lead: [call('run_subagent', { task: '  ' }), { text: 'ok' }],
    scout: [{ text: 'never' }],
  });
  assert.equal(bodies.scout.length, 0);
  assert.match(runtime.rt.session.conversation.find((m) => m.role === 'tool').content, /requires a task/);
});

// 8k: a request that could not fit the reply comes first (~81%). 64k: 85%
// comes first (a request may carry ~91% there).
for (const window of [8192, 65_536]) {
  test(`a subagent past 85% of a ${window.toLocaleString()}-token window stops exploring and reports`, async (t) => {
    let reads = 0;
    const estimate = (body) => Math.round(JSON.stringify([...(body.messages || []), ...(body.tools || [])]).length / 4);
    const { runtime, bodies } = await run(t, {
      lead: [delegate, { text: 'done' }],
      scout: (body) => {
        if (!body.tools) return { text: 'Read several modules; the calculator is in module0.' };
        // Big steps (two reads) until three quarters full, so a 64k window
        // fills before the 12-call cap; then small ones, so some requests
        // land between 85% and the ~91% a request may carry at 64k — the
        // band only the 85% rule stops.
        const nearlyFull = estimate(body) > window * 0.75;
        const toolCalls = (nearlyFull ? [0] : [0, 1]).map(() => {
          const file = `big${reads++}.js`;
          fs.writeFileSync(path.join(body.messages[0].content.match(/Working directory: (\S+)/)[1], file),
            Array.from({ length: nearlyFull ? 150 : 1200 }, (_, n) => `const line${n} = "${file} ${n}";`).join('\n'));
          return { name: 'read_file', arguments: { path: file } };
        });
        return { toolCalls };
      },
      contextLength: window,
    });
    const exploring = bodies.scout.filter((body) => body.tools);
    for (const body of exploring) assert.ok(estimate(body) <= window * 0.85, `scout request of ~${estimate(body)} tokens`);
    assert.ok(exploring.length < SUBAGENT_MAX_STEPS, 'stopped before the step cap');
    assert.equal(bodies.scout.at(-1).tools, undefined, 'the report was asked for with tools off');
    const toolMessage = runtime.rt.session.conversation.find((m) => m.role === 'tool');
    assert.match(toolMessage.content, /stopped early: its context reached \d+% of the window/);
    assert.match(toolMessage.content, /calculator is in module0/);
  });
}

test('Ctrl-C during a subagent stops the whole run', async (t) => {
  let runtime;
  let scoutCalls = 0;
  const leadBodies = [];
  const fake = await createFakeProvider({
    respond: (body) => {
      if (isTitle(body)) return { text: 'T' };
      if (isSubagent(body)) {
        scoutCalls += 1;
        runtime.commands.stop();
        return call('browse_files', { path: '.' });
      }
      leadBodies.push(body);
      return leadBodies.length === 1 ? delegate : { text: 'never' };
    },
  }).start();
  t.after(() => fake.stop());
  const cwd = project();
  runtime = createRuntime({ host: createTestHost({ settings: settingsFor('ollama', fake) }), overrides: { cwd } });
  const result = await runtime.commands.chat({ text: 'go', cwd });
  assert.equal(result.stopped, true);
  assert.equal(scoutCalls, 1, 'the scout made no further calls');
  assert.equal(leadBodies.length, 1, 'the lead did not carry on after the stop');
});

test('the transcript shows the subagent start, its calls, and the finish', () => {
  const { TRANSCRIPT_CHANNELS } = require('../../src/lib/run-sink');
  const render = TRANSCRIPT_CHANNELS.get('stream:subagent');
  assert.equal(render({ phase: 'start', task: 'Find the calculator\nand more' }), '⤷ subagent: Find the calculator and more');
  assert.equal(render({ phase: 'tool', name: 'read_file', args: { path: 'src/index.js' } }), '  ⤷ read_file(path=src/index.js)');
  assert.equal(render({ phase: 'done', steps: 1 }), '⤷ subagent done · 1 tool call');
  assert.equal(render({ phase: 'done', steps: 12, note: 'it ran out of time' }), '⤷ subagent done · 12 tool calls · stopped early: it ran out of time');
});
