// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/chat-title.js
'use strict';

const MAX_TITLE_WORDS = 7;
const MAX_MESSAGE_CHARS = 2_000;

const TITLE_SYSTEM_PROMPT = [
  'Create a clear title for this chat.',
  `Use no more than ${MAX_TITLE_WORDS} words.`,
  'Return plain text only. Do not add a label, explanation, Markdown, or hashtag.',
].join(' ');

function compactMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  // Pruned: attachment names (attachments are not in v1).
  const displayContent = String(message.displayContent || '').trim();
  const content = displayContent || String(message.content || '').trim();
  return { role: message.role, content: content.slice(0, MAX_MESSAGE_CHARS) };
}

function titleMessages(conversation) {
  const messages = (Array.isArray(conversation) ? conversation : [])
    .map(compactMessage)
    .filter(Boolean);
  if (messages.length <= 5) return messages;

  // The first request states the goal. Keep it even after a long tool loop.
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex] : null;
  const recent = messages.slice(-4);
  return firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
}

function normalizeGeneratedTitle(value) {
  const withoutThinking = String(value || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ').trim();
  let title = withoutThinking
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  title = title
    .replace(/^(?:chat\s+)?title\s*:\s*/i, '')
    .replace(/[#*`]/g, '')
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.split(/\s+/).slice(0, MAX_TITLE_WORDS).join(' ').slice(0, 100).trim();
  return /[\p{L}\p{N}]/u.test(title) ? title : '';
}

async function generateChatTitle({
  conversation,
  model,
  streamChat,
  thinkValue,
  effectiveContext,
  signal,
  timeoutMs = 20_000,
}) {
  if (!Array.isArray(conversation) || !conversation.length || !model) {
    return { ok: false, error: 'Invalid conversation content' };
  }

  try {
    const messages = titleMessages(conversation);
    if (!messages.length) return { ok: false, error: 'The conversation has no messages to name.' };
    // Naming a chat is extraction, not deliberation. The <think> stripping below
    // only catches a tagged trace; a server with no reasoning parser returns the
    // reasoning as ordinary prose, which would be indistinguishable from a title.
    const titleThink = await thinkValue(model, false);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await streamChat(
      model,
      [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(messages) },
      ],
      requestSignal,
      titleThink,
      true,
      Math.min(await effectiveContext(model), 8192),
      null,
      { toolCallRetries: 0 },
      0.2,
      32,
    );
    const title = normalizeGeneratedTitle(response?.content);
    const stats = response?.stats ? { stats: response.stats } : {};
    return title
      ? { ok: true, title, ...stats }
      : { ok: false, error: 'The model returned an empty title.', ...stats };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      ...(error?.name === 'AbortError' ? { aborted: true } : {}),
    };
  }
}

module.exports = {
  MAX_TITLE_WORDS,
  generateChatTitle,
  normalizeGeneratedTitle,
  titleMessages,
};
