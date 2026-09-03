import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sm2 } from 'sm-crypto-v2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OaClient, SEARCH_PATH, PERSON_PATH } from '../src/oa-client.js';
import { normalizePerson, parseSearchPage } from '../src/directory.js';
import { loadConfig } from '../src/config.js';
import { TREE_PATH, parseDepartmentPage, parseOrganizationTree } from '../src/organization.js';

const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
const keys = sm2.generateKeyPairHex();
const person = (id = ids[0]) => ({
  fdId: id, fdName: '测试用户', fdIsAvailable: true, isContactPrivate: null,
  isDepInfoPrivate: null, fdDeptName: '测试部', fdPostName: '测试岗位',
  fdMobileNo: '13800000000', fdWorkPhone: '', fdEmail: 'test@example.com',
});
const pageHtml = (page, size, total, pageIds) => `<html><div class="search_person_wrap">${pageIds.map(id => `
  <div data-lui-type="lui/data/source!AjaxJson"><script type="text/code">
  {url:"${PERSON_PATH}?method=info&fdId=${id}"}
  </script></div>`).join('')}</div><div id="pageChange"><script type="text/config">${JSON.stringify({
  currentPage: String(page), pageSize: String(size), totalSize: String(total),
})}</script></div></html>`;
const loginHtml = '<form action="j_acegi_security_check"><input name="j_password"></form>';
const orgIds = { root: '1'.repeat(32), research: '2'.repeat(32), child: '3'.repeat(32), other: '4'.repeat(32), empty: '5'.repeat(32) };
const departmentHtml = (page, size, total, pageIds) => `<html>
  <table>${pageIds.map(id => `<tr kmss_href="${PERSON_PATH}?method=view&fdId=${id}"><td>ignored personal data</td></tr>`).join('')}</table>
  <div>共&nbsp;${total}&nbsp;条</div>
  <input name="pagenoText2" value="${page}"><input name="rowsizeText2" value="${size}">
  </html>`;

