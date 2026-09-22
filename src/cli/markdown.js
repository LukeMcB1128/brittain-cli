'use strict';

// Just enough Markdown for a terminal: headings, bold, inline code, fenced
// blocks, and lists. Rendered a line at a time, because answers arrive as a
// stream; the only state that crosses lines is whether we are inside a fence.

function createStyles(color) {
  const wrap = (open, close) => (text) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    italic: wrap('3', '23'),
    underline: wrap('4', '24'),
    cyan: wrap('36', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    red: wrap('31', '39'),
    magenta: wrap('35', '39'),
  };
}

// Inline spans. Code first, so ** inside backticks is left alone.
function renderInline(text, style) {
  const parts = String(text).split(/(`[^`\n]+`)/g);
  return parts.map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return style.cyan(part.slice(1, -1));
    return part
      .replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => style.bold(inner))
      .replace(/__([^_\n]+)__/g, (_, inner) => style.bold(inner));
  }).join('');
}

function createMarkdownRenderer({ color = false } = {}) {
  const style = createStyles(color);
  let fence = null;

  function renderLine(line) {
    const fenceMatch = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) {
        fence = null;
        return style.dim('  └─');
      }
      return style.dim('  │ ') + line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return style.dim(`  ┌─${fenceMatch[2] ? ` ${fenceMatch[2]}` : ''}`);
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = renderInline(heading[2], style);
      return heading[1].length <= 2 ? style.bold(style.underline(text)) : style.bold(text);
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) return `${bullet[1]}• ${renderInline(bullet[2], style)}`;
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) return `${numbered[1]}${numbered[2]}. ${renderInline(numbered[3], style)}`;
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) return style.dim('─'.repeat(20));
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return style.dim('│ ') + style.italic(renderInline(quote[1], style));
    return renderInline(line, style);
  }

  // Render a whole block (used for text that is already complete).
  function render(text) {
    return String(text).split('\n').map(renderLine).join('\n');
  }

  return {
    renderLine,
    render,
    reset: () => { fence = null; },
    inFence: () => !!fence,
  };
}

module.exports = { createMarkdownRenderer, createStyles, renderInline };
