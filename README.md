# 蓝凌 OA MCP

标准 **stdio / Streamable HTTP MCP 服务**，统一工具名为 `oa_search_contacts`。支持按姓名、手机号或部门查询人员，以及统计人数；可在指定部门中找人。查询结果包含姓名、人员 ID、部门、岗位、手机、办公电话、短号、邮箱和人员主页链接。原有 `{ "keyword": "张三" }` 调用保持兼容。

## Docker 服务器部署

支持通过 `http://服务器IP:3211/mcp` 连接，使用 Streamable HTTP 和 Bearer 令牌鉴权。无需运行聊天页面或配置大模型密钥。

```bash
git clone https://github.com/zoumaxingjiulic/MCP_OA.git
cd MCP_OA
cp .env.example .env
# 编辑 .env，填写 OA 地址、账号、密码和随机 MCP_AUTH_TOKEN（openssl rand -hex 32）
docker compose up -d --build
```

智能体平台填写 MCP 地址及 `Authorization: Bearer <令牌>`。完整配置、端口映射、客户端代码和验证方法见 [Docker 部署说明](docs/docker-deployment.md)。

本地调试 HTTP 服务可运行 `npm run start:http`，默认监听 `127.0.0.1:3211`，同样要求 MCP_AUTH_TOKEN。保留 `npm start` 的 stdio 行为。

当前适配站点：`http://oa.sdthkj.com:9081`。2026-09-03 已通过真实 OA 的登录、人员查询和标准 MCP 客户端调用验证。

## 本地聊天验证页面

模型和 MCP 已在本机配置。启动后用浏览器提问：

```powershell
cd D:\vscodework\MCP_OA
npm run web
```

