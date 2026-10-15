# 服务器监控 MCP

独立 Bun 进程，以 Streamable HTTP 提供四个只读工具。小智通过已有外部 MCP 机制调用，再用当前角色与音色播报；不需要重新刷固件。地址、组织和数据源复用 `folotoy-flasher/firmware/ounirobot-monitor` 的监控配置：`https://monitor.ounirobot.com`、组织 `1`、数据源 `prometheus`。

## 启动与配置

从项目根目录执行。依赖使用项目已安装的 MCP SDK 和 Zod。

```sh
mkdir -p data/server-monitor
chmod 700 data/server-monitor
cp integrations/server-monitor/config.example.json data/server-monitor/config.json
chmod 600 data/server-monitor/config.json
# 将 Grafana Viewer 服务账户 Token 写入 data/server-monitor/grafana.token（单行）
chmod 600 data/server-monitor/grafana.token
bun run mcp:monitor
```

服务默认绑定 `http://127.0.0.1:8793/mcp`，首次启动自动生成私有 `data/server-monitor/mcp.token`。在工作台「MCP」中添加 HTTP 服务，填上述地址和该文件中的 Token。Grafana Token 与 MCP Token 不同，都不应提交 Git 或发给模型。

本机已配置 `xiaozhi-server-monitor` Viewer 服务账户和凭据，已注册到工作台。该 Grafana Token 有效期 90 天；到期后从 Grafana 服务账户管理页生成替代凭据，更新 `grafana.token` 后重启此独立进程。原项目从设备 NVS 读取凭据，不修改原设备或它的连接。

可覆盖 `SERVER_MONITOR_CONFIG`（默认 `data/server-monitor/config.json`）、`SERVER_MONITOR_PORT`（8793）、`SERVER_MONITOR_TOKEN_FILE`。配置内的 `grafanaTokenFile` 相对于配置文件目录；启动路径相对于项目根目录。配置和凭据必须为当前用户所有、普通文件、权限 0600，拒绝符号链接。

## 使用

对小智说：「检查我的服务器状态并播报」「检查 UAT 服务器的磁盘」「现在服务器有什么告警」。也可以在 AI 定时任务中填写「调用服务器监控工具，检查所有服务器，按当前角色简短播报告警和缺失数据」。服务和小智网关均需保持运行，设备须能联网接收语音。MQTT 待机播报使用现有任务通知通道，已验证设备请求了音频；固件没有播放完成确认。网页普通文字对话仍依赖 UDP 音频通道，需先唤醒设备建立通道。

工具：`server_monitor_overview`（完整概览）、`server_monitor_node`（精确节点名称）、`server_monitor_alerts`（告警摘要）、`server_monitor_connection_status`（真实查询验证）。所有工具仅允许固定查询，不能传入任意 URL、PromQL 或服务器命令。

指标包含节点采集、CPU（5 分钟平均）、内存、根分区磁盘、网络速率、容器采集及近期容器数量、PostgreSQL 连接探测/连接数、Redis 连接探测/内存/客户端数。容器数量不等于应用健康，节点采集不可达不等于服务器关机。数据库健康使用 `pg_up` / `redis_up`，不只看 exporter 是否可达。

默认 CPU 告警 80%，内存/根磁盘 85%，严重告警 95%。预期五台节点的完整名称保存在配置中，防止消失的节点被漏报。缺失/失败/过期数据会明确标为未知，不会报告“全部正常”。采集和数据库探测的原始样本超过 120 秒时剔除；其他指标为 Prometheus 即时查询结果，CPU/网络为 5 分钟变化率。结果缓存 15 秒，Grafana 请求超时 12 秒，响应上限 2 MiB。监控查询失败不会使用旧缓存冒充新数据。

协议参考：[Grafana 服务账户](https://grafana.com/docs/grafana/latest/administration/service-accounts/)、[HTTP API 认证](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/authentication/)。
