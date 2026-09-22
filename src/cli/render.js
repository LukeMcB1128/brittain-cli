'use strict';

// Run events → terminal text (the contract is docs/events.md).
//
// Two ways to draw the answer:
//   live    (a TTY) tokens appear the moment they arrive; when a line
//           completes it is rewritten in place with Markdown styling, and
//           the reasoning stream is shown dimmed and then collapsed to one
//           line once the answer starts.
//   buffered (anything else) each line is written once, already styled, and
//           reasoning is reported only as its one-line summary. Deterministic,
//           which is what the snapshot tests rely on.
//
// Tool traffic reuses the transcript formatters from run-sink.js, so the REPL
// reads like the transcript a file target writes.

const { TRANSCRIPT_CHANNELS } = require('../lib/run-sink');
const { createMarkdownRenderer, createStyles } = require('./markdown');

const ESC = '\x1b[';

function createRenderer({ out, color = false, live = false, columns = () => 80 } = {}) {
  const style = createStyles(color);
  const md = createMarkdownRenderer({ color });
  const cols = () => Math.max(20, Number(columns()) || 80);

  let partial = '';        // the answer line still being written
  let atLineStart = true;  // is the cursor in column 0?
  let thinking = '';
  let thinkingRows = 0;    // rows the live reasoning stream occupies
  let thinkingCol = 0;
  const turn = { tokPerSec: 0, costText: '', sessionCostText: '' };
  const status = { contextTokens: 0, contextLength: 0 };

  const write = (text) => {
    if (!text) return;
    out.write(text);
    atLineStart = text.endsWith('\n');
  };
  const line = (text) => {
    if (!atLineStart) write('\n');
    write(`${text}\n`);
  };

  // Erase `rows` terminal rows ending at the cursor's row, leaving the
  // cursor at the start of the first one.
  function eraseRows(rows) {
    write('\r' + (rows > 1 ? `${ESC}${rows - 1}A` : '') + `${ESC}J`);
    atLineStart = true;
  }

  function trackThinking(text) {
    for (const ch of text) {
      if (ch === '\n') { thinkingRows += 1; thinkingCol = 0; continue; }
      thinkingCol += 1;
      if (thinkingCol > cols()) { thinkingRows += 1; thinkingCol = 1; }
    }
  }

  function collapseThinking() {
    if (!thinking) return;
    const chars = thinking.length;
    if (live) eraseRows(thinkingRows + 1);
    thinking = '';
    thinkingRows = 0;
    thinkingCol = 0;
    line(style.dim(`✻ Thought (${chars.toLocaleString()} chars)`));
  }

  function rowsFor(text) {
    return Math.max(1, Math.ceil(text.length / cols()));
  }

  function completeLine(raw) {
    const styled = md.renderLine(raw);
    if (live) {
      eraseRows(rowsFor(raw));
      write(`${styled}\n`);
    } else {
      line(styled);
    }
  }

  function onToken(text) {
    collapseThinking();
    const pieces = String(text).split('\n');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (live && piece) {
        if (!partial && !atLineStart) write('\n');
        write(piece);
      }
      partial += piece;
      if (i < pieces.length - 1) {
        completeLine(partial);
        partial = '';
      }
    }
  }

  // End of an assistant message (or anything that interrupts it): the last
  // line has no newline yet, so render it now.
  function flush() {
    collapseThinking();
    if (partial) {
      completeLine(partial);
      partial = '';
    }
    md.reset();
  }

  function discardPartial() {
    if (partial && live) eraseRows(rowsFor(partial));
    partial = '';
  }

  function handle(channel, payload) {
    switch (channel) {
      case 'stream:thinking':
        if (!thinking && live) {
          if (!atLineStart) write('\n');
        }
        thinking += String(payload);
        if (live) {
          write(style.dim(String(payload)));
          trackThinking(String(payload));
        }
        break;
      case 'stream:token':
        onToken(payload);
        break;
      case 'stream:cleancontent':
        // The raw tool-call markup the model typed is being replaced by a
        // real call; drop what is left of it.
        discardPartial();
        break;
      case 'stream:message':
        flush();
        break;
      case 'stream:toolcall':
      case 'stream:toolresult': {
        flush();
        const text = TRANSCRIPT_CHANNELS.get(channel)(payload);
        const denied = channel === 'stream:toolresult' && payload?.denied;
        line(denied ? style.red(text) : style.dim(text));
        break;
      }
      case 'stream:info':
        flush();
        line(style.yellow(`! ${payload}`));
        break;
      case 'stream:state':
        if (payload && payload !== 'starting') {
          flush();
          line(style.dim(`· ${payload}`));
        }
        break;
      case 'stream:stats':
        if (payload?.scope === 'conversation') {
          status.contextTokens = payload.contextTokens || 0;
          status.contextLength = payload.contextLength || status.contextLength;
        } else if (payload?.tokPerSec) {
          turn.tokPerSec = payload.tokPerSec;
        }
        break;
      case 'stream:cost':
        turn.costText = payload?.cost === null || payload?.cost === undefined ? '' : String(payload.text || '').split(' · ')[0];
        turn.sessionCostText = payload?.sessionText || '';
        break;
      case 'stream:done':
        flush();
        if (payload && !payload.ok && payload.error) line(style.red(`✗ ${payload.error}`));
        if (payload?.stopped) line(style.yellow('Stopped.'));
        break;
      default:
        break;
    }
  }

  // One dim line after each turn: tokens, speed, and cost when known.
  function endTurn({ promptTokens = 0, evalTokens = 0 } = {}) {
    flush();
    const parts = [];
    if (promptTokens || evalTokens) parts.push(`${promptTokens.toLocaleString()} in · ${evalTokens.toLocaleString()} out`);
    if (turn.tokPerSec) parts.push(`${turn.tokPerSec.toFixed(1)} tok/s`);
    if (turn.costText) parts.push(turn.costText);
    if (parts.length) line(style.dim(`  ${parts.join(' · ')}`));
    turn.tokPerSec = 0;
    turn.costText = '';
  }

  function contextPercent() {
    return status.contextLength ? Math.round((status.contextTokens / status.contextLength) * 100) : 0;
  }

  return {
    handle,
    flush,
    endTurn,
    line,
    write,
    style,
    contextPercent,
    setContext: ({ tokens, limit }) => { status.contextTokens = tokens || 0; status.contextLength = limit || 0; },
    atLineStart: () => atLineStart,
  };
}

module.exports = { createRenderer };
