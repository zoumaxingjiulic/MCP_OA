import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatService } from '../web/chat-service.js';
import { createWebServer } from '../web/server.js';

const config = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'secret-test-key' };
const tools = [{ name: 'oa_search_contacts', description: '通讯录', inputSchema: { type: 'object', properties: { department: { type: 'string' } } } }];
const call = { id: 'call_test', type: 'function', function: { name: 'oa_search_contacts', arguments: '{"department":"研发中心","count_only":true}' } };
const result = { total: 51, returned: 0, contacts: [] };
const completion = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
function serviceWith(responses, execute = async () => ({ structuredContent: result })) {
  const requests = [];
  const executed = [];
  const service = new ChatService(config, { tools, client: { callTool: async args => { executed.push(args); return execute(args); } } }, async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const response = responses.shift();
    if (!response) throw new Error('No mock response');
    return response;
  });
  return { service, requests, executed };
}

test('聊天完整经过模型选工具、MCP、模型整理回答，并保存连续对话上下文', async () => {
  const { service, requests, executed } = serviceWith([
    completion({ role: 'assistant', content: null, tool_calls: [call] }),
    completion({ role: 'assistant', content: '研发中心共51人。' }),
    completion({ role: 'assistant', content: '包含下级部门。' }),
  ]);
  const events = [];
  await service.chat({ message: '研发中心有多少人？' }, e => events.push(e), new AbortController().signal);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].arguments, { department: '研发中心', count_only: true });
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].body.messages.at(-1).content).result.total, 51);
  assert.deepEqual(events.map(e => e.type), ['session', 'status', 'tool_call', 'tool_result', 'status', 'answer', 'done']);
  assert.equal(events.at(-1).tool_count, 1);
  assert.equal(JSON.stringify(service.status()).includes(config.apiKey), false);
  const id = events[0].conversation_id;
  await service.chat({ message: '包括下级部门吗？', conversation_id: id }, () => {}, new AbortController().signal);
  assert.ok(requests[2].body.messages.some(m => m.role === 'assistant' && m.content === '研发中心共51人。'));
});

test('未知工具不执行，工具错误交回模型且展示在调用记录', async () => {
  const unknown = { ...call, function: { name: 'delete_everything', arguments: '{}' } };
  const { service, executed, requests } = serviceWith([
    completion({ role: 'assistant', tool_calls: [unknown] }),
    completion({ role: 'assistant', content: '工具不可用。' }),
  ]);
  const events = [];
  await service.chat({ message: '测试错误' }, e => events.push(e), new AbortController().signal);
  assert.equal(executed.length, 0);
  assert.equal(events.find(e => e.type === 'tool_result').is_error, true);
  assert.equal(JSON.parse(requests[1].body.messages.at(-1).content).isError, true);
});

test('模型认证错误不回显上游敏感错误正文，失败轮次不写入历史', async () => {
  const { service } = serviceWith([new Response(`secret-test-key internal stack`, { status: 401 })]);
  await assert.rejects(service.chat({ message: '测试' }, () => {}, new AbortController().signal), error => {
    assert.equal(error.code, 'MODEL_HTTP_ERROR');
    assert.ok(!error.message.includes(config.apiKey)); return true;
  });
  const session = [...service.sessions.values()][0];
  assert.equal(session.messages.length, 1);
  assert.equal(session.busy, false);
});

test('请求校验与过期对话不会访问模型', async () => {
  const { service, requests } = serviceWith([]);
  await assert.rejects(service.chat({ message: '' }, () => {}, new AbortController().signal), { code: 'INVALID_INPUT' });
  await assert.rejects(service.chat({ message: '测试', conversation_id: 'unknown' }, () => {}, new AbortController().signal), { code: 'SESSION_EXPIRED' });
  assert.equal(requests.length, 0);
});

test('本地网页API：页面可用、配置脱敏、拒绝跨站、不暴露.env', async t => {
  const { service } = serviceWith([]);
  // Reserve a port first, then bind a server with the exact Host validation value.
  const reserve = createWebServer(service, 0);
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const app = createWebServer(service, port);
  await new Promise(resolve => app.listen(port, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${port}`;
  const status = await fetch(base + '/api/status');
  assert.equal(status.status, 200);
  assert.ok(!(await status.text()).includes(config.apiKey));
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /MCP 验证工作台/);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});
