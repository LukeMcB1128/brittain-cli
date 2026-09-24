// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/tools/policy.js
'use strict';

// Pruned to the v1 tool set (docs/PLAN.md §4.2), plus run_subagent and the
// subagent's read-only set (added after v1). The orchestrator and coder role
// sets, SUBMIT_IMPLEMENTATION_PLAN_TOOL, and the network tools are
// not ported, and neither is the chat-mode set (chat mode was removed). SENSITIVE_TOOLS and DESTRUCTIVE_TOOLS are empty in v1 — none of
// their members were ported — but stay as sets so the approval path keeps its
// shape: destructive shell commands and sensitive reads are still caught by
// classifying the call itself (see core/approvals.js).

const SENSITIVE_TOOLS = new Set([]);
const DESTRUCTIVE_TOOLS = new Set([]);

const RISKY_TOOLS = new Set([
  'write_file',
  'run_command',
  'delete_file',
  'move_file',
  'edit_file',
  'apply_patch',
]);

const CODE_TOOL_NAMES = new Set([
  'read_file', 'get_file_lines', 'browse_files', 'search_files',
  'project_outline', 'find_symbol',
  'write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file',
  'run_command', 'git_status', 'read_git_diff', 'get_git_log',
  'ask_user', 'run_subagent', 'remember',
]);

// What a subagent may call: reading and searching, never writing, running,
// asking, or delegating further. The source's set, less the tools v1 dropped.
const SUBAGENT_TOOL_NAMES = new Set([
  'read_file', 'browse_files', 'search_files',
  'project_outline', 'find_symbol',
  'get_file_lines',
  'git_status', 'get_git_log', 'read_git_diff',
]);

function selectTools(toolDefinitions, names) {
  return toolDefinitions.filter((definition) => names.has(definition.function.name));
}

function createToolPolicy(toolDefinitions) {
  return {
    SENSITIVE_TOOLS,
    DESTRUCTIVE_TOOLS,
    RISKY_TOOLS,
    CODE_TOOL_NAMES,
    CODE_TOOLS: selectTools(toolDefinitions, CODE_TOOL_NAMES),
    SUBAGENT_TOOL_NAMES,
    SUBAGENT_TOOLS: selectTools(toolDefinitions, SUBAGENT_TOOL_NAMES),
  };
}

module.exports = {
  CODE_TOOL_NAMES,
  DESTRUCTIVE_TOOLS,
  RISKY_TOOLS,
  SENSITIVE_TOOLS,
  SUBAGENT_TOOL_NAMES,
  createToolPolicy,
};
