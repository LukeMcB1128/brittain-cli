'use strict';

// Reading answers from the person at the terminal: a line, a line with echo
// off (keys), and a numbered pick. Works the same whether stdin is a TTY or a
// pipe, so the flows are testable by piping answers in.

const readline = require('node:readline');

function createPrompter({ input = process.stdin, output = process.stderr } = {}) {
  const terminal = !!(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output, terminal });
  let muted = false;
  // readline echoes typed characters through this method. Muting it is the
  // standard way to read a secret without a dependency.
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (text) => {
    if (!muted && write) write(text);
  };
  // Created up front so lines piped in before a question is asked are
  // buffered rather than lost; it reports done only once they are drained.
  const lines = rl[Symbol.asyncIterator]();

  async function nextLine() {
    const { value, done } = await lines.next();
    return done ? null : value;
  }

  return {
    terminal,

    async line(question, { defaultValue = '' } = {}) {
      output.write(question + (defaultValue ? ` [${defaultValue}]` : '') + ' ');
      const answer = await nextLine();
      if (answer === null) return null;
      return answer.trim() || defaultValue;
    },

    async hidden(question) {
      output.write(question + ' ');
      muted = true;
      try {
        const answer = await nextLine();
        return answer === null ? null : answer.trim();
      } finally {
        muted = false;
        if (terminal) output.write('\n');
      }
    },

    // items: [{ label, value }]. Accepts a number, or text that matches one
    // item's label exactly or as a unique substring. Enter keeps `current`.
    async pick(question, items, { current } = {}) {
      items.forEach((item, index) => {
        const marker = item.value === current ? '*' : ' ';
        output.write(`${marker} ${String(index + 1).padStart(2)}. ${item.label}\n`);
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await this.line(question);
        if (answer === null) return null;
        if (!answer) return current ?? null;
        const number = Number(answer);
        if (Number.isInteger(number) && number >= 1 && number <= items.length) return items[number - 1].value;
        const lower = answer.toLowerCase();
        const exact = items.find((item) => item.label.toLowerCase() === lower || String(item.value).toLowerCase() === lower);
        if (exact) return exact.value;
        const partial = items.filter((item) => item.label.toLowerCase().includes(lower));
        if (partial.length === 1) return partial[0].value;
        output.write(partial.length ? `"${answer}" matches ${partial.length} entries — be more specific.\n` : `No entry matches "${answer}".\n`);
      }
      return null;
    },

    close() {
      rl.close();
    },
  };
}

module.exports = { createPrompter };
