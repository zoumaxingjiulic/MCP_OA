import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchInputSchema, searchOutputSchema } from './directory.js';
import { safeError } from './errors.js';
import { meetingInputSchema, meetingOutputSchema } from './meetings.js';

export function createServer(client) {
  const server = new McpServer({ name: 'landray-oa', version: '0.3.0' });
  server.registerTool('oa_search_contacts', {
    title: '查询 OA 通讯录',
    description: '统一查询 OA 通讯录：查某人所属部门或联系方式时传 keyword（姓名或手机号）；查某部门有哪些人时传 department（准确部门名称）；问多少人时另设 count_only=true。两者同时填写表示在该部门范围内找人。部门默认包含全部下级部门，直属人员设 include_subdepartments=false。同名部门返回候选完整路径，请选择后重试。返回 total 和分页 contacts，统计采用 OA 当前可见通讯录口径，不等于 HR 在职人数。遵守 OA 隐私标记，隐藏字段为 null。',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => {
    try {
      const result = await client.searchContacts(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(safeError(error)) }] };
    }
  });
  server.registerTool('oa_list_meetings', {
    title: '查询某天的 OA 会议安排',
    description: '查询指定日期所有当前 OA 账号可见的会议安排。date 为北京时间 YYYY-MM-DD；今天、明天须先换算为具体日期。包含与当天有时间交集的跨天会议、已取消会议（保留状态），按开始时间排序。自动读取全部分页，返回 total 和 meetings（名称、时间、会议室、主持人、发起人、部门、状态）。不等同于本人参会清单或会议室全部预约，不含独立会议室预约记录；无结果时 total=0。最多扫描 10000 条会议，遇到超限、分页变化或格式错误返回错误，不返回不完整结果。',
    inputSchema: meetingInputSchema,
    outputSchema: meetingOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => {
    try {
      const result = await client.listMeetings(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(safeError(error)) }] };
    }
  });
  return server;
}
