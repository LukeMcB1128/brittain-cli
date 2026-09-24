// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- live psychosis detector ----------" (+ "---------- deliberation loops ----------")
'use strict';

const { SELF_TALK } = require('../lib/tools/files');

// Catches the exact failure signatures from fablereview.md WHILE the model is
// still generating, instead of discovering them after the fact in a written
// file. On a hit, the in-flight generation is cancelled immediately; the
// caller (runAgentTurn) gets one chance to recover via compaction — the same
// "sanity reset" this session proved works after the fact — before giving up
// honestly. Runs inside streamChat itself, so every caller (main agent,
// subagent, verifier, coder) is protected with no per-call-site changes.
class PsychosisDetectedError extends Error {
  // recovery: 'compact'  — context is degraded; a sanity reset helps (glitch
  //                        tokens, self-talk leaking into files, repetition).
  // recovery: 'directive' — context is FINE, the model is dithering. Compaction
  //                        does nothing here; it needs an instruction to commit.
  constructor(reason, excerpt, recovery = 'compact') {
    super(reason);
    this.name = 'PsychosisDetectedError';
    this.excerpt = excerpt;
    this.recovery = recovery;
  }
}

const GLITCH_TOKEN_RE = /<0x[0-9A-Fa-f]{2}>|\uFFFD/;
const GLITCH_FULLWIDTH_RE = /[A-Za-z0-9_$][\uFF0E]|[\uFF0E][A-Za-z0-9_$(]/;
const RAW_CHANNEL_MARKER_RE = /<\|(?:channel|start|end|assistant|user|system)\b[^>\n]*>?/i;
const CONTEXT_RESET_RE = /\b(?:the user (?:has not|hasn't) (?:provided|asked|given) (?:anything|(?:a |any )?(?:specific )?(?:task|question|instructions?))|i should wait for (?:the user's )?(?:instructions|request))\b/i;

// Cheap, bounded repetition scan: only runs every 400 new chars, only over the
// tail, and strides through it rather than checking every offset — a
// degenerate model repeats large chunks verbatim, so a stride of 8 still
// reliably lands inside a repeat without costing O(n) per character.
function findRepeatedSubstring(tail, len = 40, minRepeats = 3) {
  if (tail.length < len * minRepeats) return null;
  const seen = new Map();
  for (let i = 0; i + len <= tail.length; i += 8) {
    const chunk = tail.slice(i, i + len);
    if (/^\s*$/.test(chunk)) continue;
    const count = (seen.get(chunk) || 0) + 1;
    seen.set(chunk, count);
    if (count >= minRepeats) return chunk;
  }
  return null;
}

// Blank out anything the model is quoting rather than saying.
//
// These patterns detect a model asserting something — that it has lost the
// task, that it is talking to itself. Asked to explain this file, a model
// quotes the very phrases the detector looks for, and the guard fires on its
// own documentation. It really happened: describing "Context loss (\"the user
// hasn't asked anything\")" killed the generation mid-sentence.
//
// A trailing unterminated quote counts as open, because a stream cut mid-quote
// is exactly the case that produced the false positive.
function withoutQuotedSpans(text) {
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/\u201C[^\u201D\n]*\u201D/g, ' ');
  const opener = Math.max(out.lastIndexOf('"'), out.lastIndexOf('`'), out.lastIndexOf('\u201C'));
  if (opener >= 0) out = out.slice(0, opener);
  return out;
}

function scanContentForPsychosis(content, repetitionState) {
  const tail = content.slice(-600);
  // Quoted text is discussed, not asserted. Corruption checks below still run
  // on the raw tail: a replacement character is broken output wherever it sits.
  const spoken = withoutQuotedSpans(tail);
  if (RAW_CHANNEL_MARKER_RE.test(spoken)) return { reason: 'raw model channel marker in output', excerpt: tail.slice(-160), recovery: 'compact' };
  if (CONTEXT_RESET_RE.test(spoken)) return { reason: 'active task was lost from context', excerpt: tail.slice(-160), recovery: 'compact' };
  if (GLITCH_TOKEN_RE.test(tail)) return { reason: 'raw byte-fallback/replacement token in output', excerpt: tail.slice(-120) };
  if (GLITCH_FULLWIDTH_RE.test(tail)) return { reason: 'full-width punctuation where ASCII code was expected', excerpt: tail.slice(-120) };
  if (SELF_TALK.test(spoken)) return { reason: 'conversational self-talk leaking into generated content', excerpt: tail.slice(-160) };
  if (content.length - repetitionState.value >= 400) {
    repetitionState.value = content.length;
    const repeat = findRepeatedSubstring(tail);
    if (repeat) return { reason: 'repetition loop detected', excerpt: repeat.slice(0, 80) };
  }
  return null;
}

// ---------- deliberation loops ----------
// A model can be perfectly coherent and still be stuck: re-deciding the same
// approach over and over, planning without ever calling a tool, until it runs
// out of budget mid-sentence. Observed live at 31 restart phrases / 0 tool
// calls / 0 lines written. That is NOT context degradation, so compaction is
// the wrong medicine — it needs an instruction to commit and act.
//
// One "wait, let me reconsider" is healthy chain-of-thought. Six is a loop.
const DELIBERATION_RESTART_RE = /(?:let me (?:write|do|start|plan|create|just|first)|(?:actually|wait),?\s+(?:let me|i realize|i should|i'll)|let me reconsider|think about this differently|be more (?:strategic|careful)|let me take a (?:different|step))/gi;
const DELIBERATION_MAX_RESTARTS = 6;
// Generous backstop for genuine deep reasoning; only catches true runaway.
const THINKING_BUDGET_CHARS = 12_000;
const CLOUD_THINKING_BUDGET_CHARS = 100_000;
// CLI addition: restarts are counted in the newest stretch of the trace, not
// the whole of it. The source counted the whole trace and so had to switch the
// check off for long-reasoning models — which is every model in brittain mode.
// Six restarts in ~1,000 tokens is a loop at any trace length.
const DELIBERATION_WINDOW_CHARS = 4_000;
// CLI addition: a trace that states the same sentence word for word three
// times in that window is going round in circles. Long enough that a repeated
// short line ("Let me check.") is not a hit.
const THINKING_REPEAT_MIN_CHARS = 50;
const THINKING_REPEAT_TIMES = 3;
const THINKING_SCAN_INTERVAL = 500;

// Large local models and current reasoning-first model families can produce a
// long, coherent thinking trace before their first tool call. Give them the
// same wide ceiling as cloud reasoning models. The short budget remains useful
// for smaller local models, where a long trace is much more often a real loop.
// CLI: brittain mode is a cloud reasoning model too.
function usesExtendedReasoningBudget(model = '', provider = '') {
  if (provider === 'openai' || provider === 'brittain') return true;
  const name = String(model).toLowerCase();
  if (/\bqwen3\.(?:[5-9]|\d{2,})\b/.test(name)) return true;
  const sizes = [...name.matchAll(/(?:^|[:_\/-])(\d+(?:\.\d+)?)b(?=$|[-_])/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return sizes.some((size) => size >= 20);
}

// CLI addition: a trace cannot usefully be longer than about half the window
// (4 chars a token, so 2 chars per token of window) — past that the answer has
// no room left, whatever the model's family.
function thinkingBudget({ model, provider, contextLength } = {}) {
  const budget = usesExtendedReasoningBudget(model, provider) ? CLOUD_THINKING_BUDGET_CHARS : THINKING_BUDGET_CHARS;
  return contextLength > 0 ? Math.min(budget, Math.max(THINKING_BUDGET_CHARS, contextLength * 2)) : budget;
}

// Sentence-level rather than findRepeatedSubstring's strided chunks: a loop
// in reasoning re-states whole sentences a few times, and a stride only lines
// up with a repeat after many more cycles than that.
function findRepeatedSentence(text, minChars = THINKING_REPEAT_MIN_CHARS, times = THINKING_REPEAT_TIMES) {
  const counts = new Map();
  for (const raw of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (sentence.length < minChars) continue;
    const count = (counts.get(sentence) || 0) + 1;
    counts.set(sentence, count);
    if (count >= times) return raw.trim();
  }
  return null;
}

function countDeliberationRestarts(thinking) {
  DELIBERATION_RESTART_RE.lastIndex = 0;
  return (thinking.match(DELIBERATION_RESTART_RE) || []).length;
}

// Reasoning traces legitimately say things like "Wait, let me reconsider" —
// that's normal chain-of-thought, not psychosis. Only glitch tokens (mojibake
// is mojibake regardless of channel) are checked for corruption in `thinking`;
// self-talk stays scoped to the final answer, matching how SELF_TALK is tuned
// (a comment-prefixed phrase leaking into code). Deliberation loops are the
// exception: they only exist in the thinking channel.
//
// `options` is { model, provider, contextLength } (the source read the provider
// from a global).
function scanThinkingForPsychosis(thinking, thinkingState = { value: 0 }, options = {}) {
  const tail = thinking.slice(-300);
  if (RAW_CHANNEL_MARKER_RE.test(tail)) return { reason: 'raw model channel marker in reasoning', excerpt: tail.slice(-160), recovery: 'compact' };
  if (CONTEXT_RESET_RE.test(withoutQuotedSpans(tail))) return { reason: 'active task was lost from reasoning context', excerpt: tail.slice(-160), recovery: 'compact' };
  if (GLITCH_TOKEN_RE.test(tail)) return { reason: 'raw byte-fallback/replacement token in reasoning', excerpt: tail.slice(-120), recovery: 'compact' };
  if (GLITCH_FULLWIDTH_RE.test(tail)) return { reason: 'full-width punctuation in reasoning where ASCII was expected', excerpt: tail.slice(-120), recovery: 'compact' };

  // The checks below are throttled: re-scanning a growing string on every
  // token would be O(n) per chunk.
  if (thinking.length - thinkingState.value >= THINKING_SCAN_INTERVAL) {
    thinkingState.value = thinking.length;
    const recent = thinking.slice(-DELIBERATION_WINDOW_CHARS);
    const restarts = countDeliberationRestarts(recent);
    if (restarts >= DELIBERATION_MAX_RESTARTS) {
      return {
        reason: `deliberation loop — ${restarts} restarts ("let me…", "actually, let me…") without acting`,
        excerpt: tail.slice(-160),
        recovery: 'directive',
      };
    }
    const repeat = findRepeatedSentence(recent);
    if (repeat) {
      return { reason: 'reasoning is repeating itself word for word', excerpt: repeat.slice(0, 100), recovery: 'directive' };
    }
    const budget = thinkingBudget(options);
    if (thinking.length >= budget) {
      return {
        reason: `reasoning exceeded ${budget.toLocaleString()} chars without producing a tool call or answer`,
        excerpt: tail.slice(-160),
        recovery: 'directive',
      };
    }
  }
  return null;
}

module.exports = {
  PsychosisDetectedError,
  countDeliberationRestarts,
  findRepeatedSentence,
  thinkingBudget,
  findRepeatedSubstring,
  scanContentForPsychosis,
  scanThinkingForPsychosis,
  withoutQuotedSpans,
};
