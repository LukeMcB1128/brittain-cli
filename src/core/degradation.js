// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- live psychosis detector ----------" (+ scanThinkingForPsychosis from "---------- deliberation loops ----------")
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

// Reasoning traces legitimately say things like "Wait, let me reconsider" —
// that's normal chain-of-thought, not psychosis. Only glitch tokens (mojibake
// is mojibake regardless of channel) are checked for corruption in `thinking`;
// self-talk and verbatim repetition stay scoped to the final answer, matching
// how SELF_TALK is tuned (a comment-prefixed phrase leaking into code).
//
// Pruned: the deliberation-loop restart count and thinking-length budget
// (main.js "deliberation loops" is not in v1). The signature keeps the
// throttle state so the stream's call site is unchanged.
function scanThinkingForPsychosis(thinking, _thinkingState = { value: 0 }, _model = '') {
  const tail = thinking.slice(-300);
  if (RAW_CHANNEL_MARKER_RE.test(tail)) return { reason: 'raw model channel marker in reasoning', excerpt: tail.slice(-160), recovery: 'compact' };
  if (CONTEXT_RESET_RE.test(withoutQuotedSpans(tail))) return { reason: 'active task was lost from reasoning context', excerpt: tail.slice(-160), recovery: 'compact' };
  if (GLITCH_TOKEN_RE.test(tail)) return { reason: 'raw byte-fallback/replacement token in reasoning', excerpt: tail.slice(-120), recovery: 'compact' };
  if (GLITCH_FULLWIDTH_RE.test(tail)) return { reason: 'full-width punctuation in reasoning where ASCII was expected', excerpt: tail.slice(-120), recovery: 'compact' };
  return null;
}

module.exports = {
  PsychosisDetectedError,
  findRepeatedSubstring,
  scanContentForPsychosis,
  scanThinkingForPsychosis,
  withoutQuotedSpans,
};
