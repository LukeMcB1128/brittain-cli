# brittain-cli

Lightweight pure-Node CLI port of Brittain Code (the Electron app at
../brittain-code). The build plan is PLAN.md — read §1 Rules first, and work
only the milestone the human names.

- Node >= 22, CommonJS, no build step, no TypeScript, zero runtime deps.
- Terminal UI is node:readline + ANSI. No Ink/chalk/commander.
- v1 scope is PLAN.md §0. Anything under "Not in v1" is out — ask, don't add.
- Tool set is PLAN.md §4.2. System prompt + tools must stay under the §4.1
  token budget (enforced by test/core/budget.test.js).
- Three provider modes: brittain (default, endpoint never displayed), openai,
  ollama. See PLAN.md §5.
- Ported files carry `// Ported from brittain-code@<sha>:<path>`; keep the
  source's comments, delete code for features not in v1.
- src/core never writes to stdout and holds no module-global state.
- Safety invariants (destructive, sensitive, money → always a human) are never
  weakened by a mode, flag, or port.
- `npm test` passes before every commit. Tests never call a real model.
- One milestone per PR; the PR lists ported paths, pruned code, deviations,
  and acceptance results.
- Never add a `Co-Authored-By` trailer to commits.
