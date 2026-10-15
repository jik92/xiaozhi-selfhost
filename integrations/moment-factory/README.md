# 欧尼博 MCP HTTP 适配

本目录属于小智独立项目，不修改或导入相邻 registry 仓库源码。
适配器使用标准 MCP Streamable HTTP 访问 registry 的独立 Platform Bridge。
ESP32 通过小智网关调用工具，不直接访问这里的回环地址。

## 基础连接

在项目根目录执行，创建私有 Token（已有文件时保留）：

```sh
mkdir -p data/moment
[ -f data/moment/mcp.token ] || (umask 077; openssl rand -hex 32 > data/moment/mcp.token)
bun run mcp:moment
```

在工作台 MCP 页面添加 HTTP 服务，地址为 `http://127.0.0.1:8792/mcp`，
Token 填上述文件内容，不加 Bearer。可设置 `MOMENT_VOICE_PORT` 和
`MOMENT_VOICE_TOKEN_FILE` 覆盖默认值。

未配置业务身份时，仅提供 `get_current_time` 和 `moment_connection_status`。
测试用语：“你好小智，请调用欧尼博查询上海现在的日期和时间。”
`connected=true` 表示适配入口可用；`businessReady=false` 表示没有可用的业务查询工具。

## 连接有身份的 registry

registry 的独立 Bridge 仍由 registry 自己启动，例如它原有的 `bun run business-mcp`。
需要按该仓库要求配置独立 Agent 的正式 IAM 身份、私有 Token、精确 operation 白名单、
审计文件与签名密钥。此项目不读取 Runtime 数据库，不复制真人会话。
上游必须保持 `MOMENT_WRITE_MODE=disabled`。

复制本目录 `config.example.json` 为 `data/moment/config.json`，填写实际配置：

- `url`：独立 Bridge 的 MCP 地址，默认本机 `http://127.0.0.1:8791/mcp`。
- `signingKeyFile`：与 Bridge 配置一致的私有签名密钥文件；相对于配置文件解析。
- `scope`：明确授权给小智的 Agent、identityRef 和业务租户命名空间，不猜测 ID。
- `allowedTools`：从 `read-tools.json` 挑选少量必需的只读工具；默认不会启用整个清单。

配置和密钥必须归当前用户所有，权限 0600，不能是符号链接。

```sh
chmod 600 data/moment/config.json data/moment/bridge-signing.key
MOMENT_VOICE_CONFIG=data/moment/config.json bun run mcp:moment
```

`read-tools.json` 记录本次核对的 registry 提交、契约摘要和 32 个只读 operation 名称。
只有上游工具声明的契约摘要与该清单一致时才发布工具，契约漂移时停止发布。
它仅限制语音入口的能力范围，不是 IAM 授权，也不代表这些工具已经可用。
未复制 registry 的业务实现、生成 SDK 或完整 OpenAPI。

模型只接收业务 `input`。每次 HTTP 请求重新签发两分钟上下文令牌，调用 grant 精确绑定
工具、参数和随机 actionKey；服务端固定身份，不让模型设置上下文、Token 或目标 URL。
每次发现与执行均经过上游 IAM 校验，所有业务审计由 registry 持久化。
发现失败返回不可用；撤销后的工具不能继续调用。请求不自动重试业务调用。

此适配目前只支持查询，不支持报障、派单、关闭、付款等写入，也不能替代 Runtime
对聊天室来源消息的授权证据。业务验收必须使用真实已授权目标并检查 Platform 回读。
所有 Token、配置、数据库、声纹模型和设备备份均不得上传 Git。
