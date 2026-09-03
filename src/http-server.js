import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

export function loadHttpConfig(env = process.env) {
  const token = env.MCP_AUTH_TOKEN || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || /^(your|replace|change)/i.test(token)) {
    throw new Error('MCP_AUTH_TOKEN 必须是随机生成的 32–256 位字母、数字、下划线或连字符。');
  }
  const port = Number(env.MCP_PORT || 3211);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT 必须是 1–65535 的端口。');
  const allowedOrigins = (env.MCP_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('MCP_ALLOWED_ORIGINS 必须是逗号分隔的 http/https Origin。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('MCP_ALLOWED_ORIGINS 必须是精确 Origin，不含路径、通配符或凭据。');
    }
  }
  return { token, port, host: env.MCP_HOST || '127.0.0.1', allowedOrigins };
}

const digest = value => createHash('sha256').update(value).digest();
const maxBodyBytes = 64 * 1024;

function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const fail = status => reject(Object.assign(new Error('Invalid request'), { status }));
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) { chunks.length = 0; fail(413); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBodyBytes) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(400); }
    });
    req.on('error', () => fail(400));
    req.on('aborted', () => fail(400));
  });
}

// Each HTTP request gets its own stateless MCP transport. Only the configured OA
// account's cookie jar and directory cache are shared; transport IDs never cross clients.
export function createHttpServer(client, config) {
  const expectedAuth = digest(`Bearer ${config.token}`);
  let activeRequests = 0;
  const app = http.createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.origin !== undefined && !config.allowedOrigins.includes(req.headers.origin)) {
      reply(res, 403, 'Origin not allowed'); return;
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}'); return;
    }
    if (req.url !== '/mcp') { reply(res, 404, 'Not found'); return; }
    if (!timingSafeEqual(digest(req.headers.authorization || ''), expectedAuth)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="oa-mcp"');
      reply(res, 401, 'Unauthorized'); return;
    }
    if (req.method !== 'POST') {
      // Stateless request/response tools do not need a standalone SSE stream.
      res.setHeader('Allow', 'POST'); reply(res, 405, 'Method not allowed'); return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reply(res, 415, 'Content-Type must be application/json'); return;
    }
    if (Number(req.headers['content-length']) > maxBodyBytes) { reply(res, 413, 'Request too large'); return; }
    if (activeRequests >= 32) { res.setHeader('Retry-After', '5'); reply(res, 503, 'Server busy'); return; }
    activeRequests++;
    let server;
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      activeRequests--;
      if (server) void server.close().catch(() => {});
    };
    res.once('close', cleanup);
    try {
      const body = await readJson(req);
      if (res.destroyed) return;
      server = createServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, error.status || 500, error.status === 413 ? 'Request too large' : error.status === 400 ? 'Invalid JSON' : 'Internal server error');
    }
  });
  return app;
}
