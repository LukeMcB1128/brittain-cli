'use strict';

// A local stand-in for every provider the CLI talks to. Tests never call a
// real model (PLAN.md §1 rule 6).
//
// Speaks both wire protocols on one port, under an optional path prefix (so a
// test can point the Brittain mode at http://127.0.0.1:<port>/<prefix>/v1 and
// grep for <prefix> in the output):
//
//   Ollama   GET /api/tags, POST /api/show, GET /api/version,
//            POST /api/chat (NDJSON)
//   OpenAI   GET /v1/models, POST /v1/chat/completions (SSE)
//
// Chat requests replay `turns` in order, one per request. A turn is
//   { text, thinking, toolCalls: [{ name, arguments }], usage: { prompt, completion },
//     malformed: true,      // answer 500 "error parsing tool call" instead
//     status, body,         // answer with this HTTP error instead
//     split: n }            // stream text in pieces of n characters (default 4)
// When the script runs out, the last turn repeats. `respond(request, index)`
// replaces the script for tests whose request order is not fixed (compaction
// can happen at any step): it receives the parsed request body.

const http = require('node:http');

function pieces(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function ollamaChat(res, turn, model) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const line = (obj) => res.write(JSON.stringify(obj) + '\n');
  for (const part of pieces(turn.thinking || '', turn.split || 4)) {
    line({ model, message: { role: 'assistant', content: '', thinking: part }, done: false });
  }
  for (const part of pieces(turn.text || '', turn.split || 4)) {
    line({ model, message: { role: 'assistant', content: part }, done: false });
  }
  if (turn.toolCalls?.length) {
    line({
      model,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: turn.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments || {} } })),
      },
      done: false,
    });
  }
  line({
    model,
    message: { role: 'assistant', content: '' },
    done: true,
    prompt_eval_count: turn.usage?.prompt ?? 10,
    eval_count: turn.usage?.completion ?? 5,
    eval_duration: 1e9,
    total_duration: 2e9,
  });
  res.end();
}

function openAIChat(res, turn, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => event({ id: 'c1', model, choices: [{ index: 0, delta, finish_reason: finish }] });
  res.write(': keep-alive\n\n');
  for (const part of pieces(turn.thinking || '', turn.split || 4)) chunk({ reasoning_content: part });
  for (const part of pieces(turn.text || '', turn.split || 4)) chunk({ content: part });
  (turn.toolCalls || []).forEach((call, index) => {
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {});
    chunk({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] });
    for (const part of pieces(args, 7)) chunk({ tool_calls: [{ index, function: { arguments: part } }] });
  });
  chunk({}, turn.toolCalls?.length ? 'tool_calls' : 'stop');
  event({ id: 'c1', model, choices: [], usage: { prompt_tokens: turn.usage?.prompt ?? 10, completion_tokens: turn.usage?.completion ?? 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function createFakeProvider({
  prefix = '',
  models = ['alpha-model', 'beta-model'],
  requireKey = '',
  status = 0,
  errorBody = '',
  turns = [{ text: 'ok' }],
  contextLength = 32_768,
  capabilities = ['completion', 'tools'],
  templateKwargs = false,
  respond = null,
} = {}) {
  const requests = [];
  const chats = [];
  let turnIndex = 0;
  const nextTurn = (request) => (respond
    ? respond(request, turnIndex++) || { text: '' }
    : turns[Math.min(turnIndex++, turns.length - 1)] || { text: '' });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
      const send = (code, payload, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (status) return send(status, errorBody || `failure at ${req.headers.host}${req.url}`, 'text/plain');
      if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) {
        return send(401, { error: { message: 'invalid api key' } });
      }
      if (req.method === 'GET' && url === '/v1/models') {
        return send(200, {
          object: 'list',
          data: models.map((id) => ({
            id, object: 'model', owned_by: 'test',
            ...(templateKwargs ? { max_model_len: contextLength } : { context_length: contextLength }),
          })),
        });
      }
      if (req.method === 'GET' && url === '/api/tags') {
        return send(200, { models: models.map((name) => ({ name, model: name, size: 1_000, details: { parameter_size: '8B' } })) });
      }
      if (req.method === 'GET' && url === '/api/version') return send(200, { version: '0.0.0-fake' });
      if (req.method === 'POST' && url === '/api/show') {
        return send(200, { model_info: { 'test.context_length': contextLength }, capabilities });
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/api/chat')) {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        chats.push(parsed);
        const turn = nextTurn(parsed);
        if (turn.malformed) return send(500, { error: 'error parsing tool call: invalid character' });
        if (turn.status) return send(turn.status, turn.body || { error: { message: 'scripted failure' } });
        return url === '/api/chat' ? ollamaChat(res, turn, parsed.model) : openAIChat(res, turn, parsed.model);
      }
      return send(404, { error: 'not found' });
    });
  });

  return {
    requests,
    chats,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      this.port = port;
      this.origin = `http://127.0.0.1:${port}`;
      this.base = `${this.origin}${prefix}`;
      return this;
    },
    stop() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeProvider };
