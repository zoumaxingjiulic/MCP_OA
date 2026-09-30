import { load } from 'cheerio';
import { z } from 'zod';
import { OaError } from './errors.js';

export const MEETING_PATH = '/km/imeeting/km_imeeting_main/kmImeetingMain.do';
const PAGE_SIZE = 100;
const MAX_RECORDS = 10000;
const MAX_QUERY_MS = 60000;

function validDate(value) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export const meetingInputSchema = z.object({
  date: z.string().refine(validDate, '请输入有效日期 YYYY-MM-DD').describe('查询日期，格式 YYYY-MM-DD，按北京时间（Asia/Shanghai）。今天/明天须先换算成具体日期。'),
}).strict();

export const meetingOutputSchema = z.object({
  date: z.string(), timezone: z.literal('Asia/Shanghai'),
  scope: z.literal('current_account_visible_meeting_arrangements'),
  total: z.number().int().nonnegative(),
  meetings: z.array(z.object({
    id: z.string(), name: z.string(), start_time: z.string(), end_time: z.string(),
    room: z.string().nullable(), host: z.string().nullable(),
    creator: z.string().nullable(), department: z.string().nullable(), status: z.string(),
  })),
});

const formatError = () => new OaError('UPSTREAM_FORMAT_CHANGED', 'OA 会议列表格式异常，无法保证查询完整，请检查接口或访问权限。');
const changedError = () => new OaError('MEETINGS_CHANGED', '会议列表在分页过程中发生变化或重复，请重新查询。');
const clean = value => {
  if (value == null) return null;
  if (typeof value !== 'string') throw formatError();
  const $ = load(value);
  $('script,style').remove();
  return $.root().text().replace(/\s+/g, ' ').trim() || null;
};
function timestamp(value) {
  const text = clean(value);
  if (!text || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    || !validDate(text.slice(0, 10)) || Number(text.slice(11, 13)) > 23
    || Number(text.slice(14, 16)) > 59 || (text.length > 16 && Number(text.slice(17, 19)) > 59)) throw formatError();
  return `${text.replace(' ', 'T')}${text.length === 16 ? ':00' : ''}+08:00`;
}

function parsePage(text) {
  let body;
  try { body = JSON.parse(text); } catch { throw formatError(); }
  if (!body?.page || !Array.isArray(body.datas)) throw formatError();
  const integer = (value, min) => {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw formatError();
    return Number(value);
  };
  const currentPage = integer(body.page.currentPage, 1);
  const pageSize = integer(body.page.pageSize, 1);
  const total = integer(body.page.totalSize, 0);
  if (pageSize !== PAGE_SIZE || body.datas.length !== Math.min(pageSize, Math.max(0, total - (currentPage - 1) * pageSize))) throw formatError();
  const meetings = body.datas.map(row => {
    if (!Array.isArray(row)) throw formatError();
    const fields = new Map();
    for (const cell of row) {
      if (!cell || typeof cell.col !== 'string' || fields.has(cell.col)) throw formatError();
      fields.set(cell.col, cell.value);
    }
    const id = fields.get('fdId');
    const name = clean(fields.get('fdName'));
    const status = clean(fields.get('docStatus'));
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id) || !name || !status) throw formatError();
    const start_time = timestamp(fields.get('fdHoldDate'));
    const end_time = timestamp(fields.get('fdFinishDate'));
    if (Date.parse(end_time) <= Date.parse(start_time)) throw formatError();
    return { id, name, start_time, end_time, status,
      room: clean(fields.get('fdPlace')), host: clean(fields.get('fdHost')),
      creator: clean(fields.get('docCreator.fdName')), department: clean(fields.get('docDept.fdName')) };
  });
  return { currentPage, total, meetings };
}

export class MeetingDirectory {
  constructor(authenticatedGet) { this.get = authenticatedGet; }

  async list(input) {
    const parsed = meetingInputSchema.safeParse(input);
    if (!parsed.success) throw new OaError('INVALID_INPUT', '请提供有效日期 date，格式 YYYY-MM-DD，例如 2026-09-30。');
    const { date } = parsed.data;
    const dayStart = Date.parse(`${date}T00:00:00+08:00`);
    const dayEnd = dayStart + 86400000;
    const started = Date.now();
    const meetings = [];
    const seen = new Set();
    let total;
    // The UI filters by start date only. Scan all pages to include overnight meetings.
    for (let page = 1; total === undefined || (page - 1) * PAGE_SIZE < total; page++) {
      if (Date.now() - started >= MAX_QUERY_MS) throw new OaError('TIMEOUT', '会议完整查询超时，请稍后重试。');
      const query = new URLSearchParams({ method: 'listChildren', categoryId: '', nodeType: '', cycle: 'true', pageno: String(page), rowsize: String(PAGE_SIZE) });
      const response = await this.get(`${MEETING_PATH}?${query}`);
      if (Date.now() - started >= MAX_QUERY_MS) throw new OaError('TIMEOUT', '会议完整查询超时，请稍后重试。');
      const data = parsePage(response.text);
      if (data.currentPage !== page) throw new OaError('PAGINATION_MISMATCH', 'OA 未按请求返回会议分页，无法保证完整，请联系维护人员。');
      if (total !== undefined && data.total !== total) throw changedError();
      total = data.total;
      if (total > MAX_RECORDS) throw new OaError('QUERY_TOO_BROAD', '可见会议超过 10000 条，需适配服务端时间区间筛选后再查询；未返回部分结果。');
      for (const meeting of data.meetings) {
        if (seen.has(meeting.id)) throw changedError();
        seen.add(meeting.id);
        if (Date.parse(meeting.start_time) < dayEnd && Date.parse(meeting.end_time) > dayStart) meetings.push(meeting);
      }
    }
    if (seen.size !== total) throw changedError();
    meetings.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time) || a.id.localeCompare(b.id));
    return { date, timezone: 'Asia/Shanghai', scope: 'current_account_visible_meeting_arrangements', total: meetings.length, meetings };
  }
}
