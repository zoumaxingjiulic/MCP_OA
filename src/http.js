import { loadConfig } from './config.js';
import { OaClient } from './oa-client.js';
import { createHttpServer, loadHttpConfig } from './http-server.js';

try {
  const oaConfig = loadConfig();
  const config = loadHttpConfig();
  const app = createHttpServer(new OaClient(oaConfig), config);
  app.on('error', () => { console.error('OA MCP HTTP 启动失败，请检查监听地址和端口。'); process.exitCode = 1; });
  app.listen(config.port, config.host, () => console.log(`OA MCP HTTP ready on port ${config.port}, path /mcp`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    app.close(() => process.exit(0));
    setTimeout(() => { app.closeAllConnections(); process.exit(0); }, 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(`OA MCP HTTP 启动失败：${error.message}`);
  process.exitCode = 1;
}
