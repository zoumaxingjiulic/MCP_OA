import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { OaClient } from './oa-client.js';
import { createServer } from './server.js';

try {
  const server = createServer(new OaClient(loadConfig()));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`OA MCP 启动失败：${error.message}`);
  process.exitCode = 1;
}
