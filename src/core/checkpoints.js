// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- run checkpoints (Tier 1 safety) ----------"
'use strict';

// Before every code-mode run, snapshot the working tree (tracked + untracked)
// into a hidden ref under refs/brittain/checkpoints/ — using a TEMPORARY index
// so the user's real index, branch, and commit history are never touched.
// /undo restores the tree to the snapshot even if the user never committed.

const { createCheckpointService } = require('../lib/checkpoint-service');
const { gitRun } = require('../lib/tools');

function createCheckpoints(rt) {
  rt.checkpointState = { available: false, cwd: '' };
  return createCheckpointService({
    gitRun,
    // app.getPath('temp') → the host's temp dir (os.tmpdir()).
    getTempDirectory: () => rt.host.tempDir,
    // The window showed an UNDO RUN button from this; the CLI keeps the state
    // for /undo to consult.
    publishState: (state) => { rt.checkpointState = state; },
  });
}

module.exports = { createCheckpoints };
