// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/autonomy.js
'use strict';

// How much a run may do without being asked.
//
// This replaces a boolean. AUTO-APPROVE was either "prompt for everything" or
// "prompt for nothing", which is the wrong shape for two reasons: most runs
// want something in between, and a run with nobody watching cannot be served by
// either setting — one hangs forever waiting for a click, the other waives
// every check precisely when no one is there to catch a mistake.
//
// A verdict is one of:
//   allow   run it
//   ask     put it to the human (only meaningful when someone is watching)
//   deny    refuse outright and tell the model not to retry
//
// Pruned for the CLI: custom policies (autonomy.json), the guarded policy,
// extra roots, project narrowing, preconditions, sandboxing, network and MCP
// verdicts, and park/defer. With nobody watching (print mode) an 'ask' becomes
// 'deny' rather than being parked — there is no review tray to hold it in.
//
// The invariants below hold whatever a policy says. They are the actual
// security design; everything else is configuration.

const BUILT_IN = {
  supervised: {
    label: 'Supervised',
    description: 'Approve every risky tool call. Nothing touches the project unattended.',
    allowRisky: false,
  },
  trusted: {
    label: 'Trusted',
    description: 'Ordinary risky tools run unattended. Destructive and sensitive tools still ask.',
    allowRisky: true,
  },
};

// A null policy is a realistic state, not a programming error. Falling back to
// an empty object means such a run supervises everything, which is the safe
// direction to fail in.
function normalizePolicy(rawPolicy) {
  const policy = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  return {
    label: String(policy.label || ''),
    description: String(policy.description || ''),
    allowRisky: !!policy.allowRisky,
  };
}

// An 'ask' with nobody there is not an approval — it is a hang.
function resolveAsk(attended) {
  return attended ? 'ask' : 'deny';
}

function decide(rawPolicy, call = {}) {
  const policy = normalizePolicy(rawPolicy);
  const {
    attended = true,
    risky = false,
    sensitive = false,
    destructive = false,
    financial = false,
  } = call;

  // --- invariants: no policy may waive these ---

  // Moving money out is the one action where "agreed at launch" and "approved
  // this specific transaction" are genuinely different consents. No policy,
  // however permissive, turns it into an automatic 'allow'.
  if (financial) {
    return { verdict: resolveAsk(attended), reason: 'a financial transaction always needs approval at the moment it happens' };
  }

  // Losing a day's work unsupervised is not a trade worth making.
  if (destructive) {
    return { verdict: resolveAsk(attended), reason: 'destructive operations are never automatic' };
  }

  // Credentials and keys leaving the machine is the worst available outcome.
  if (sensitive) {
    return { verdict: resolveAsk(attended), reason: 'sensitive reads are never automatic' };
  }

  // --- ordinary tools ---

  if (!risky) return { verdict: 'allow', reason: 'not a risky tool' };
  if (policy.allowRisky) return { verdict: 'allow', reason: 'policy permits risky tools' };
  return { verdict: resolveAsk(attended), reason: 'risky tool needs approval' };
}

function getPolicy(id) {
  return BUILT_IN[id] || null;
}

// AUTO-APPROVE checked meant "run risky tools without asking", which is exactly
// Trusted. Unchecked is Supervised.
function policyForLegacyAutoApprove(autoApprove) {
  return autoApprove ? 'trusted' : 'supervised';
}

module.exports = {
  BUILT_IN,
  decide,
  getPolicy,
  normalizePolicy,
  policyForLegacyAutoApprove,
};
