// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/model-catalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOpenAIModels, normalizeOllamaModels } = require('../../src/lib/model-catalog');

test('OpenAI-compatible model metadata is kept for a large model picker', () => {
  const models = normalizeOpenAIModels({ data: [{
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    architecture: { input_modalities: ['text', 'image'] },
  }] });

  assert.deepEqual(models[0], {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    group: 'anthropic',
    contextLength: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    modalities: ['text', 'image'],
    acceptsTemplateKwargs: false,
  });
});

test('a vLLM server is recognised as accepting chat_template_kwargs', () => {
  const [served] = normalizeOpenAIModels({ data: [{ id: 'brittain4', max_model_len: 32_768 }] });
  assert.equal(served.acceptsTemplateKwargs, true);
  assert.equal(served.contextLength, 32_768);
});

test('official OpenAI models do not appear under an internal system group', () => {
  const models = normalizeOpenAIModels({ data: [{ id: 'gpt-5', owned_by: 'system' }] });
  assert.equal(models[0].group, 'OpenAI');
});

test('Ollama model details include size and build information', () => {
  const models = normalizeOllamaModels([{
    name: 'qwen3:8b',
    size: 5_000_000_000,
    details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
  }]);

  assert.equal(models[0].id, 'qwen3:8b');
  assert.equal(models[0].group, 'Local');
  assert.equal(models[0].parameterSize, '8.2B');
  assert.equal(models[0].quantization, 'Q4_K_M');
});

test('a self-hosted vLLM model states its window under max_model_len', () => {
  // Verbatim shape of a vLLM /v1/models entry. Reading only context_length
  // left this null, so getContextLength() fell back to the configured cap and
  // a 32k server was budgeted as a million-token one.
  const models = normalizeOpenAIModels({ data: [{
    id: 'brittain4',
    object: 'model',
    owned_by: 'vllm',
    root: '/home/lukeb/brittain4/models/brittain4-base-w4a16',
    max_model_len: 32_768,
  }] });

  assert.equal(models[0].contextLength, 32_768);
  assert.equal(models[0].group, 'vllm');
});

test('context_length still wins where a provider sends both', () => {
  const models = normalizeOpenAIModels({ data: [
    { id: 'a', context_length: 200_000, max_model_len: 32_768 },
    { id: 'b', context_window: 128_000 },
    { id: 'c' },
  ] });
  assert.equal(models[0].contextLength, 200_000);
  assert.equal(models[1].contextLength, 128_000);
  assert.equal(models[2].contextLength, null, 'a provider that states nothing must still fall back');
});
