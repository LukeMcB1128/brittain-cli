'use strict';

const { parseArgs } = require('node:util');
const pkg = require('../../package.json');

const HELP = `brittain ${pkg.version} — a lightweight terminal coding agent

Usage:
  brittain [options]            Start an interactive session in this directory
  brittain -p "<prompt>"        Run one prompt non-interactively

Options:
  -h, --help                    Show this help
  -v, --version                 Print the version
`;

function writeOut(out, text) {
  out.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    writeOut(stderr, `brittain: ${error.message}\nRun 'brittain --help' for usage.`);
    return 1;
  }
  const { values } = parsed;
  if (values.version) {
    writeOut(stdout, pkg.version);
    return 0;
  }
  writeOut(stdout, HELP);
  return 0;
}

module.exports = { main, HELP };
