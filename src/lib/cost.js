// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/cost.js
'use strict';

// What a cloud turn cost.
//
// Rates used to be typed into Settings by hand, which was both tedious and
// wrong the moment a provider changed its prices or the model was switched.
// The model catalog already carries per-million rates straight from the
// provider's own listing, so that is the only source here.
//
// Two rules follow from where the numbers come from:
//
//   A local model costs nothing. Not "nothing known" — nothing. There is no
//   bill, so there is no figure to show and none is shown.
//
//   A cloud model whose provider published no rates has an unknown cost, which
//   is different from zero. Reporting $0.00 for a model that is quietly
//   charging would be worse than saying nothing, so an unknown stays unknown.

function ratesFor(details) {
  const input = Number(details?.inputPricePerMillion);
  const output = Number(details?.outputPricePerMillion);
  const hasInput = Number.isFinite(input) && input >= 0;
  const hasOutput = Number.isFinite(output) && output >= 0;
  if (!hasInput && !hasOutput) return null;
  return { inputPerMillion: hasInput ? input : 0, outputPerMillion: hasOutput ? output : 0 };
}

// Returns null when there is nothing meaningful to say, so callers can tell
// "free" apart from "unpriced" without inspecting the numbers themselves.
function costOf(stats, rates) {
  if (!rates) return null;
  const prompt = Number(stats?.promptTokens) || 0;
  const completion = Number(stats?.evalTokens) || 0;
  if (!prompt && !completion) return null;
  return (prompt / 1e6) * rates.inputPerMillion + (completion / 1e6) * rates.outputPerMillion;
}

// Fractions of a cent are the normal case for a cheap model, and rounding them
// to $0.00 makes the feature look broken. Small amounts get more places rather
// than fewer, and anything genuinely zero says so in words.
function formatCost(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  if (value === 0) return 'free';
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(count) {
  const value = Number(count) || 0;
  return value.toLocaleString();
}

// One line for the end of a turn: what it cost, and the tokens behind it so the
// number can be checked rather than trusted.
function describeTurn({ cost, promptTokens, evalTokens }) {
  const tokens = `${formatTokens(promptTokens)} in · ${formatTokens(evalTokens)} out`;
  if (cost === null || cost === undefined) return tokens;
  return `${formatCost(cost)} · ${tokens}`;
}

// Running totals for a conversation. Kept per session so switching between
// chats does not pool their spending.
function emptyTotals() {
  return { cost: 0, promptTokens: 0, evalTokens: 0, turns: 0, priced: true };
}

function addTurn(totals, { cost, promptTokens, evalTokens }) {
  const next = { ...(totals || emptyTotals()) };
  next.promptTokens += Number(promptTokens) || 0;
  next.evalTokens += Number(evalTokens) || 0;
  next.turns += 1;
  if (cost === null || cost === undefined) {
    // One unpriced turn makes the whole total a lower bound, and saying so is
    // more useful than quietly under-reporting.
    next.priced = false;
  } else {
    next.cost += cost;
  }
  return next;
}

function describeTotals(totals) {
  if (!totals || !totals.turns) return 'Nothing spent in this conversation yet.';
  const spend = totals.priced
    ? formatCost(totals.cost)
    : `at least ${formatCost(totals.cost)} (some turns had no published rates)`;
  return `${spend} over ${totals.turns} turn${totals.turns === 1 ? '' : 's'} — `
    + `${formatTokens(totals.promptTokens)} in · ${formatTokens(totals.evalTokens)} out`;
}

module.exports = { ratesFor, costOf, formatCost, formatTokens, describeTurn, emptyTotals, addTurn, describeTotals };
