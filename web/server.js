import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ChatService, ChatError, connectMcp, loadWebConfig } from './chat-service.js';

export function createWebServer(service, port) {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ]);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    // Reject cross-site requests and DNS rebinding; this is a local single-user utility.
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '仅允许从本地页面访问。' });
    try {
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, type] = assets.get(req.url);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && req.url === '/api/status') return json(200, service.status());
      if (req.method === 'DELETE' && /^\/api\/conversations\/[a-f0-9-]{36}$/.test(req.url)) {
        const id = req.url.split('/').at(-1);
        if (service.sessions.get(id)?.busy) return json(409, { error: '请先停止当前查询。' });
        service.sessions.delete(id);
        return json(200, { ok: true });
      }
      if (req.method !== 'POST' || req.url !== '/api/chat') return json(404, { error: '页面不存在。' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 JSON 请求。' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 20000) return json(413, { error: '问题过长。' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(400, { error: 'JSON 无效。' }); }
      if (!input || typeof input !== 'object') return json(400, { error: '请求无效。' });
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.flushHeaders();
      const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
      try {
        await service.chat(input, emit, controller.signal);
      } catch (error) {
        emit({ type: 'error', code: error instanceof ChatError ? error.code : 'INTERNAL_ERROR', message: error instanceof ChatError ? error.message : '查询失败，请稍后重试。' });
      } finally { res.end(); }
    } catch { if (!res.headersSent) json(500, { error: '页面服务异常，请稍后重试。' }); else res.end(); }
  });
}

async function main() {
  const config = loadWebConfig();
  const mcp = await connectMcp(config);
  const service = new ChatService(config, mcp);
  const app = createWebServer(service, config.port);
  app.on('error', async error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用。` : '网页服务无法启动。');
    await mcp.client.close();
    process.exitCode = 1;
  });
  app.listen(config.port, '127.0.0.1', () => console.log(`OA 聊天页面已启动：http://127.0.0.1:${config.port}`));
  const stop = async () => { app.closeAllConnections(); app.close(); await mcp.client.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase().endsWith(process.argv[1].replaceAll('\\', '/').toLowerCase())) {
  main().catch(error => { console.error(error instanceof ChatError ? error.message : '网页启动失败，请检查后端配置。'); process.exitCode = 1; });
}
