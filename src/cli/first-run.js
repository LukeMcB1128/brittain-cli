'use strict';

// Provider setup (docs/PLAN.md §5.1). The Brittain mode needs nothing — the first
// message just works. The other two are walked through the first time they
// are chosen: OpenAI-compatible asks for an endpoint, then a key with echo
// off, then lists the models and asks for one; Ollama pings the server and
// lists what is installed.

const { loadSettings, saveSettings, settingsExist, normalizeEndpoint } = require('../lib/settings');
const { MODES } = require('../lib/providers');

// Absent settings.json means first run: write the defaults, which start in
// brittain mode.
function ensureSettings(dataDir) {
  if (!settingsExist(dataDir)) return saveSettings(dataDir, loadSettings(dataDir));
  return loadSettings(dataDir);
}

const SUGGESTED_OPENAI_ENDPOINT = 'https://openrouter.ai/api/v1';

async function chooseModel({ prompter, out, listed, current }) {
  if (!listed.models.length) {
    out(`No models are available.`);
    return null;
  }
  let models = listed.models;
  // A cloud catalog can list hundreds of models. Filter before numbering.
  if (models.length > 30) {
    const filter = await prompter.line(`${models.length} models available. Filter by name (Enter to list all):`);
    if (filter === null) return null;
    if (filter) {
      const lower = filter.toLowerCase();
      const matches = models.filter((id) => id.toLowerCase().includes(lower));
      if (matches.length) models = matches;
      else out(`Nothing matches "${filter}"; listing all.`);
    }
  }
  return prompter.pick('Model number or name:', models.map((id) => ({ label: id, value: id })), { current });
}

// Returns the saved settings, or null if the person backed out. `persist`
// false still configures the mode's record but leaves the active provider as
// it was (for --provider, which does not persist the switch).
async function setupProvider(mode, { dataDir, providers, secrets, prompter, out, persist = true }) {
  let settings = loadSettings(dataDir);
  const save = (next) => { settings = saveSettings(dataDir, next); return settings; };

  if (mode === 'openai') {
    let endpoint = settings.providers.openai.endpoint;
    if (!endpoint) {
      if (!prompter) { out('No endpoint configured for OpenAI-compatible mode. Run `brittain provider openai` in a terminal.'); return null; }
      const answer = await prompter.line('Base URL (OpenRouter, Z.AI, Groq, DeepSeek, vLLM…):', { defaultValue: SUGGESTED_OPENAI_ENDPOINT });
      if (answer === null) return null;
      try { endpoint = normalizeEndpoint(answer); } catch (err) { out(err.message); return null; }
      save({ ...settings, providers: { ...settings.providers, openai: { ...settings.providers.openai, endpoint } } });
    }
    if (!secrets.has(MODES.openai.keyName) && prompter) {
      const key = await prompter.hidden('API key (input hidden, Enter to skip):');
      if (key === null) return null;
      if (key) {
        const saved = secrets.set(MODES.openai.keyName, key);
        if (saved.warning) out(saved.warning);
      }
    }
  }

  if (mode !== 'brittain') {
    const listed = await providers.listModels(mode);
    if (!listed.ok) {
      out(listed.error);
    } else if (prompter && (!settings.providers[mode].model || !listed.models.includes(settings.providers[mode].model))) {
      const model = await chooseModel({ prompter, out, listed, current: settings.providers[mode].model });
      if (model) save({ ...settings, providers: { ...settings.providers, [mode]: { ...settings.providers[mode], model } } });
    }
  }

  if (persist && settings.provider !== mode) save({ ...settings, provider: mode });
  return settings;
}

module.exports = { ensureSettings, setupProvider, SUGGESTED_OPENAI_ENDPOINT };
