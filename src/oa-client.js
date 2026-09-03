import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { sm2 } from 'sm-crypto-v2';
import { OaError } from './errors.js';
import { normalizePerson, parseSearchPage, searchInputSchema } from './directory.js';
import { OrganizationDirectory } from './organization.js';

export const SEARCH_PATH = '/sys/zone/sys_zone_personInfo/sysZonePersonInfo.do';
export const PERSON_PATH = '/sys/person/sys_person_zone/sysPersonZone.do';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function isLogin(response) {
  return /\/login[^/]*\.jsp(?:[?#]|$)/i.test(response.url)
    || /<form\b[^>]*action\s*=\s*["']?[^>]*j_acegi_security_check/i.test(response.text)
    || /(?:location(?:\.href)?\s*=|location\.replace\()\s*["'][^"']*\/login[^"']*\.jsp/i.test(response.text);
}

export class OaClient {
  #config;
  #fetch;
  #loggedIn = false;
  #loginPromise;
  #generation = 0;
  #organization;

  constructor(config, { fetchImpl = fetch } = {}) {
    this.#config = config;
    // Session cookies remain in memory and are never included in MCP responses or logs.
    this.#fetch = makeFetchCookie(fetchImpl, new CookieJar());
    this.#organization = new OrganizationDirectory(path => this.#authenticatedGet(path));
  }

  async #request(path, { method = 'GET', body } = {}) {
    let url = new URL(this.#config.baseUrl + path);
    const allowedOrigin = url.origin;
    const signal = AbortSignal.timeout(this.#config.timeoutMs);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await this.#fetch(url, {
          method, body, redirect: 'manual', signal,
          headers: { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'landray-oa-mcp/0.3.0' },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new OaError('INVALID_REDIRECT', 'OA 返回了无效重定向。');
          url = new URL(location, url);
          if (url.origin !== allowedOrigin || url.username || url.password) {
            throw new OaError('UNSAFE_REDIRECT', 'OA 跳转到其他站点，已停止请求。请配置正确的 OA 地址。');
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new OaError('RESPONSE_TOO_LARGE', 'OA 返回内容超过大小限制，请缩小查询范围。');
          chunks.push(Buffer.from(chunk));
        }
        return { status: response.status, url: url.href, text: Buffer.concat(chunks).toString('utf8') };
      }
      throw new OaError('TOO_MANY_REDIRECTS', 'OA 重定向次数过多，请检查登录配置。');
    } catch (error) {
      if (error instanceof OaError) throw error;
      if (signal.aborted) throw new OaError('TIMEOUT', 'OA 请求超时，请稍后重试。');
      throw new OaError('NETWORK_ERROR', '无法连接 OA，请检查地址、网络或 VPN。');
    }
  }

  #checkStatus(response) {
    if (response.status === 401) throw new OaError('AUTH_FAILED', 'OA 登录失效或认证失败，请检查账号配置。');
    if (response.status === 403) throw new OaError('PERMISSION_DENIED', '当前 OA 账号没有访问通讯录的权限。');
    if (response.status < 200 || response.status >= 300) {
      throw new OaError('UPSTREAM_HTTP_ERROR', `OA 返回 HTTP ${response.status}，请稍后重试或联系管理员。`);
    }
  }

  async #login() {
    if (this.#loggedIn) return;
    if (this.#loginPromise) return this.#loginPromise;
    this.#loginPromise = this.#performLogin();
    try { await this.#loginPromise; } finally { this.#loginPromise = undefined; }
  }

  async #performLogin() {
    const page = await this.#request('/login.jsp');
    this.#checkStatus(page);
    const session = await this.#request('/resource/js/session.jsp');
    this.#checkStatus(session);
    const key = session.text.match(/getSM2PubKey\s*=\s*function\s*\(\)\s*\{\s*return\s*["'](04[a-f0-9]{128})["']/i)?.[1];
    if (!key || !sm2.verifyPublicKey(key)) {
      throw new OaError('LOGIN_FORMAT_CHANGED', '未找到有效的 OA SM2 登录公钥，请检查登录页面是否升级。');
    }
    // Matches this OA's security.js and sm2.js: marker + 04 + SM2 C1C2C3.
    const encrypted = '\u534d\u3220\u4d45' + '04' + sm2.doEncrypt(this.#config.password, key, 0);
    const response = await this.#request('/j_acegi_security_check', {
      method: 'POST',
      body: new URLSearchParams({ j_username: this.#config.username, j_password: encrypted, j_redirectto: '' }),
    });
    this.#checkStatus(response);
    if (isLogin(response) || /j_security_check|login_error|登录失败|验证码|密码错误|修改密码/.test(response.text)) {
      throw new OaError('AUTH_FAILED', 'OA 登录未完成，请检查账号密码，或先在网页处理验证码/密码变更要求。');
    }
    this.#loggedIn = true;
    this.#generation++;
  }

  async #authenticatedGet(path) {
    await this.#login();
    const generation = this.#generation;
    let response = await this.#request(path);
    if (response.status === 401 || isLogin(response)) {
      // One renewal per expired session, shared by concurrent requests.
      if (generation === this.#generation) this.#loggedIn = false;
      await this.#login();
      response = await this.#request(path);
    }
    this.#checkStatus(response);
    if (isLogin(response)) {
      this.#loggedIn = false;
      throw new OaError('AUTH_FAILED', '重新登录后仍无法访问 OA 通讯录，请检查账号和登录策略。');
    }
    return response;
  }

  async #searchPage(keyword, page, page_size) {
    const query = new URLSearchParams({ method: 'getPersons', fdSearchName: keyword, searchPeople: 'true', pageno: String(page), rowsize: String(page_size) });
    const response = await this.#authenticatedGet(`${SEARCH_PATH}?${query}`);
    const results = parseSearchPage(response.text);
    if (results.page !== page || results.pageSize !== page_size) {
      throw new OaError('PAGINATION_MISMATCH', 'OA 未按请求分页返回结果，请检查页码或页面版本。');
    }
    return results;
  }

  async #keywordIds(keyword) {
    const first = await this.#searchPage(keyword, 1, 50);
    if (first.total > 10000) throw new OaError('QUERY_TOO_BROAD', '姓名或手机号匹配超过 10000 人，请提供更具体的关键词。');
    const ids = new Set(first.ids);
    for (let page = 2; page <= Math.ceil(first.total / 50); page++) {
      const next = await this.#searchPage(keyword, page, 50);
      if (next.total !== first.total) throw new OaError('DIRECTORY_CHANGED', '查询过程中人员总数发生变化，请重试。');
      for (const id of next.ids) ids.add(id);
    }
    return ids;
  }

  async #details(ids) {
    const contacts = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next++;
        const id = ids[index];
        const detail = await this.#authenticatedGet(`${PERSON_PATH}?${new URLSearchParams({ method: 'info', fdId: id })}`);
        let data;
        try { data = JSON.parse(detail.text); } catch {
          throw new OaError('UPSTREAM_FORMAT_CHANGED', 'OA 人员详情未返回有效 JSON，请检查接口或权限。');
        }
        contacts[index] = normalizePerson(data, id, this.#config.baseUrl);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return contacts;
  }

  async searchContacts(input) {
    const parsed = searchInputSchema.safeParse(input);
    if (!parsed.success) throw new OaError('INVALID_INPUT', '请提供姓名/手机号 keyword 或部门 department，页码须为 1–10000，每页须为 1–50；排除下级部门时必须指定部门。');
    const { keyword = '', department, include_subdepartments, count_only, page, page_size } = parsed.data;
    let resolved = null;
    let ids;
    let total;
    if (department) {
      resolved = await this.#organization.resolve(department);
      let members = await this.#organization.members(resolved, include_subdepartments);
      if (keyword && members.length) {
        const matches = await this.#keywordIds(keyword);
        members = members.filter(id => matches.has(id));
      }
      total = members.length;
      ids = count_only ? [] : members.slice((page - 1) * page_size, page * page_size);
    } else {
      // Count-only requests use the first small search page regardless of the display page.
      const result = await this.#searchPage(keyword, count_only ? 1 : page, count_only ? 1 : page_size);
      total = result.total;
      ids = count_only ? [] : result.ids;
    }
    const contacts = await this.#details(ids);
    return {
      keyword, department: resolved ? { id: resolved.id, name: resolved.name, path: resolved.path } : null,
      include_subdepartments, count_only, count_basis: 'oa_directory',
      page, page_size, total, returned: contacts.length,
      has_more: !count_only && page * page_size < total, contacts,
    };
  }
}
