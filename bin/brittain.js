#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli/main');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (error) => {
    process.stderr.write(`brittain: ${error?.message || error}\n`);
    process.exitCode = 1;
  },
);
