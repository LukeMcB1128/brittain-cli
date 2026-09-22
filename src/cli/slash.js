'use strict';

// Slash commands (PLAN.md M7). Each entry is { usage, summary, run }. /help
// prints exactly this table, so a command cannot exist without being listed.
//
// Every handler goes through runtime.commands — the same map print mode uses —
// and reports through `ui`, which the REPL provides:
//   ui.line(text), ui.style, ui.pick(question, items, opts), ui.state

const { MODE_IDS } = require('../lib/providers');

function parseSlash(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) return null;
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  const rest = match[2].trim();
  return { name: match[1].toLowerCase(), rest, args: rest ? rest.split(/\s+/) : [] };
}

function onOff(value, current) {
  if (value === undefined || value === '') return !current;
  if (/^(on|true|yes|1)$/i.test(value)) return true;
  if (/^(off|false|no|0)$/i.test(value)) return false;
  return null;
}

// Fuzzy enough for model ids: exact, then prefix, then substring, then every
// typed character in order.
function matchModels(models, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return models;
  const exact = models.filter((id) => id.toLowerCase() === q);
  if (exact.length) return exact;
  const prefix = models.filter((id) => id.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  const substring = models.filter((id) => id.toLowerCase().includes(q));
  if (substring.length) return substring;
  return models.filter((id) => {
    let at = 0;
    for (const ch of id.toLowerCase()) if (ch === q[at]) at += 1;
    return at === q.length;
  });
}

function createSlash({ runtime, ui, setupProvider }) {
  const { commands, rt } = runtime;

  const table = [
    {
      name: 'help',
      usage: '/help',
      summary: 'Everything below, nothing more',
      run: () => {
        const width = Math.max(...table.map((entry) => entry.usage.length));
        for (const entry of table) ui.line(`${entry.usage.padEnd(width)}  ${ui.style.dim(entry.summary)}`);
      },
    },
    {
      name: 'clear',
      usage: '/clear',
      summary: 'New chat',
      run: () => {
        const result = commands.reset();
        ui.line(result.ok ? 'Started a new chat.' : result.error);
      },
    },
    {
      name: 'mode',
      usage: '/mode code|chat',
      summary: 'Switch mode',
      run: ({ args }) => {
        const wanted = args[0];
        if (!wanted) return ui.line(`Mode: ${ui.state.mode}`);
        if (!['code', 'chat'].includes(wanted)) return ui.line('Usage: /mode code|chat');
        ui.state.mode = wanted;
        ui.line(`Mode: ${wanted}`);
      },
    },
    {
      name: 'provider',
      usage: '/provider [brittain|openai|ollama]',
      summary: 'Show or switch the provider',
      run: async ({ args }) => {
        const info = commands['provider.get']();
        let mode = args[0];
        if (!mode) {
          mode = await ui.pick('Provider (number or name, Enter to keep):',
            info.providers.map((entry) => ({ label: `${entry.mode.padEnd(8)} ${entry.label} · ${entry.model || '(no model)'}`, value: entry.mode })),
            { current: info.active });
          if (!mode || mode === info.active) return;
        }
        if (!MODE_IDS.includes(mode)) return ui.line(`Unknown provider "${mode}". Choose ${MODE_IDS.join(', ')}.`);
        if (setupProvider) {
          const ok = await setupProvider(mode);
          if (!ok) return;
        }
        const result = commands['provider.set']({ mode });
        ui.line(result.ok ? `Provider: ${result.mode} (${result.label}) · model: ${result.model || '(none)'}` : result.error);
      },
    },
    {
      name: 'model',
      usage: '/model [name]',
      summary: 'Fuzzy match / picker for the active mode',
      run: async ({ rest }) => {
        const listed = await commands['models.list']();
        if (!listed.ok) return ui.line(listed.error);
        const current = rt.providers.resolve().model;
        const matches = matchModels(listed.models, rest);
        let model = matches.length === 1 && rest ? matches[0] : null;
        if (!model) {
          if (!matches.length) return ui.line(`No model matches "${rest}".`);
          model = await ui.pick('Model (number or name, Enter to keep):', matches.map((id) => ({ label: id, value: id })), { current });
        }
        if (!model || model === current) return;
        const result = commands['provider.set']({ model });
        ui.line(result.ok ? `Model: ${result.model}` : result.error);
      },
    },
    {
      name: 'auto',
      usage: '/auto on|off',
      summary: 'Trusted vs supervised',
      run: ({ args }) => {
        const value = onOff(args[0], ui.state.autoApprove);
        if (value === null) return ui.line('Usage: /auto on|off');
        ui.state.autoApprove = value;
        ui.line(value
          ? 'Auto-approve on (trusted): edits and commands run without asking. Destructive, sensitive, and payment actions still ask.'
          : 'Auto-approve off (supervised): every risky tool asks.');
      },
    },
    {
      name: 'think',
      usage: '/think on|off',
      summary: 'Thinking for the active mode',
      run: ({ args }) => {
        const key = ui.state.mode === 'chat' ? 'chatThink' : 'codeThink';
        const current = rt.config.stored()[key];
        const value = onOff(args[0], current);
        if (value === null) return ui.line('Usage: /think on|off');
        commands['settings.set']({ key, value: String(value) });
        ui.line(`Thinking ${value ? 'on' : 'off'} for ${ui.state.mode} mode.`);
      },
    },
    {
      name: 'history',
      usage: '/history',
      summary: 'List/load/delete saved chats',
      run: async ({ args }) => {
        const { chats } = commands['history.list']();
        if (!chats.length) return ui.line('No saved chats yet.');
        if (args[0] === 'delete' && args[1]) {
          const result = commands['history.delete']({ id: args[1] });
          return ui.line(result.ok ? 'Deleted.' : result.error);
        }
        const id = args[0] === 'load' ? args[1] : await ui.pick('Load which chat (number, Enter to cancel):',
          chats.slice(0, 20).map((chat) => ({ label: `${chat.title} ${ui.style.dim(`· ${chat.mode} · ${chat.id}`)}`, value: chat.id })));
        if (!id) return;
        const result = commands['history.load']({ id });
        if (!result.ok) return ui.line(result.error);
        ui.state.mode = result.chat.mode === 'chat' ? 'chat' : 'code';
        ui.line(`Loaded "${result.chat.title}" (${result.chat.conversation.length} messages).`);
      },
    },
  ];

  const byName = new Map(table.map((entry) => [entry.name, entry]));

  async function handle(input) {
    const parsed = parseSlash(input);
    if (!parsed) return false;
    const entry = byName.get(parsed.name);
    if (!entry) {
      ui.line(`Unknown command /${parsed.name}. Try /help.`);
      return true;
    }
    await entry.run(parsed);
    return true;
  }

  return { handle, table, names: () => table.map((entry) => `/${entry.name}`) };
}

module.exports = { createSlash, matchModels, onOff, parseSlash };
