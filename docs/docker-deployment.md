# Docker 内网部署

部署的是独立 OA MCP 服务，提供 Streamable HTTP `/mcp`。不需要大模型 API Key，也不启动 3210 聊天页面。智能体平台负责模型、聊天上下文及 MCP 客户端连接。

## 1. 获取代码和配置

服务器需要 Docker Engine 和 Docker Compose v2，并能访问 OA。执行：

```bash
git clone https://github.com/zoumaxingjiulic/MCP_OA.git
cd MCP_OA
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

将生成的随机字符串填入 `.env` 的 `MCP_AUTH_TOKEN`，并填写：

```dotenv
OA_BASE_URL=http://your-oa-server:9081
OA_USERNAME=your_oa_account
OA_PASSWORD='your_oa_password'
MCP_AUTH_TOKEN=填入上一步生成的随机字符串
MCP_PUBLISHED_PORT=3211
MCP_BIND_IP=0.0.0.0
```

密码含 `$`、`#` 等字符时使用单引号，避免 Compose 插值。OA 密码与 MCP 访问令牌用途不同。不要提交 `.env`；镜像构建上下文仅包含源码与依赖清单，不包含凭据、人员记录、测试页面或日志。Compose 只向容器传递 OA 和 MCP 所需变量。

## 2. 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 oa-mcp
curl --fail http://127.0.0.1:3211/healthz
```

健康接口只返回 `{"status":"ok"}`，表示 HTTP 进程可用，不会登录 OA，不能代替真实查询验证。首次构建需要访问 Docker Hub 和 npm；隔离网络需预先构建并导入镜像。

默认将服务器的 3211 映射到容器的 3211，容器程序监听 `0.0.0.0:3211`。修改对外端口只需改 `MCP_PUBLISHED_PORT`，不必修改容器端口。程序以非 root 身份运行，根文件系统只读，Cookie 和目录缓存保存在内存。

## 3. 配置智能体平台

假设服务器 IP 为 `192.168.1.100`：

| 项目 | 填写内容 |
| --- | --- |
| 名称 | OA 通讯录 |
| 传输方式 | Streamable HTTP（不是旧版 SSE） |
| 地址 | `http://192.168.1.100:3211/mcp` |
| 请求头 | `Authorization: Bearer <MCP_AUTH_TOKEN 的实际值>` |
| 工具调用超时 | 建议 120 秒；较大部门首次查找可能较慢 |

不同平台的 JSON 字段名可能不同，以平台配置界面为准。必须由支持 MCP 的客户端完成初始化、`tools/list` 和 `tools/call`；`/mcp` 不是把自然语言直接 POST 过去就能得到回答的聊天接口。服务使用无状态 HTTP 请求，不发放 MCP 会话 ID；GET、DELETE 返回 405 是正常行为，不影响工具调用。

如果平台自己实现 MCP 客户端，Node.js 示例：

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent-platform', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.OA_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
  }));
  const tools = await client.listTools();
  const result = await client.callTool({
    name: 'oa_search_contacts',
    arguments: { department: '信息部', count_only: true },
  }, undefined, { timeout: 120000 });
  // 将工具定义交给模型，将调用结果交回模型生成回答。
} finally {
  await client.close();
}
```

这里的 OA_MCP_URL 是平台端连接参数，不是 MCP 服务端配置。

## 4. 网络及鉴权

- 通过服务器 IP 和映射端口连接：两个容器无需同属一个 Docker 网络，服务器防火墙须允许平台访问此端口。
- 同一个自定义 Docker 网络：也可使用 `http://oa-mcp:3211/mcp`，并删除 Compose 的 `ports`，仅供容器间访问。
- 平台容器内的 `127.0.0.1` 指向平台自身，不能代替 MCP 服务器地址。
- 平台后端通常不发送 Origin。若客户端携带 Origin，必须在 `MCP_ALLOWED_ORIGINS` 配置精确来源（如 `https://agent.example.com`），默认拒绝所有携带未知 Origin 的请求。不提供浏览器跨域 CORS 接口；访问令牌应保留在平台后端。
- 本版本提供预共享 Bearer 令牌认证，不提供 OAuth 登录。平台需支持自定义 Authorization 请求头。
- 示例 HTTP 适用于受信任的隔离内网。跨不受信任网络时在前方配置 HTTPS 反向代理；令牌和人员数据不应明文跨网传输。代理需保留 Authorization、Accept 和 MCP 协议相关请求头，并将读取超时设为至少 120 秒。
- 当前一个 MCP 实例使用一个 OA 账号，所有持有访问令牌的调用方共享该账号的通讯录权限；尚未实现各平台用户分别登录 OA。

## 5. 验证与更新

在装有 Node.js 22+ 的电脑上，从项目目录执行（`.env` 中填同一个 MCP 访问令牌）：

```bash
npm ci
# 只验证连接、初始化和工具发现，不访问 OA
npm run smoke:http -- http://192.168.1.100:3211/mcp
# 再进行实际的只读部门人数查询
npm run smoke:http -- http://192.168.1.100:3211/mcp 信息部
```

连接成功后，在平台中提问“信息部有多少人”“信息部有哪些人”，查看实际工具调用参数和结果。

更新服务器：

```bash
git pull --ff-only
docker compose up -d --build
```

修改密码或轮换令牌后，同样执行 `docker compose up -d` 使容器重建；平台同步更新令牌。停止服务用 `docker compose down`，不会删除宿主机 `.env`。

常见问题：401 为令牌缺失或错误；403 为 Origin 未允许；405 多为误选旧 SSE 或在浏览器地址栏访问 `/mcp`；503 表示并发请求达到 32，稍后重试。OA 查询错误会作为 MCP 工具错误返回，健康检查仍可能正常。
