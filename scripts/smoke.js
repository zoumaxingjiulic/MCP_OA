import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const department = value('--department');
const keyword = value('--keyword') || (args[0] && !args[0].startsWith('--') ? args[0] : undefined);
const input = {
  ...(department ? { department } : {}),
  ...(keyword || !department ? { keyword: keyword || config.username } : {}),
  page_size: 2,
  count_only: args.includes('--count-only'),
  include_subdepartments: !args.includes('--direct'),
};
const client = new Client({ name: 'oa-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  env: {
    OA_ENV_FILE: process.env.OA_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url)),
    OA_BASE_URL: config.baseUrl, OA_USERNAME: config.username, OA_PASSWORD: config.password,
    OA_TIMEOUT_MS: String(config.timeoutMs),
  },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['oa_search_contacts', 'oa_list_meetings']);
  const result = await client.callTool({ name: 'oa_search_contacts', arguments: input });
  if (result.isError) throw new Error(result.content[0].text);
  assert.ok(result.structuredContent);
  console.log(JSON.stringify({
    ok: true, tool: 'oa_search_contacts', total: result.structuredContent.total,
    returned: result.structuredContent.returned,
    department: result.structuredContent.department,
    include_subdepartments: result.structuredContent.include_subdepartments,
    count_only: result.structuredContent.count_only,
    contacts: result.structuredContent.contacts.map(person => ({
      name: person.name, department: person.department, position: person.position,
      has_mobile: Boolean(person.mobile),
    })),
  }, null, 2));
} finally { await client.close(); }
