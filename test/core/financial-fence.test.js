// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/financial-fence.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { looksFinancial: classify, classifyToolCall } = require('../../src/core/approvals');

// The source lifted FINANCIAL_PATTERNS out of main.js by text; the port
// exports the classifier directly.
function financialMatcher() {
  return (args) => classify('run_command', args);
}

test('genuine money-moving calls are flagged', () => {
  const looksFinancial = financialMatcher();
  for (const args of [
    { url: 'https://api.stripe.com/v1/charges' },
    { command: 'curl -X POST https://api.stripe.com/v1/payment_intents -d amount=4000' },
    { url: 'https://shop.example.com/checkout/sessions' },
    { command: 'place the order for the laptop stand' },
    { command: 'confirm and pay' },
    { command: 'send 0.5 eth to wallet 0xabc123' },
  ]) {
    assert.equal(looksFinancial(args), true, `should flag: ${JSON.stringify(args)}`);
  }
});

test('ordinary coding calls are not flagged, so the agent stays usable', () => {
  const looksFinancial = financialMatcher();
  for (const args of [
    { command: 'npm run build' },
    { command: 'git log --oneline' },
    { path: 'src/order.js' },
    { command: 'grep -n payment tools.js' },
    { url: 'https://api.github.com/repos/x/y/orders' },
    { path: 'test/billing/invoice.test.js' },
    { command: 'node scripts/run-tests.js' },
  ]) {
    assert.equal(looksFinancial(args), false, `should not flag: ${JSON.stringify(args)}`);
  }
});





test('a financial call is classified as one whatever tool carries it', () => {
  assert.equal(classifyToolCall('run_command', { command: 'curl https://api.stripe.com/v1/charges' }).financial, true);
  assert.equal(classifyToolCall('run_command', { command: 'npm test' }).financial, false);
});
