// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- memory viewer ----------"
'use strict';

// What the agent remembers and where it lives. The app revealed the file in
// Finder; the CLI returns the path so /memory can print it.
//
// Pruned: /workspace init and the memory move into .brittain/ (docs/PLAN.md §4.3):
// in-repo memory is used when .brittain/MEMORY.md already exists, and never
// created by the CLI.

const workspace = require('../lib/workspace');

function createMemory(rt) {
  function get(cwd) {
    const scope = cwd || rt.config.cwd;
    return {
      ok: true,
      content: rt.tools.readMemory(scope),
      path: rt.tools.memoryPath(scope),
      inRepo: workspace.hasWorkspace(scope),
      legacyContent: rt.tools.readLegacyMemory(),
      legacyPath: rt.tools.legacyMemoryPath(),
    };
  }

  return { get };
}

module.exports = { createMemory };