打开 [OA 聊天页面](http://127.0.0.1:3210)。默认模型为 `deepseek-v4-flash-0731`，接口为 `https://dashscope.aliyuncs.com/compatible-mode/v1`。模型凭据使用 `.env` 中的 `LLM_API_KEY`，不发送给浏览器。更换模型、地址或端口时修改 `.env` 的 `LLM_MODEL`、`LLM_BASE_URL`、`WEB_PORT`，再重启网页服务。

页面左侧显示连接配置，中间聊天，右侧显示本轮真实工具调用、参数、返回数据、耗时和 token 用量。可以点击示例问题，也可连续追问，例如先问“研发中心有多少人”，再问“那只算直属人员呢”。支持停止查询和新对话。

网页后端通过 **MCP SDK 的 stdio 客户端**启动现有 MCP 服务，使用 `tools/list` 获取工具定义，将定义提供给模型；收到模型的函数调用后，通过 `tools/call` 执行，再把结果交给模型生成回答。没有在网页中按问题文字硬编码查询，也不直接绕过 MCP 调用 OA。网页验证层只允许已审核的只读 `oa_search_contacts` 工具；以后添加工具时，需要同步修改该层允许列表。

网页仅监听 `127.0.0.1`，适合本机单人验证，不是对外部署的多用户服务。对话和调用内容只存于进程/页面内存；刷新页面开始新的对话，旧对话最多保留 1 小时，每段对话最多 20 轮。模型会接收你的问题及完成回答所需的 MCP 查询结果。浏览器只能读取脱敏连接状态，不能读取 `.env` 或 API Key。

端到端验证已通过：模型自动选择 `{"department":"研发中心","count_only":true}`，MCP 实时返回 51 人，模型据此回答。当前共有 29 项自动化测试，包含真实 stdio / HTTP MCP 协议、模型工具调用循环、连续对话、错误处理和接口凭据保护。

## 启动

需要 Node.js 22 或以上版本。本机依赖和 `.env` 已配置，可以直接使用。

```powershell
cd D:\vscodework\MCP_OA
npm ci
npm start
```

`npm start` 会等待 MCP 客户端从标准输入发送消息；终端没有提示属于正常情况。配置 MCP 客户端时直接运行 `node src/index.js`，避免 npm 的启动输出混入 MCP 协议。

首次复制到其他电脑时，先把 `.env.example` 复制为 `.env`，填写 OA 账号密码。程序固定从项目根目录读取 `.env`，不依赖客户端工作目录；环境变量优先，也可用 `OA_ENV_FILE` 指定其他配置文件。

## 连接 MCP 客户端

支持 `mcpServers` 格式的客户端可合并项目中的 `.mcp.json`：

```json
{
  "mcpServers": {
    "landray-oa": {
      "command": "node",
      "args": ["D:/vscodework/MCP_OA/src/index.js"]
    }
  }
}
```

VS Code 的工作区配置已放在 `.vscode/mcp.json`。将代码移动到其他目录时，需要更新 `.mcp.json` 中的绝对路径；VS Code 配置使用工作区变量，不需要修改。

本项目提供客户端配置文件，未更改其他客户端的全局配置。以上 stdio 模式由 MCP 客户端按需启动，不监听网络端口；HTTP 模式独立运行，连接方式见 Docker 部署说明。

## 工具用法

工具：`oa_search_contacts`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | string | 可选，姓名或手机号，1–100 字；人员搜索匹配规则由 OA 决定 |
| `department` | string | 可选，准确部门名称或完整路径，1–300 字；与 keyword 至少填一项 |
| `include_subdepartments` | boolean | 默认 true，包含全部下级部门；false 仅直属人员，必须指定部门 |
| `count_only` | boolean | 默认 false；只问人数时设 true，不加载或返回人员名片详情 |
| `page` | integer | 默认 1，范围 1–10000 |
| `page_size` | integer | 默认 15，范围 1–50 |

```json
{
  "keyword": "张三",
  "page": 1,
  "page_size": 15
}
```

连接后可以向助手说：“查询 OA 通讯录中张三的联系方式。”AI 根据工具描述和参数说明选择查询方向，服务端再调用对应 OA 接口，不猜测字符串是人名还是部门名。

常见调用：

| 问题 | 工具参数 |
| --- | --- |
| 王诚超属于哪个部门？ | `{"keyword":"王诚超"}` |
| 研发中心有哪些人？ | `{"department":"研发中心","page":1,"page_size":15}` |
| 研发中心有多少人？ | `{"department":"研发中心","count_only":true}` |
| 只算研发中心直属人员 | `{"department":"研发中心","include_subdepartments":false,"count_only":true}` |
| 信息中心有没有王诚超？ | `{"department":"信息中心","keyword":"王诚超"}` |

部门采用准确名称匹配。同名时返回 `AMBIGUOUS_DEPARTMENT` 和 `details.candidates`，使用其中的完整 `path` 重新传入 `department`，例如 `山东天河科技股份有限公司/研发中心`。不存在的部门会明确报错，已存在但没有人员的部门返回 `total: 0`。

输出同时提供 MCP 文本内容及 `structuredContent`。下例使用虚构数据：

```json
{
  "keyword": "张三",
  "department": null,
  "include_subdepartments": true,
  "count_only": false,
  "count_basis": "oa_directory",
  "page": 1,
  "page_size": 15,
  "total": 1,
  "returned": 1,
  "has_more": false,
  "contacts": [
    {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "name": "张三",
      "organization": null,
      "department": "示例部门",
      "position": "示例岗位",
      "mobile": "13800000000",
      "telephone": null,
      "short_number": null,
      "email": "test@example.com",
      "active": true,
      "contact_hidden": false,
      "department_hidden": false,
      "profile_url": "http://oa.example.com/sys/person/sys_person_zone/sysPersonZone.do?method=view&fdId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

空字段为 `null`；被 OA 标记为不公开的联系方式或部门信息同样返回 `null`，并通过 `contact_hidden` / `department_hidden` 表明隐藏状态。离职人员保留标识和姓名，屏蔽联系方式及组织信息。

`total` 是符合条件的总人数，`returned` 为当前页返回的详情人数。部门查询按人员 ID 去重；`department` 返回选中部门的 `id`、`name`、完整 `path`，纯人员查询时为 `null`。`include_subdepartments` 表明部门统计范围，`count_basis: "oa_directory"` 表示 OA 当前可见通讯录口径，**不等同于 HR 在职人数**。

普通查询使用 `has_more` 判断是否继续翻页。`count_only: true` 时返回 `total`，`contacts: []`、`returned: 0`、`has_more: false`，无需翻页统计，且不会加载人员详情；例如研发中心结果为 `total: 51`。

部门查询会读取所选部门范围的成员 ID 列表以去重，再对结果分页；排除下级部门时减去子部门成员并集。联合查询会先读取人员关键词的各页匹配 ID，再与部门成员取交集。两种列表均设 10000 条上限，超限明确报错，不返回部分统计。只对需要返回的当前页加载名片，最多同时 4 张。组织目录在进程内缓存 5 分钟，人员列表每次重新读取；组织调整后可重启服务立即刷新目录。

不指定部门时，仍调用原有姓名、手机号搜索接口。空查询条件会被拒绝，不会退化成全公司人员查询。

## 接口来源与范围

用户提供的 `/api/km-review/kmReviewRestServiceNew` 文档只包含：

- `addReview`：启动流程。
- `approveProcess`：审批流程。
- `updateReviewInfo`：更新流程表单。

该文档不包含通讯录接口，因此本工具使用已登录 OA 页面实际调用的人员搜索、组织树、部门人员列表和名片详情接口。它们是站点内部 Web 接口，流程服务的策略账号不用于通讯录登录。具体路径、认证及字段映射见 [接口适配说明](docs/oa-adapter.md)。

当前只注册通讯录查询工具。`.env` 的 `OA_POLICY_USERNAME` 和 `OA_POLICY_PASSWORD` 为以后实现 RestNew 流程工具预留，当前代码不读取或使用它们。

## 配置与运行行为

| 配置项 | 用途 |
| --- | --- |
| `OA_BASE_URL` | OA 根地址，可包含部署上下文，例如 `https://oa.example.com/ekp` |
| `OA_USERNAME` / `OA_PASSWORD` | OA 网页账号，用于查询该账号可见的通讯录 |
| `OA_TIMEOUT_MS` | 单次请求超时，默认 20000 毫秒，范围 1000–120000 |
| `OA_ENV_FILE` | 可选，指定环境配置文件路径 |

登录使用 OA 的动态公钥，以 SM2 C1C2C3 格式加密密码。Cookie 只保存在当前进程内存中，会话过期自动重登一次；并发请求共享登录过程。错误密码不会在一次查询中反复重试。

凭据仅存放在本地 `.env`，已被 `.gitignore` 排除；请勿把它复制进客户端配置或提交到仓库。代码不输出密码、Cookie、完整 OA 错误页或原始人员对象。

当前 OA 地址使用 HTTP，SM2 密码加密不等于全链路 TLS：会话 Cookie 和通讯录响应仍通过 HTTP 传输。若管理员提供 HTTPS 地址，更新 `OA_BASE_URL` 即可。

## 验证

```powershell
# 使用本地模拟 OA，验证真实 SM2 加解密、会话及 MCP 协议，不访问实际 OA
npm test

# 使用 .env，通过 stdio MCP 客户端连接真实 OA；默认查询当前登录账号
npm run smoke

# 指定姓名或手机号进行只读验证
npm run smoke -- 张三

# 查询部门人数（含下级），或仅直属人数
npm run smoke -- --department 研发中心 --count-only
npm run smoke -- --department 研发中心 --count-only --direct

# 在部门范围内找人
npm run smoke -- --department 信息中心 --keyword 王诚超
```

2026-09-03：19 项自动化测试通过，覆盖旧调用兼容、部门联合筛选、跨页去重、同名部门、直属人数、空部门、隐私和 MCP 协议。真实 stdio MCP 调用验证：研发中心含下级部门 51 人、直属 0 人；信息中心内查询王诚超返回 1 人，其直属部门为信息部。验证脚本只打印手机号是否存在，不打印号码。上述人数是验证时的 OA 记录，后续查询会重新统计。

更新到本版本后，重启或重新连接 MCP 服务，使客户端刷新工具参数定义。

| 错误码 | 处理方式 |
| --- | --- |
| `AUTH_FAILED` | 检查账号密码，或在 OA 网页处理验证码、密码变更要求 |
| `PERMISSION_DENIED` | 当前账号无访问权限，请联系 OA 管理员 |
| `NETWORK_ERROR` / `TIMEOUT` | 检查地址、网络、VPN 或超时配置 |
| `UPSTREAM_FORMAT_CHANGED` / `LOGIN_FORMAT_CHANGED` | OA 页面或接口有变化，需要调整适配器 |
| `PAGINATION_MISMATCH` | OA 未按请求分页，检查页码或站点升级情况 |
| `UNSAFE_REDIRECT` | OA 跳转到了另一个站点，检查根地址或 SSO 配置 |
| `DEPARTMENT_NOT_FOUND` | 使用准确部门名或完整路径 |
| `AMBIGUOUS_DEPARTMENT` | 从返回候选中选择完整路径重新查询 |
| `QUERY_TOO_BROAD` | 缩小部门或关键词范围；组织树最大 1000 次读取，人员列表最多 10000 条 |
| `DIRECTORY_CHANGED` | 分页期间 OA 人员总数发生变化，重试以重新统计 |

认证、权限和响应解析错误会返回 MCP `isError: true`，不会当成“没有匹配人员”。

## 项目结构

```text
src/config.js          环境配置
src/oa-client.js       HTTP、SM2 登录、会话和通讯录查询
src/directory.js       搜索页解析、人员字段与隐私标记映射
src/organization.js    组织树、部门定位、成员去重及直属范围计算
src/server.js          MCP 工具注册、输入输出 Schema
src/index.js           stdio 入口
src/http.js            HTTP 服务启动与退出
src/http-server.js     Streamable HTTP、Bearer 鉴权及请求校验
Dockerfile             非 root Docker 镜像
compose.yaml           内网服务器端口映射与运行配置
scripts/smoke.js       真实 OA 的 MCP 端到端验证
scripts/smoke-http.js  HTTP MCP 客户端验证
web/server.js         本地网页服务与接口
web/chat-service.js   大模型工具调用循环、MCP 客户端与会话
web/public/           聊天界面与调用记录面板
test/oa.test.js        模拟 OA 及协议测试
test/http.test.js      HTTP MCP 协议、鉴权与并发测试
test/web.test.js       网页与模型工具调用测试（不消耗真实模型额度）
docs/oa-adapter.md     已验证的接口行为和扩展边界
docs/docker-deployment.md Docker 部署与平台接入指南
```

依赖使用 [官方 MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) 和 [sm-crypto-v2](https://github.com/Cubelrti/sm-crypto-v2)，安装版本由 `package-lock.json` 锁定。
