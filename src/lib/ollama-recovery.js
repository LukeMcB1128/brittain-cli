// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:ollama-recovery.js
const TOOL_CALL_PARSE_ERROR = /error parsing tool call/i;

const TOOL_CALL_RETRY_MESSAGE = [
  'Your previous response was rejected because its tool-call arguments were not valid JSON.',
  'Try once more. Emit at most one structured tool call.',
  'Put only the tool arguments in that call: do not include reasoning, narration, XML, or another JSON object inside a string argument.',
  'If no tool is needed, return only the final answer as plain text.',
].join(' ');

function isToolCallParseError(status, body) {
  return Number(status) >= 400 && TOOL_CALL_PARSE_ERROR.test(String(body || ''));
}

function withToolCallRetryInstruction(messages) {
  return [
    ...(Array.isArray(messages) ? messages : []),
    { role: 'user', content: TOOL_CALL_RETRY_MESSAGE },
  ];
}

function toolCallFailureMessage(model) {
  return `Model ${model || '(unknown)'} emitted malformed tool-call JSON twice. Brittain Code retried once with strict formatting and did not execute the malformed call. Retry the task or switch models.`;
}

module.exports = {
  TOOL_CALL_RETRY_MESSAGE,
  isToolCallParseError,
  withToolCallRetryInstruction,
  toolCallFailureMessage,
};
