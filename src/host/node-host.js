'use strict';

// The Host for a Node process (src/core/host.js). approve and ask default to
// "nobody is here" — deny and no answer — which is exactly right for print
// mode; the REPL passes its own.

const os = require('os');
const { dataDir: resolveDataDir, ensureDataDir } = require('./paths');
const { createSecrets } = require('./keychain');

function createNodeHost({
  env = process.env,
  approve = async () => false,
  ask = async () => null,
  interactive = () => false,
  keychain,
} = {}) {
  const dataDir = ensureDataDir(resolveDataDir(env));
  return {
    dataDir,
    tempDir: os.tmpdir(),
    secrets: createSecrets({ dataDir, env, keychain }),
    approve,
    ask,
    interactive,
  };
}

module.exports = { createNodeHost };
