import { load } from 'cheerio';
import { z } from 'zod';
import { OaError } from './errors.js';

const queryText = z.string().trim().min(1).max(300)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), '查询条件不能包含控制字符');
export const searchInputSchema = z.object({
  keyword: queryText.max(100).optional().describe('人员姓名或手机号；查某人属于哪个部门时填此项。与 department 同时提供时在该部门范围内找人。'),
  department: queryText.optional().describe('部门准确名称，如研发中心；重名时使用返回的完整路径，如公司/研发中心。查部门人员或人数时填此项。'),
  include_subdepartments: z.boolean().default(true).describe('部门查询是否包含全部下级部门，默认 true；false 只计算直属人员。'),
  count_only: z.boolean().default(false).describe('只问多少人时设为 true：返回 total，不返回人员详情。'),
  page: z.number().int().min(1).max(10000).default(1).describe('页码，从 1 开始。'),
  page_size: z.number().int().min(1).max(50).default(15).describe('每页人数，1–50，默认 15。'),
}).strict().refine(value => value.keyword || value.department, 'keyword 和 department 至少填写一个')
  .refine(value => value.department || value.include_subdepartments, '排除下级部门时必须指定 department');

const privacyFlag = z.union([z.boolean(), z.literal('true'), z.literal('false'), z.literal(0), z.literal(1), z.null()]).optional();
const personSchema = z.object({
  fdId: z.string().regex(/^[a-f0-9]{32}$/i),
  fdName: z.string().trim().min(1),
  fdIsAvailable: z.boolean(),
  isContactPrivate: privacyFlag,
  isDepInfoPrivate: privacyFlag,
  fdOrgName: z.string().nullish(),
  fdDeptName: z.string().nullish(),
  fdPostName: z.string().nullish(),
  fdMobileNo: z.string().nullish(),
  fdWorkPhone: z.string().nullish(),
  fdShortNo: z.string().nullish(),
  fdEmail: z.string().nullish(),
});

function formatChanged() {
  return new OaError('UPSTREAM_FORMAT_CHANGED', 'OA 通讯录响应格式与已验证版本不一致，请检查权限或适配页面变更。');
}

export function parseSearchPage(html) {
  const $ = load(html);
  const rawConfig = $('#pageChange script[type="text/config"]').first().text();
  let paging;
  try { paging = JSON.parse(rawConfig); } catch { throw formatChanged(); }
  const number = (value, minimum) => {
    if (!/^\d+$/.test(String(value))) throw formatChanged();
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < minimum) throw formatChanged();
    return n;
  };
  const page = number(paging.currentPage, 1);
  const pageSize = number(paging.pageSize, 1);
  const total = number(paging.totalSize, 0);
  const ids = new Set();
  // Read the exact AjaxJson sources rendered by the search page; never evaluate page scripts.
  $('.search_person_wrap [data-lui-type="lui/data/source!AjaxJson"] script').each((_, element) => {
    const script = $(element).text();
    const match = script.match(/\/sys\/person\/sys_person_zone\/sysPersonZone\.do\?method=info&fdId=([a-f0-9]{32})(?=["'&\s])/i);
    if (!match) throw formatChanged();
    ids.add(match[1]);
  });
  const expectedCount = Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
  if (ids.size !== expectedCount) throw formatChanged();
  return { ids: [...ids], page, pageSize, total };
}

const hidden = value => value === undefined || value === true || value === 'true' || value === 1;
const clean = value => value?.trim() || null;

export function normalizePerson(raw, expectedId, baseUrl) {
  const result = personSchema.safeParse(raw);
  if (!result.success || result.data.fdId !== expectedId) throw formatChanged();
  const data = result.data;
  const contactHidden = !data.fdIsAvailable || hidden(data.isContactPrivate);
  const departmentHidden = !data.fdIsAvailable || hidden(data.isDepInfoPrivate);
  const profile = new URL(`${baseUrl}/sys/person/sys_person_zone/sysPersonZone.do`);
  profile.search = new URLSearchParams({ method: 'view', fdId: data.fdId }).toString();
  return {
    id: data.fdId,
    name: data.fdName,
    organization: departmentHidden ? null : clean(data.fdOrgName),
    department: departmentHidden ? null : clean(data.fdDeptName),
    position: departmentHidden ? null : clean(data.fdPostName),
    mobile: contactHidden ? null : clean(data.fdMobileNo),
    telephone: contactHidden ? null : clean(data.fdWorkPhone),
    short_number: contactHidden ? null : clean(data.fdShortNo),
    email: contactHidden ? null : clean(data.fdEmail),
    active: data.fdIsAvailable,
    contact_hidden: contactHidden,
    department_hidden: departmentHidden,
    profile_url: profile.href,
  };
}

export const contactOutputSchema = z.object({
  id: z.string(), name: z.string(), organization: z.string().nullable(),
  department: z.string().nullable(), position: z.string().nullable(),
  mobile: z.string().nullable(), telephone: z.string().nullable(),
  short_number: z.string().nullable(), email: z.string().nullable(),
  active: z.boolean(), contact_hidden: z.boolean(), department_hidden: z.boolean(),
  profile_url: z.string().url(),
});

export const searchOutputSchema = z.object({
  keyword: z.string(), page: z.number().int(), page_size: z.number().int(),
  department: z.object({ id: z.string(), name: z.string(), path: z.string() }).nullable(),
  include_subdepartments: z.boolean(), count_only: z.boolean(),
  count_basis: z.literal('oa_directory').describe('OA 当前可见通讯录口径，不等同于 HR 在职人数。'),
  total: z.number().int(), returned: z.number().int(), has_more: z.boolean(),
  contacts: z.array(contactOutputSchema),
});
