import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, loadHttpConfig } from '../src/http-server.js';

const token = 'fixture-http-token-0123456789abcdef';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function fixture(t, searchContacts = async input => ({
  keyword: input.keyword || '', department: null, include_subdepartments: input.include_subdepartments,
  count_only: input.count_only, count_basis: 'oa_directory', page: input.page, page_size: input.page_size,
  total: 0, returned: 0, has_more: false, contacts: [],
})) {
  const calls = [];
  const server = createHttpServer({ searchContacts: async input => { calls.push(input); return searchContacts(input); } }, loadHttpConfig({ MCP_AUTH_TOKEN: token }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('HTTP MCP 官方客户端完成初始化、工具发现、参数默认值及并发调用', async t => {
  const { base, calls } = await fixture(t);
  const clients = [new Client({ name: 'a', version: '1' }), new Client({ name: 'b', version: '1' })];
  try {
    await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }))));
    assert.deepEqual((await clients[0].listTools()).tools.map(tool => tool.name), ['oa_search_contacts']);
    const results = await Promise.all(clients.map((client, i) => client.callTool({ name: 'oa_search_contacts', arguments: { keyword: `person${i}`, count_only: true } })));
    assert.deepEqual(results.map(r => r.structuredContent.keyword), ['person0', 'person1']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].page_size, 15);
    assert.equal(calls[0].include_subdepartments, true);
    const invalid = await clients[0].callTool({ name: 'oa_search_contacts', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 2);
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('HTTP 鉴权、Origin、健康检查和文件隔离；拒绝请求不访问 OA', async t => {
  const { base, calls } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
  for (const auth of ['', 'Bearer wrong', `Bearer ${token}suffix`]) {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Authorization: auth }, body: '{}' });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(token));
  }
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/.env`, { headers })).status, 404);
  for (const method of ['GET', 'DELETE']) assert.equal((await fetch(`${base}/mcp`, { method, headers })).status, 405);
  assert.equal(calls.length, 0);
});

test('HTTP 拒绝非 JSON、损坏或过大请求，随后仍可正常服务', async t => {
  const { base, calls } = await fixture(t);
  const post = (body, extra = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(65536) }))).status, 413);
  const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools[0].name, 'oa_search_contacts');
  assert.equal(calls.length, 0);
});

test('HTTP OA 异常不会暴露密码和原始错误', async t => {
  const { base } = await fixture(t, async () => { throw new Error('private-cookie-and-password'); });
  const client = new Client({ name: 'error-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const result = await client.callTool({ name: 'oa_search_contacts', arguments: { keyword: '测试' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /private-cookie-and-password/);
  } finally { await client.close(); }
});

test('HTTP 配置要求令牌及有效端口、精确 Origin，错误不回显值', () => {
  for (const invalid of ['', 'short', 'replace-with-a-secure-token-1234567890', 'x'.repeat(257)]) {
    assert.throws(() => loadHttpConfig({ MCP_AUTH_TOKEN: invalid }), /MCP_AUTH_TOKEN/);
  }
  assert.throws(() => loadHttpConfig({ MCP_AUTH_TOKEN: token, MCP_PORT: '0' }), /MCP_PORT/);
  for (const origin of ['*', 'null', 'https://app.example/path', 'bad-secret-value']) {
    assert.throws(() => loadHttpConfig({ MCP_AUTH_TOKEN: token, MCP_ALLOWED_ORIGINS: origin }), error => !error.message.includes(origin));
  }
  assert.deepEqual(loadHttpConfig({ MCP_AUTH_TOKEN: token, MCP_ALLOWED_ORIGINS: 'https://app.example' }).allowedOrigins, ['https://app.example']);
});
