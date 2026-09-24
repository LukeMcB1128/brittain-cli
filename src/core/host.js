'use strict';

// The seam between the core and whatever is running it (docs/PLAN.md §7.1). The
// core never touches the terminal, the keychain, or the filesystem layout
// directly; it asks the host.

/**
 * @typedef {Object} ApprovalRequest
 * @property {string} id
 * @property {string} name      tool name
 * @property {Object} args      tool arguments
 * @property {string} target    short description of what the call touches
 * @property {string} reason    why the policy is asking
 * @property {Object} kind      { destructive?, sensitive?, financial? }
 */

/**
 * @typedef {Object} QuestionRequest
 * @property {string} id
 * @property {{question: string, options: string[]}[]} questions
 */

/**
 * @typedef {Object} Host
 * @property {string} dataDir
 * @property {string} tempDir
 * @property {{get(name: string): string, set(name: string, value: string): {ok: boolean, encrypted: boolean}, has(name: string): boolean, remove(name: string): void}} secrets
 * @property {(req: ApprovalRequest) => Promise<boolean|'always'>} approve
 * @property {(q: QuestionRequest) => Promise<any[]|null>} ask
 * @property {() => boolean} interactive
 */

// Every field a Host must provide; createRuntime checks against this list.
const HOST_FIELDS = Object.freeze(['dataDir', 'tempDir', 'secrets', 'approve', 'ask', 'interactive']);

function assertHost(host) {
  const missing = HOST_FIELDS.filter((field) => host?.[field] === undefined);
  if (missing.length) throw new Error(`Host is missing: ${missing.join(', ')}`);
  return host;
}

module.exports = { HOST_FIELDS, assertHost };
