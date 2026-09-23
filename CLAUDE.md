# brittain-cli

Lightweight pure-Node CLI port of Brittain Code (the Electron app at
../brittain-code). v1 was built to docs/PLAN.md (milestones M0–M8, done);
read its §1 Rules before a change that touches scope, tools, or safety.

- Node >= 22, CommonJS, no build step, no TypeScript, zero runtime deps.
- Terminal UI is node:readline + ANSI. No Ink/chalk/commander.
- Scope is docs/PLAN.md §0. Anything under "Not in v1" is out — ask, don't add.
- Tool set is docs/PLAN.md §4.2. System prompt + tools must stay under the
  §4.1 token budget (enforced by test/core/budget.test.js).
- Three provider modes: brittain (default, endpoint never displayed), openai,
  ollama. See docs/PLAN.md §5.
- Code mode only; chat mode was removed (brittain.app covers chat).
- Ported files carry `// Ported from brittain-code@<sha>:<path>`; keep the
  source's comments, delete code for features not in v1. Changes made for the
  CLI are marked "CLI addition" with the reason — usually the session that
  showed the problem.
- src/core never writes to stdout and holds no module-global state.
- Safety invariants (destructive, sensitive, money → always a human) are never
  weakened by a mode, flag, or port.
- `npm test` passes before every commit. Tests never call a real model.
- One topic per branch and PR; the PR says what changed, why, and how it was
  tested.
- Never add a `Co-Authored-By` trailer to commits.

## Layout

- `bin/brittain.js` — entry point.
- `src/cli/` — the terminal: argument parsing, REPL, print mode, rendering,
  slash commands, first-run setup.
- `src/core/` — the runtime (`rt`): agent loop, approvals, compaction,
  history, prompts, commands. Talks to the outside only through the host and
  events (docs/events.md).
- `src/host/` — Node-specific host: data paths, keychain.
- `src/lib/` — ported, mostly pure modules: providers, tools, settings,
  stores, compaction and cost math.
- `test/` mirrors `src/`; `test/helpers/` has the fake provider and test host.
- `docs/` — the build plan and the event contract.
