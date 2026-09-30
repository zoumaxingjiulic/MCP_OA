import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { MeetingDirectory, meetingInputSchema } from '../src/meetings.js';

const row = (id, start, end, status = '已召开') => Object.entries({
  fdId: id.toString(16).padStart(32, '0'), fdName: '<span>测试会议 &amp; 评审</span>',
  fdHoldDate: start, fdFinishDate: end, fdPlace: '一楼会议室', fdHost: '<a>主持人</a>',
  'docCreator.fdName': '发起人', 'docDept.fdName': '信息中心', docStatus: status,
}).map(([col, value]) => ({ col, value }));
const page = (rows, current = 1, total = rows.length) => ({ text: JSON.stringify({
  page: { currentPage: String(current), pageSize: '100', totalSize: String(total) }, datas: rows,
}) });

test('日期严格校验，包含闰年，无效日期不发请求', async () => {
  assert.equal(meetingInputSchema.safeParse({ date: '2024-02-29' }).success, true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-9-30', '今天', '2026-09-30T00:00:00Z']) {
    assert.equal(meetingInputSchema.safeParse({ date }).success, false);
    await assert.rejects(new MeetingDirectory(() => { throw Error('must not request'); }).list({ date }), { code: 'INVALID_INPUT' });
  }
});

test('跨天交集、午夜边界、取消会议及 HTML 清理', async () => {
  const rows = [row(1, '2026-09-29 23:00', '2026-09-30 01:00'),
    row(2, '2026-09-29 22:00', '2026-09-30 00:00'),
    row(3, '2026-10-01 00:00', '2026-10-01 01:00'),
    row(4, '2026-09-30 10:00', '2026-09-30 12:00', '已取消')];
  const result = await new MeetingDirectory(async () => page(rows)).list({ date: '2026-09-30' });
  assert.equal(result.total, 2);
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.meetings[0].start_time, '2026-09-29T23:00:00+08:00');
  assert.equal(result.meetings[0].name, '测试会议 & 评审');
  assert.equal(result.meetings[1].status, '已取消');
});

test('自动读取所有分页，日期相符记录在后页也不漏查', async () => {
  const old = Array.from({ length: 100 }, (_, i) => row(i + 1, '2025-01-01 10:00', '2025-01-01 11:00'));
  const calls = [];
  const result = await new MeetingDirectory(async path => {
    const q = new URL(path, 'http://oa.test').searchParams;
    calls.push(Number(q.get('pageno')));
    assert.equal(q.get('rowsize'), '100');
    assert.equal(q.get('method'), 'listChildren');
    return calls.length === 1 ? page(old, 1, 101) : page([row(101, '2026-09-30 10:00', '2026-09-30 11:00')], 2, 101);
  }).list({ date: '2026-09-30' });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.total, 1);
});

test('空列表返回零，不把错误页面当作空结果', async () => {
  assert.equal((await new MeetingDirectory(async () => page([])).list({ date: '2026-09-30' })).total, 0);
  for (const response of [{ text: '<html>denied</html>' }, page([row(1, '', '')]), page([], 2, 0)]) {
    await assert.rejects(new MeetingDirectory(async () => response).list({ date: '2026-09-30' }));
  }
});

test('分页重复、总数变化、缺行及扫描超限均报错', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i + 1, '2026-09-30 10:00', '2026-09-30 11:00'));
  for (const second of [page([rows[0]], 2, 101), page([row(101, '2026-09-30 10:00', '2026-09-30 11:00')], 2, 102), page([], 2, 101)]) {
    let n = 0;
    await assert.rejects(new MeetingDirectory(async () => ++n === 1 ? page(rows, 1, 101) : second).list({ date: '2026-09-30' }));
  }
  await assert.rejects(new MeetingDirectory(async () => page(rows, 1, 10001)).list({ date: '2026-09-30' }), { code: 'QUERY_TOO_BROAD' });
});

test('MCP 工具发现、结构化调用及错误脱敏', async () => {
  let fail = false;
  const directory = new MeetingDirectory(async () => page([row(1, '2026-09-30 10:00', '2026-09-30 11:00')]));
  const server = createServer({ listMeetings: input => { if (fail) throw Error('secret password'); return directory.list(input); } });
  const client = new Client({ name: 'meeting-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'oa_list_meetings');
    assert.equal(tool.annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'oa_list_meetings', arguments: { date: '2026-09-30' } });
    assert.equal(result.structuredContent.total, 1);
    fail = true;
    const error = await client.callTool({ name: 'oa_list_meetings', arguments: { date: '2026-09-30' } });
    assert.equal(error.isError, true);
    assert.doesNotMatch(JSON.stringify(error), /secret password/);
  } finally { await client.close(); await server.close(); }
});
