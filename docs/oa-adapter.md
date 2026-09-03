# OA 通讯录接口适配记录

验证日期：2026-09-03。站点：`http://oa.sdthkj.com:9081`。

## 认证

1. `GET /login.jsp`，建立登录会话。
2. 同一 Cookie 会话中请求 `GET /resource/js/session.jsp`，提取 `window.getSM2PubKey()` 的公钥字符串；不执行远程 JavaScript。
3. 按站点 `/resource/js/security.js` 与 `/resource/js/sm2.js` 的格式组装密码：三个 Unicode 字符 `\u534d\u3220\u4d45` + `04` + SM2 C1C2C3 加密结果（十六进制）。
4. `POST /j_acegi_security_check`，表单类型 `application/x-www-form-urlencoded`，字段为 `j_username`、`j_password`、`j_redirectto`。
5. 使用登录后 Cookie 查询人员。站点首页返回跳转门户的脚本，程序无需加载门户即可访问通讯录。

这是用户正常网页登录流程的 HTTP 实现，未使用浏览器自动化、持久化 Cookie 或额外认证凭据。当前接口不需要策略 Basic 认证。

只跟随同源重定向，最多 5 次。对于 401、登录页面或跳回登录页的脚本，重新认证后最多重试查询一次；403 直接返回权限错误。

## 搜索人员

```http
GET /sys/zone/sys_zone_personInfo/sysZonePersonInfo.do?method=getPersons&fdSearchName=<姓名或手机号>&searchPeople=true&pageno=1&rowsize=15
```

来源：已登录门户的“找人”搜索跳转。它返回 HTML，而非 REST JSON。

在 `.search_person_wrap` 中，各个 `lui/data/source!AjaxJson` 配置提供人员详情路径及 `fdId`。`#pageChange script[type="text/config"]` 中的 JSON 提供：

```json
{
  "currentPage": "1",
  "pageSize": "15",
  "totalSize": "1",
  "viewSize": "2"
}
```

程序以此解析实际页码、页大小、总数和人员 ID，不猜测总数，不执行页面脚本。返回人员数与分页信息不一致时直接报格式错误，避免悄悄漏人。

现场验证过：当前账号手机号搜索、姓名搜索、姓氏模糊搜索、`pageno=2&rowsize=2` 分页。该接口的 `fdSearchName` 不支持部门名称，因此统一工具通过独立的 `department` 参数路由至下述部门查询流程。`keyword` 和 `department` 同时提供时，以人员 ID 对两类结果取交集，再执行输出分页。

## 组织结构与部门人员

已登录“员工黄页”的 `/sys/zone/tree.jsp` 使用 `/resource/js/treeview.js` 中的组织树数据源：

```http
GET /sys/common/treexml.jsp?s_bean=organizationTree&parent=<父节点ID>&orgType=organizationTree&fdId=<父节点ID>
```

根层的 `parent`、`fdId` 均为空。响应是 `dataList` XML，各 `data` 节点以 `value` 表示组织 ID、`text` 表示名称。逐级构建完整路径，按名称或完整路径准确定位；同名时返回候选，禁止静默选中第一个。仅解析 XML，不执行脚本或解析外部实体。树读取最多并发 4 次、累计 1000 次，成功目录在进程中缓存 5 分钟。

人员列表来源于同一黄页组织树节点链接：

```http
GET /sys/zone/sys_zone_personInfo/sysZonePersonInfo.do?method=listPersons&parentId=<组织ID>&pageno=1&rowsize=100
```

此接口返回 HTML，现场确认包含所选组织及全部下级组织人员。从 `tr[kmss_href]` 的 `method=view&fdId=...` 链接读取人员 ID；用页面“共 N 条”、`pagenoText2` 和 `rowsizeText2` 校验分页与记录数。不将 HTML 中的原始联系方式直接作为工具结果。

读取所选范围的全部页并按 ID 去重。`include_subdepartments=false` 时，从父组织成员集合中减去直接子组织各自递归成员集合的并集，得到直属人员；不使用可能重名的部门名称做排除依据。

`count_only=true` 仍需要读取必要的成员 ID 来准确去重及筛选，但不请求名片详情接口。人数是当前账号可见的 OA 通讯录口径，不添加未验证的“在职”过滤。人员列表超过 10000 条报范围错误；分页总数发生变化报 `DIRECTORY_CHANGED`，不返回部分统计。接口不提供事务快照，同总数的同时调动仍可能影响跨页读取，组织调整期间可重新查询核对。

真实 MCP 验证（2026-09-03）：研发中心含下级组织 51 人，直属 0 人；信息中心与关键词“王诚超”联合查询 1 人，名片直属部门为信息部。

## 人员详情

```http
GET /sys/person/sys_person_zone/sysPersonZone.do?method=info&fdId=<搜索结果中的人员ID>
```

来源：搜索结果中人员名片的 AjaxJson 配置。返回 JSON。

| OA 字段 | MCP 字段 |
| --- | --- |
| `fdId` | `id` |
| `fdName` | `name` |
| `fdOrgName` | `organization` |
| `fdDeptName` | `department` |
| `fdPostName` | `position` |
| `fdMobileNo` | `mobile` |
| `fdWorkPhone` | `telephone` |
| `fdShortNo` | `short_number` |
| `fdEmail` | `email` |
| `fdIsAvailable` | `active` |
| `isContactPrivate` | `contact_hidden` 并屏蔽联系字段 |
| `isDepInfoPrivate` | `department_hidden` 并屏蔽组织字段 |

当隐私字段明确为 `null` 或 false 时，沿用页面逻辑允许显示；字段缺失时保守隐藏该组信息。离职人员的两组信息均隐藏。原始响应中的头像、性别、第三方平台 ID、关注信息等不返回给 MCP。

人员详情链接使用同一路径的 `method=view`。只接受从人员搜索页或部门列表读出的 32 位十六进制人员 ID，详情 ID 不匹配时返回错误。

## 与 RestNew 文档的关系

提供的系统注册服务为：

```text
名称：流程启动RestNew
访问路径：/api/km-review/kmReviewRestServiceNew
服务标识：kmReviewRestServiceNew
实现类：com.landray.kmss.km.review.webservicenew.KmReviewWebserviceServiceNewImp
```

文档描述 `addReview`、`approveProcess` 和 `updateReviewInfo`，其中人员组织架构 JSON 用于指定发起人、审批人等，并不是通讯录查询接口。

该服务路径未认证 GET 实际返回 HTTP 401；本次没有调用三个业务方法，也未验证策略账号能否操作流程。以后扩展流程功能时应单独实现策略认证和文档要求的 multipart 表单，不能将本次网页会话适配自动视为 RestNew 的认证规范。

当前通讯录能力依赖上述站点内部 Web 接口。OA 升级改变页面结构或登录协议时可能需要重新适配；若后续提供官方通讯录 REST 服务文档，可替换 `OaClient.searchContacts` 的内部实现，保留 MCP 工具契约。
