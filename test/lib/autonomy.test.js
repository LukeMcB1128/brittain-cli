// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/autonomy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decide, getPolicy,
  policyForLegacyAutoApprove, BUILT_IN,
} = require('../../src/lib/autonomy');

const verdict = (policyId, call) => decide(getPolicy(policyId), call).verdict;

test('supervised asks before every risky call, exactly as AUTO-APPROVE off did', () => {
  assert.equal(verdict('supervised', { name: 'write_file', risky: true }), 'ask');
  assert.equal(verdict('supervised', { name: 'run_command', risky: true }), 'ask');
  assert.equal(verdict('supervised', { name: 'read_file', risky: false }), 'allow');
});

test('trusted runs ordinary risky tools unattended, as AUTO-APPROVE on did', () => {
  assert.equal(verdict('trusted', { name: 'write_file', risky: true }), 'allow');
  assert.equal(verdict('trusted', { name: 'run_command', risky: true }), 'allow');
});


test('the legacy checkbox maps onto the two stops that preserve its behaviour', () => {
  assert.equal(policyForLegacyAutoApprove(true), 'trusted');
  assert.equal(policyForLegacyAutoApprove(false), 'supervised');
});

// --- the invariants: no policy may waive these ---

const permissive = { allow: ['*'], allowRisky: true, network: true, writeScope: 'project' };

test('no policy can make a destructive operation automatic', () => {
  assert.equal(decide(permissive, { name: 'revert_to_last_commit', destructive: true }).verdict, 'ask');
  // Unattended there is nobody to ask, and the CLI has no review tray to park
  // it in, so an invariant call is denied — never run, and never a hang.
  assert.equal(decide(permissive, { name: 'revert_to_last_commit', destructive: true, attended: false }).verdict, 'deny');
});


test('no policy can make a sensitive read automatic', () => {
  assert.equal(decide(permissive, { name: 'read_file', sensitive: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'get_environment_variables', sensitive: true, attended: false }).verdict, 'deny');
});


// --- unattended behaviour ---







// --- preconditions ---





test('every built-in policy carries a label and a description for the dial', () => {
  for (const [id, policy] of Object.entries(BUILT_IN)) {
    assert.ok(policy.label, `${id} needs a label`);
    assert.ok(policy.description, `${id} needs a description`);
  }
});

test('a malformed policy is treated conservatively rather than permissively', () => {
  assert.equal(decide(null, { name: 'write_file', risky: true }).verdict, 'ask');
  assert.equal(decide({}, { name: 'write_file', risky: true, attended: false }).verdict, 'deny');
  assert.equal(decide({ allow: null, deny: null }, { name: 'write_file', risky: true }).verdict, 'ask');
});



// --- the financial fence: bounded-B's one carve-out ---

const autonomous = { allow: ['*'], allowRisky: true, network: true, writeScope: 'project', maxToolCalls: 300 };

test('no policy, however permissive, makes a money-moving call automatic', () => {
  assert.equal(decide(autonomous, { name: 'run_command', financial: true, risky: true }).verdict, 'ask');
  assert.equal(decide(autonomous, { name: 'run_command', financial: true, risky: true, attended: false }).verdict, 'deny');
});


test('an ordinary call under the same policy still runs unattended', () => {
  assert.equal(decide(autonomous, { name: 'write_file', risky: true, attended: false }).verdict, 'allow');
  assert.equal(decide(autonomous, { name: 'run_command', risky: true, attended: false }).verdict, 'allow');
});



// --- park: the third unattended outcome ---



// --- auto-approving online requests ---

const onlineCall = (extra = {}) => ({ name: 'web_search', network: true, onlineResearch: true, ...extra });








