'use strict';

// A local stand-in for every provider the CLI talks to. Tests never call a
// real model (PLAN.md §1 rule 6).
//
// Speaks both wire protocols on one port:
//   Ollama   GET /api/tags, POST /api/show
//   OpenAI   GET /v1/models
// under an optional path prefix, so a test can point the Brittain mode at
// http://127.0.0.1:<port>/<prefix>/v1 and grep for <prefix> in the output.

const http = require('node:http');

function createFakeProvider({
  prefix = '',
  models = ['alpha-model', 'beta-model'],
  requireKey = '',
  status = 0,
  errorBody = '',
} = {}) {
  const requests = [];
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
        return send(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'test', context_length: 32_768 })) });
      }
      if (req.method === 'GET' && url === '/api/tags') {
        return send(200, { models: models.map((name) => ({ name, model: name, size: 1_000, details: { parameter_size: '8B' } })) });
      }
      if (req.method === 'POST' && url === '/api/show') {
        return send(200, { model_info: { 'test.context_length': 16_384 }, capabilities: ['completion', 'tools'] });
      }
      return send(404, { error: 'not found' });
    });
  });

  return {
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      this.port = port;
      this.origin = `http://127.0.0.1:${port}`;
      this.base = `${this.origin}${prefix}`;
      return this;
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeProvider };
