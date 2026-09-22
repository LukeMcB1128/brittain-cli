// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:settings.js
'use strict';

// Pruned: jev*, coderModel, scoutModel, coder/scout context caps,
// compactionEngine, toolIndex, sidebarOpen, and the settings that only served
// deferred features — autonomyPolicy (custom policies), autoBranch, reviewMode,
// mcpAutoApprove, onlineAutoApprove, defaultLoopIterations, and lastModel (the
// daemon/bridge fallback).
//
// Replaced: the single inferenceEndpoint/provider pair and per-mode model
// fields with one record per provider mode (PLAN.md §5.1), so switching modes
// never loses a configuration. The Brittain mode's endpoint is never stored
// here — see src/lib/providers/brittain.js.

const fs = require('fs');
const path = require('path');

const PROVIDER_MODES = Object.freeze(['brittain', 'openai', 'ollama']);

const DEFAULT_PROVIDERS = Object.freeze({
  brittain: Object.freeze({ model: 'brittain-4' }),
  openai: Object.freeze({ endpoint: '', model: '' }),
  ollama: Object.freeze({ endpoint: 'http://127.0.0.1:11434', model: '' }),
});

const DEFAULT_SETTINGS = Object.freeze({
  // Which provider mode is active. First run starts in brittain mode.
  //
  // Chosen rather than sniffed: this decides whether a conversation leaves the
  // machine, which is not a question to answer by guessing at a URL.
  provider: 'brittain',
  providers: DEFAULT_PROVIDERS,
  mainContextCap: 0,
  autoCompact: true,
  compactThreshold: 0.7,
  keepAlive: '5m',
  codeTemperature: 0.3,
  chatTemperature: 0.6,
  defaultMode: 'code',
  codeThink: false,
  chatThink: false,
  autoApprove: false,
  globalCodeInstructions: '',
  globalChatInstructions: '',
  maxAgentSteps: 50,
});

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

// A base URL, which for a cloud provider includes a path.
//
// This originally allowed only an origin, because Ollama's endpoint is a host
// and a port and the client appends /api/chat itself. Every OpenAI-compatible
// provider documents a base that carries a path — https://openrouter.ai/api/v1,
// https://api.z.ai/api/paas/v4 — so refusing paths made those endpoints
// impossible to enter at all.
//
// What stays refused is anything that is not addressing: credentials, a query
// string, a fragment. Those are either a mistake or a key about to be stored in
// the wrong place.
function normalizeEndpoint(value, fallback = DEFAULT_PROVIDERS.ollama.endpoint) {
  const raw = String(value || fallback).trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Inference endpoint must be a valid http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Inference endpoint must use http:// or https://.');
  if (parsed.username || parsed.password) throw new Error('Put no credentials in the inference endpoint URL.');
  if (!parsed.hostname) throw new Error('Inference endpoint needs a hostname.');
  if (parsed.search || parsed.hash) {
    throw new Error('Inference endpoint takes a base URL only — no query string or fragment.');
  }
  // A trailing slash is dropped so the transports can append their own path
  // without producing a doubled separator.
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + pathname;
}

function normalizeContextCap(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return number === 0 ? 0 : fallback;
  return clampInteger(number, fallback, 2_048, 1_048_576);
}

// A stored endpoint that no longer parses is dropped back to the default
// rather than failing the whole load: one bad field must not cost the user
// every other setting.
function safeEndpoint(value, fallback) {
  if (!value) return fallback;
  try { return normalizeEndpoint(value, fallback); } catch { return fallback; }
}

function normalizeProviders(input) {
  const given = input && typeof input === 'object' ? input : {};
  const pick = (mode) => (given[mode] && typeof given[mode] === 'object' ? given[mode] : {});
  const brittain = pick('brittain');
  const openai = pick('openai');
  const ollama = pick('ollama');
  return {
    // Deliberately no endpoint field: whatever was passed in is discarded.
    brittain: { model: cleanText(brittain.model, 200) || DEFAULT_PROVIDERS.brittain.model },
    openai: {
      endpoint: safeEndpoint(openai.endpoint, ''),
      model: cleanText(openai.model, 200),
    },
    ollama: {
      endpoint: safeEndpoint(ollama.endpoint, DEFAULT_PROVIDERS.ollama.endpoint),
      model: cleanText(ollama.model, 200),
    },
  };
}

function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
  return {
    provider: PROVIDER_MODES.includes(merged.provider) ? merged.provider : DEFAULT_SETTINGS.provider,
    providers: normalizeProviders(merged.providers),
    mainContextCap: normalizeContextCap(merged.mainContextCap, DEFAULT_SETTINGS.mainContextCap),
    autoCompact: !!merged.autoCompact,
    compactThreshold: clampNumber(merged.compactThreshold, DEFAULT_SETTINGS.compactThreshold, 0.5, 0.9),
    keepAlive: ['0', '5m', '30m', '-1'].includes(String(merged.keepAlive)) ? String(merged.keepAlive) : DEFAULT_SETTINGS.keepAlive,
    codeTemperature: clampNumber(merged.codeTemperature, DEFAULT_SETTINGS.codeTemperature, 0, 1.5),
    chatTemperature: clampNumber(merged.chatTemperature, DEFAULT_SETTINGS.chatTemperature, 0, 1.5),
    defaultMode: ['code', 'chat'].includes(merged.defaultMode) ? merged.defaultMode : DEFAULT_SETTINGS.defaultMode,
    codeThink: !!merged.codeThink,
    chatThink: !!merged.chatThink,
    autoApprove: !!merged.autoApprove,
    globalCodeInstructions: cleanText(merged.globalCodeInstructions, 12_000),
    globalChatInstructions: cleanText(merged.globalChatInstructions, 12_000),
    maxAgentSteps: clampInteger(merged.maxAgentSteps, DEFAULT_SETTINGS.maxAgentSteps, 5, 100),
  };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function settingsExist(userDataDir) {
  return fs.existsSync(settingsPath(userDataDir));
}

function loadSettings(userDataDir) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(userDataDir), 'utf8')));
  } catch {
    return normalizeSettings({});
  }
}

function saveSettings(userDataDir, value) {
  const normalized = normalizeSettings(value);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const target = settingsPath(userDataDir);
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
  return normalized;
}

module.exports = {
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  PROVIDER_MODES,
  normalizeEndpoint,
  normalizeSettings,
  loadSettings,
  saveSettings,
  settingsExist,
  settingsPath,
};