async function fixture(t) {
  const state = { logins: 0, generation: 0, queries: [], infoRequests: 0, forbidden: false, broken: false, redirect: false, failLogin: false, slow: false,
    ambiguous: false, treeRequests: 0, memberRequests: [], searchResults: null,
    members: { [orgIds.research]: [...ids, ids[0]], [orgIds.child]: [ids[1], ids[2]], [orgIds.empty]: [] },
  };
  const app = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (text, status = 200, headers = {}) => { res.writeHead(status, headers); res.end(text); };
    if (url.pathname === '/login.jsp') return send(loginHtml);
    if (url.pathname === '/resource/js/session.jsp') {
      return send(`window.getSM2PubKey = function(){ return "${keys.publicKey}"; }`);
    }
    if (url.pathname === '/j_acegi_security_check') {
      state.logins++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const encrypted = params.get('j_password');
      let decrypted;
      try { decrypted = sm2.doDecrypt(encrypted.slice(5), keys.privateKey, 0); } catch { /* fail below */ }
      if (state.failLogin || params.get('j_username') !== 'fixture-account' || !encrypted.startsWith('\u534d\u3220\u4d45' + '04') || decrypted !== 'fixture-password') {
        return send('', 302, { location: '/login.jsp?login_error=1' });
      }
      state.generation++;
      return send('', 302, { 'set-cookie': `JSESSIONID=${state.generation}; Path=/; HttpOnly`, location: '/' });
    }
    if (url.pathname === '/') return send("<script>location.href='/sys/portal/page.jsp';</script>");
    if (req.headers.cookie !== `JSESSIONID=${state.generation}`) return send('', 302, { location: '/login.jsp' });
    if (state.forbidden) return send('secret internal details', 403);
    if (state.redirect) return send('', 307, { location: 'https://example.com/collect' });
    if (state.slow) return; // Client timeout closes this connection at teardown.
    if (url.pathname === TREE_PATH) {
      state.treeRequests++;
      const parent = url.searchParams.get('parent');
      const tree = {
        '': [[orgIds.root, '测试公司']],
        [orgIds.root]: [[orgIds.research, '研发中心'], [orgIds.empty, '空部门'], ...(state.ambiguous ? [[orgIds.other, '其他公司']] : [])],
        [orgIds.research]: [[orgIds.child, '技术部']],
        [orgIds.other]: state.ambiguous ? [['6'.repeat(32), '研发中心']] : [],
      };
      return send(`<dataList>${(tree[parent] || []).map(([id, name]) => `<data value="${id}" text="${name}" />`).join('')}</dataList>`);
    }
    if (url.pathname === SEARCH_PATH) {
      state.queries.push(url);
      if (state.broken) return send('<html>unexpected error document</html>');
      const page = Number(url.searchParams.get('pageno'));
      const size = Number(url.searchParams.get('rowsize'));
      if (url.searchParams.get('method') === 'listPersons') {
        state.memberRequests.push(url);
        const members = state.members[url.searchParams.get('parentId')] || [];
        return send(departmentHtml(page, size, members.length, members.slice((page - 1) * size, page * size)));
      }
      const selected = url.searchParams.get('fdSearchName') === '不存在' ? [] : (state.searchResults || ids);
      return send(pageHtml(page, size, selected.length, selected.slice((page - 1) * size, page * size)));
    }
    if (url.pathname === PERSON_PATH) {
      state.infoRequests++;
      return send(JSON.stringify(person(url.searchParams.get('fdId'))));
    }
    send('not found', 404);
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${app.address().port}`, username: 'fixture-account', password: 'fixture-password', timeoutMs: 2000 };
  return { state, config, client: new OaClient(config) };
}

test('SM2 登录、Cookie 会话、关键词转义和真实分页', async t => {
  const { client, state } = await fixture(t);
  const result = await client.searchContacts({ keyword: '测试&name=其他 +', page: 2, page_size: 2 });
  assert.equal(state.logins, 1);
  assert.equal(state.queries[0].searchParams.get('fdSearchName'), '测试&name=其他 +');
  assert.equal(result.total, 3);
  assert.equal(result.returned, 1);
  assert.equal(result.contacts[0].id, ids[2]);
  assert.equal(result.has_more, false);
  assert.equal(result.contacts[0].telephone, null);
});

test('空结果不查询人员详情', async t => {
  const { client, state } = await fixture(t);
  const result = await client.searchContacts({ keyword: '不存在' });
  assert.equal(result.total, 0);
  assert.deepEqual(result.contacts, []);
  assert.equal(state.infoRequests, 0);
});

test('并发查询复用登录，会话过期时只重登一次', async t => {
  const { client, state } = await fixture(t);
  await Promise.all([1, 2, 3].map(() => client.searchContacts({ keyword: '测试', page_size: 1 })));
  assert.equal(state.logins, 1);
  state.generation++;
  await Promise.all([1, 2, 3].map(() => client.searchContacts({ keyword: '测试', page_size: 1 })));
  assert.equal(state.logins, 2);
});

test('错误密码停止，不循环重试', async t => {
  const { client, state } = await fixture(t);
  state.failLogin = true;
  await assert.rejects(client.searchContacts({ keyword: '测试' }), { code: 'AUTH_FAILED' });
  assert.equal(state.logins, 1);
});

test('403 与空结果区分，不尝试重新登录', async t => {
  const { client, state } = await fixture(t);
  state.forbidden = true;
  await assert.rejects(client.searchContacts({ keyword: '测试' }), { code: 'PERMISSION_DENIED' });
  assert.equal(state.logins, 1);
});

test('阻止跨站重定向', async t => {
  const { client, state } = await fixture(t);
  state.redirect = true;
  await assert.rejects(client.searchContacts({ keyword: '测试' }), { code: 'UNSAFE_REDIRECT' });
});

test('超时返回明确错误', async t => {
  const { config, state } = await fixture(t);
  const client = new OaClient({ ...config, timeoutMs: 200 });
  state.slow = true;
  await assert.rejects(client.searchContacts({ keyword: '测试' }), { code: 'TIMEOUT' });
});

test('页面变更不误报为零人，缺失人员不静默丢失', () => {
  assert.throws(() => parseSearchPage('<html>服务器错误</html>'), { code: 'UPSTREAM_FORMAT_CHANGED' });
  assert.throws(() => parseSearchPage(pageHtml(1, 2, 3, [ids[0]])), { code: 'UPSTREAM_FORMAT_CHANGED' });
});

test('隐私标记和离职状态屏蔽字段，响应只输出白名单', () => {
  for (const flag of [true, 'true', 1, undefined]) {
    const result = normalizePerson({ ...person(), isContactPrivate: flag, isDepInfoPrivate: flag, password: 'never expose' }, ids[0], 'http://oa.test');
    assert.equal(result.mobile, null);
    assert.equal(result.email, null);
    assert.equal(result.department, null);
    assert.equal(result.position, null);
    assert.equal(result.contact_hidden, true);
    assert.equal('password' in result, false);
  }
  const inactive = normalizePerson({ ...person(), fdIsAvailable: false }, ids[0], 'http://oa.test');
  assert.equal(inactive.mobile, null);
  assert.equal(inactive.active, false);
  assert.throws(() => normalizePerson(person(), ids[1], 'http://oa.test'), { code: 'UPSTREAM_FORMAT_CHANGED' });
});

test('参数非法时不发送 OA 请求', async t => {
  const { client, state } = await fixture(t);
  for (const input of [{}, { count_only: true }, { department: '' }, { keyword: '' }, { keyword: '  ' }, { keyword: 'test', include_subdepartments: false }, { keyword: 'test', page_size: 51 }, { keyword: 'test', page: 0 }]) {
    await assert.rejects(client.searchContacts(input), { code: 'INVALID_INPUT' });
  }
  assert.equal(state.logins, 0);
});

test('配置错误不打印输入中的凭据', () => {
  assert.throws(() => loadConfig({ OA_ENV_FILE: 'does-not-exist.env', OA_BASE_URL: 'http://user:SECRET@oa.test', OA_USERNAME: 'u', OA_PASSWORD: 'SECRET' }), error => !error.message.includes('SECRET'));
});

test('标准 MCP stdio：初始化、工具发现、结构化结果和工具错误', async t => {
  const { state, config } = await fixture(t);
  const client = new Client({ name: 'oa-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { OA_ENV_FILE: 'does-not-exist.env', OA_BASE_URL: config.baseUrl, OA_USERNAME: config.username, OA_PASSWORD: config.password },
    stderr: 'pipe',
  });
  let stderr = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['oa_search_contacts']);
    assert.equal(tools.tools[0].annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'oa_search_contacts', arguments: { keyword: '测试', page_size: 1 } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.returned, 1);
    assert.equal(result.structuredContent.has_more, true);
    const count = await client.callTool({ name: 'oa_search_contacts', arguments: { department: '研发中心', count_only: true } });
    assert.equal(count.isError, undefined);
    assert.equal(count.structuredContent.total, 3);
    assert.equal(count.structuredContent.returned, 0);
    assert.equal(count.structuredContent.department.name, '研发中心');
    assert.equal(count.structuredContent.count_only, true);
    const invalid = await client.callTool({ name: 'oa_search_contacts', arguments: { keyword: '测试', page_size: 100 } });
    assert.equal(invalid.isError, true);
    state.forbidden = true;
    const denied = await client.callTool({ name: 'oa_search_contacts', arguments: { keyword: '测试' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /PERMISSION_DENIED/);
    assert.doesNotMatch(denied.content[0].text, /secret internal details|fixture-password/);
    assert.doesNotMatch(stderr, /fixture-password/);
  } finally { await client.close(); }
});

test('部门查询包含下级，按人员 ID 去重后分页', async t => {
  const { client } = await fixture(t);
  const result = await client.searchContacts({ department: '研发中心', page: 2, page_size: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.returned, 1);
  assert.equal(result.contacts[0].id, ids[2]);
  assert.equal(result.department.path, '测试公司/研发中心');
  assert.equal(result.has_more, false);
});

test('只统计部门人数不加载名片，直属人数减去下级成员的并集', async t => {
  const { client, state } = await fixture(t);
  const all = await client.searchContacts({ department: '研发中心', count_only: true });
  const direct = await client.searchContacts({ department: '研发中心', include_subdepartments: false, count_only: true });
  assert.equal(all.total, 3);
  assert.equal(direct.total, 1);
  assert.deepEqual(direct.contacts, []);
  assert.equal(direct.has_more, false);
  assert.equal(state.infoRequests, 0);
});

test('部门加关键词对所有匹配页取交集，再分页', async t => {
  const { client, state } = await fixture(t);
  state.searchResults = [...Array.from({ length: 50 }, (_, i) => (1000 + i).toString(16).padStart(32, '0')), ids[1]];
  const result = await client.searchContacts({ department: '研发中心', keyword: '测试', page_size: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.contacts[0].id, ids[1]);
  assert.equal(state.queries.filter(url => url.searchParams.get('method') === 'getPersons').length, 2);
  const none = await client.searchContacts({ department: '研发中心', keyword: '不存在', count_only: true });
  assert.equal(none.total, 0);
});

test('跨页部门人数完整去重，空部门与不存在的部门区分', async t => {
  const { client, state } = await fixture(t);
  state.members[orgIds.research] = Array.from({ length: 205 }, (_, i) => (i + 100).toString(16).padStart(32, '0'));
  state.members[orgIds.research].push(state.members[orgIds.research][0]);
  const result = await client.searchContacts({ department: '研发中心', count_only: true });
  assert.equal(result.total, 205);
  assert.equal(state.memberRequests.length, 3);
  assert.equal(state.infoRequests, 0);
  const empty = await client.searchContacts({ department: '空部门', count_only: true });
  assert.equal(empty.total, 0);
  await assert.rejects(client.searchContacts({ department: '不存在的部门' }), { code: 'DEPARTMENT_NOT_FOUND' });
});

test('同名部门返回候选完整路径，不擅自选择', async t => {
  const { client, state } = await fixture(t);
  state.ambiguous = true;
  await assert.rejects(client.searchContacts({ department: '研发中心', count_only: true }), error => {
    assert.equal(error.code, 'AMBIGUOUS_DEPARTMENT');
    assert.deepEqual(error.details.candidates.map(node => node.path), ['测试公司/研发中心', '测试公司/其他公司/研发中心']);
    return true;
  });
  assert.equal(state.memberRequests.length, 0);
  const result = await client.searchContacts({ department: '测试公司/研发中心', count_only: true });
  assert.equal(result.total, 3);
});

test('关键词只统计总数，不加载详情或组织树', async t => {
  const { client, state } = await fixture(t);
  const result = await client.searchContacts({ keyword: '测试', count_only: true, page: 999 });
  assert.equal(result.total, 3);
  assert.equal(result.returned, 0);
  assert.equal(state.infoRequests, 0);
  assert.equal(state.treeRequests, 0);
});

test('组织树错误与分页缺失不能伪装为空结果', () => {
  assert.throws(() => parseOrganizationTree('<html>权限错误</html>'), { code: 'UPSTREAM_FORMAT_CHANGED' });
  assert.throws(() => parseOrganizationTree('<dataList><data text="测试" value="bad"/></dataList>'), { code: 'UPSTREAM_FORMAT_CHANGED' });
  assert.throws(() => parseDepartmentPage('<html>共 0 条</html>', 1, 100), { code: 'UPSTREAM_FORMAT_CHANGED' });
  assert.throws(() => parseDepartmentPage(departmentHtml(1, 100, 3, [ids[0]]), 1, 100), { code: 'UPSTREAM_FORMAT_CHANGED' });
});
