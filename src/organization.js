import { load } from 'cheerio';
import { OaError } from './errors.js';

export const TREE_PATH = '/sys/common/treexml.jsp';
export const MEMBERS_PATH = '/sys/zone/sys_zone_personInfo/sysZonePersonInfo.do';
const BATCH_SIZE = 100;
const MAX_RECORDS = 10000;

function malformed() {
  return new OaError('UPSTREAM_FORMAT_CHANGED', 'OA 组织结构或部门人员列表格式变化，请检查权限和接口版本。');
}

export async function mapLimited(items, fn) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index]);
    }
  }));
  return result;
}

export function parseOrganizationTree(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw malformed();
  const $ = load(xml, { xmlMode: true });
  if ($('dataList').length !== 1 || !/<\/dataList\s*>|<dataList\s*\/>/.test(xml)) throw malformed();
  return $('dataList > data').map((_, el) => {
    const id = $(el).attr('value');
    const name = $(el).attr('text')?.trim();
    if (!/^[a-f0-9]{32}$/i.test(id || '') || !name) throw malformed();
    return { id, name };
  }).get();
}

export function parseDepartmentPage(html, page, pageSize) {
  const $ = load(html);
  // Remove scripts so an error page mentioning a paging template cannot be counted.
  $('script, style').remove();
  const matches = [...$.root().text().matchAll(/共\s*(\d+)\s*条/g)];
  if (!matches.length || new Set(matches.map(match => match[1])).size !== 1) throw malformed();
  const total = Number(matches[0][1]);
  const actualPage = $('[name="pagenoText2"]').val();
  const actualSize = $('[name="rowsizeText2"]').val();
  if (!Number.isSafeInteger(total) || Number(actualPage) !== page || Number(actualSize) !== pageSize) throw malformed();
  const ids = $('tr[kmss_href]').map((_, el) => {
    const url = new URL($(el).attr('kmss_href'), 'http://oa.invalid');
    const id = url.searchParams.get('fdId');
    if (!url.pathname.endsWith('/sys/person/sys_person_zone/sysPersonZone.do') || url.searchParams.get('method') !== 'view' || !/^[a-f0-9]{32}$/i.test(id || '')) throw malformed();
    return id;
  }).get();
  if (ids.length !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) throw malformed();
  return { total, ids };
}

export class OrganizationDirectory {
  #get;
  #treePromise;
  #expires = 0;

  constructor(authenticatedGet) { this.#get = authenticatedGet; }

  async #children(id = '') {
    const query = new URLSearchParams({ s_bean: 'organizationTree', parent: id, orgType: 'organizationTree', fdId: id });
    return parseOrganizationTree((await this.#get(`${TREE_PATH}?${query}`)).text);
  }

  async #loadTree() {
    const nodes = [];
    const seen = new Set();
    let parents = [{ id: '', path: '' }];
    let requests = 0;
    while (parents.length) {
      requests += parents.length;
      if (requests > 1000) throw new OaError('QUERY_TOO_BROAD', '组织结构超过查询上限，请联系维护人员调整适配范围。');
      const levels = await mapLimited(parents, async parent => {
        return (await this.#children(parent.id)).map(child => ({
          ...child, parentId: parent.id, path: parent.path ? `${parent.path}/${child.name}` : child.name,
        }));
      });
      parents = [];
      for (const node of levels.flat()) {
        if (seen.has(node.id)) throw malformed();
        seen.add(node.id);
        nodes.push(node);
        parents.push(node);
      }
    }
    return nodes;
  }

  async resolve(department) {
    if (!this.#treePromise || Date.now() > this.#expires) {
      this.#expires = Date.now() + 300000;
      this.#treePromise = this.#loadTree().catch(error => { this.#treePromise = undefined; throw error; });
    }
    const nodes = await this.#treePromise;
    const found = nodes.filter(node => node.name === department || node.path === department);
    if (!found.length) throw new OaError('DEPARTMENT_NOT_FOUND', '未找到该部门，请使用 OA 中的准确部门名称或完整路径。');
    if (found.length > 1) {
      throw new OaError('AMBIGUOUS_DEPARTMENT', '存在同名部门，请选择完整路径并重新传入 department。', {
        candidates: found.map(({ id, name, path }) => ({ id, name, path })),
      });
    }
    return found[0];
  }

  async #allMembers(id) {
    const readPage = async page => {
      const query = new URLSearchParams({ method: 'listPersons', parentId: id, pageno: String(page), rowsize: String(BATCH_SIZE) });
      return parseDepartmentPage((await this.#get(`${MEMBERS_PATH}?${query}`)).text, page, BATCH_SIZE);
    };
    const first = await readPage(1);
    if (first.total > MAX_RECORDS) throw new OaError('QUERY_TOO_BROAD', '部门人员超过 10000 条，请缩小到下级部门查询。');
    const ids = [...first.ids];
    // Read pages sequentially to bound load and detect a changing source total.
    for (let page = 2; page <= Math.ceil(first.total / BATCH_SIZE); page++) {
      const next = await readPage(page);
      if (next.total !== first.total) throw new OaError('DIRECTORY_CHANGED', '查询过程中人员总数发生变化，请重试。');
      ids.push(...next.ids);
    }
    return [...new Set(ids)];
  }

  async members(department, includeSubdepartments) {
    const ids = await this.#allMembers(department.id);
    if (includeSubdepartments) return ids;
    // listPersons includes descendants. Subtract the union of immediate-child subtrees.
    // This uses IDs, so repeated department names cannot corrupt the direct-member count.
    const descendants = new Set();
    for (const child of await this.#children(department.id)) {
      for (const id of await this.#allMembers(child.id)) descendants.add(id);
    }
    return ids.filter(id => !descendants.has(id));
  }
}
