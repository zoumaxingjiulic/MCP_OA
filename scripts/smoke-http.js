import assert from 'node:assert/strict';
import { config as loadDotenv } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

loadDotenv({ path: new URL('../.env', import.meta.url), quiet: true });
const [endpoint = 'http://127.0.0.1:3211/mcp', department] = process.argv.slice(2);
if (!process.env.MCP_AUTH_TOKEN) throw new Error('请设置 MCP_AUTH_TOKEN 环境变量或项目 .env。');
const client = new Client({ name: 'oa-http-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
  }));
  const result = await client.listTools();
  assert.deepEqual(result.tools.map(tool => tool.name), ['oa_search_contacts', 'oa_list_meetings']);
  console.log('MCP HTTP 连接、初始化、工具发现成功：oa_search_contacts, oa_list_meetings');
  if (department) {
    const response = await client.callTool({ name: 'oa_search_contacts', arguments: { department, count_only: true } }, undefined, { timeout: 120000 });
    assert.ok(!response.isError, 'OA 查询失败，请检查账号、部门名称及网络。');
    console.log(JSON.stringify({ total: response.structuredContent.total, count_basis: response.structuredContent.count_basis }));
  }
} catch {
  console.error('HTTP 验证失败，请检查地址、MCP 令牌、网络和 OA 配置。');
  process.exitCode = 1;
} finally { await client.close(); }
