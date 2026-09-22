// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/model-catalog.js
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function groupFromId(id, fallback = 'Models') {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : fallback;
}

function openAIGroup(id, owner) {
  const fallback = !owner || owner.toLowerCase() === 'system' ? 'OpenAI' : owner;
  return groupFromId(id, fallback);
}

// Providers do not agree on what to call the context window on /v1/models.
// OpenRouter says context_length; vLLM says max_model_len; others say
// context_window or max_context_length. Reading only the first name meant a
// self-hosted vLLM looked like it stated nothing, so getContextLength() fell
// back to the configured cap — a 32k server was budgeted as 1,048,576 tokens
// and every request built against that overran the real window.
function statedContextLength(entry) {
  for (const key of ['context_length', 'max_model_len', 'context_window', 'max_context_length']) {
    const value = finiteNumber(entry?.[key]);
    if (value) return value;
  }
  return null;
}

// `chat_template_kwargs` is how a caller turns a reasoning model's thinking off,
// and it is a vLLM extension rather than part of the OpenAI API: OpenAI itself
// rejects unrecognized body params outright, so sending it blindly to every
// OpenAI-compatible endpoint trades one broken provider for another. Nothing in
// /v1/models announces the field, but `max_model_len` is vLLM's own spelling of
// the context window — a server that uses that name is the same server that
// reads the kwarg. Detecting it here keeps the guess in one place instead of
// spread across the call sites that need the answer.
function acceptsTemplateKwargs(entry) {
  return finiteNumber(entry?.max_model_len) !== null;
}

function normalizeOpenAIModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  return entries
    .map((entry) => {
      const id = String(entry?.id || '').trim();
      if (!id) return null;
      const inputPrice = finiteNumber(entry?.pricing?.prompt);
      const outputPrice = finiteNumber(entry?.pricing?.completion);
      const owner = String(entry?.owned_by || '').trim();
      return {
        id,
        name: String(entry?.name || id).trim() || id,
        group: openAIGroup(id, owner),
        contextLength: statedContextLength(entry),
        inputPricePerMillion: inputPrice === null ? null : inputPrice * 1_000_000,
        outputPricePerMillion: outputPrice === null ? null : outputPrice * 1_000_000,
        modalities: Array.isArray(entry?.architecture?.input_modalities)
          ? entry.architecture.input_modalities.map(String)
          : [],
        acceptsTemplateKwargs: acceptsTemplateKwargs(entry),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOllamaModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((entry) => {
      const id = String(entry?.name || entry?.model || '').trim();
      if (!id) return null;
      return {
        id,
        name: id,
        group: 'Local',
        contextLength: null,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        modalities: [],
        sizeBytes: finiteNumber(entry?.size),
        parameterSize: String(entry?.details?.parameter_size || '').trim(),
        quantization: String(entry?.details?.quantization_level || '').trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  groupFromId,
  normalizeOpenAIModels,
  normalizeOllamaModels,
};
