# 小智本地工作台

用 Chrome 连接 ESP32，在一个界面里完成串口配置、固件刷写、设备对话、AI 设置、声纹和 MCP 调试。

**Bun + React + Ant Design + Tailwind CSS**。网关由 TypeScript 实现，不需要部署两套参考项目、MySQL 或 Redis。SQLite 保存设置与记录；本地声纹模型是可选组件。

## 启动

需要 Bun 1.3+、FFmpeg，以及电脑上的 Chrome / Edge。

```sh
# macOS 安装音频转换依赖；已经安装可跳过
brew install ffmpeg

cd xiaozhi-selfhost
bun install --frozen-lockfile
bun run build
bun start
```

打开 **http://localhost:18080**。

开发时运行 `bun dev`：前端 http://localhost:5178，Bun 网关 :18080。开发端口与生产服务不能同时占用。

默认端口：

| 服务 | 端口 / 地址 |
| --- | --- |
| 本机管理界面、OTA、设备 WebSocket | TCP 18080 |
| OTA | `http://电脑局域网IP:18080/xiaozhi/ota/` |
| 设备 WebSocket | `ws://电脑局域网IP:18080/xiaozhi/v1/` |
| 内置 MQTT 3.1.1 设备网关 | TCP 18883 |
| 加密 UDP 音频 | UDP 18884 |

`PORT`、`MQTT_PORT`、`UDP_PORT`、`DATA_DIR`、`FFMPEG_PATH`、`VOICEPRINT_MODEL` 可通过环境变量覆盖。开发模式 Vite 默认代理 :18080；修改 PORT 时同步修改 Vite 代理。

## 让 WHA103 连接本地

1. 电脑和小智连接同一个可互访的局域网。在「AI 设置」确认本机局域网 IP，不能填写 `localhost`。
2. 用 Chrome 打开上面的 **localhost** 地址，在「串口刷写」点击「选择串口」。浏览器的设备选择和串口授权需要本人操作。
3. 推荐选择「保留固件 · 配置本地连接」。选择 WebSocket 或 MQTT+UDP；Wi-Fi 留空会保留已有网络。
4. 点击「写入本地配置并重启」。工具先下载原 NVS 备份，再追加本地连接参数、校验并重启。
5. 收到设备真实的 OTA 请求后才标记为接入成功。WebSocket 通常在唤醒设备后才建立；去「设备与对话」查看状态。

配置过程写入 `wifi.ota_url`、WebSocket 与 MQTT 参数；保留其他 NVS 条目和非 NVS 分区。设备令牌在本机生成，通过本地 OTA 下发，无需小智官方账号。切换协议后需要重新配置或让设备重新读取 OTA。

**当前串口自动配置适配 WHA103 / ESP32-C3、ESP-IDF NVS v2、0x8000 分区表与厂商固件的 `wifi.ssid/password` 配置。** 不是所有 ESP32 板子的通用配网器。加密 NVS、损坏分区、空间不足、其他芯片都会拒绝写入；不会猜测引脚或擦除整片 Flash。

已有可用固件也可不使用串口：先在「设备与对话」登记 MAC，再在小智配网页面高级选项填入本地 OTA 地址并重启。

## 完整固件刷写

界面支持上传板型匹配、从 `0x0` 开始的完整合并 `.bin`。刷写前验证芯片 ID、容量和 NVS 分区兼容性，刷写时使用 MD5 校验，最后回读配置。自动备份的是 NVS，**不是整片 Flash**；首次更换厂商固件前请单独备份完整 Flash。

本项目不附带假定适配 WHA103 的通用固件。已经检查的官方上游没有 WHA103 板型源码，不能安全地把其他 C3 固件当成它的驱动。现有设备可以先使用「保留固件」模式。完整编译需要厂商板级源码或确认过的引脚定义，见 [firmware/README.md](firmware/README.md)。

整个操作通过浏览器 `esptool-js` / Web Serial 完成；Bun 后端不占用串口。测试和启动项目不会自动刷写硬件。

## AI 对话

在「AI 设置」中保存并测试：

- 大模型：OpenAI 兼容 `/chat/completions`，可配置 UAT 网关或自己的模型服务。
- 语音识别：Qwen ASR 多模态接口，或 OpenAI/Whisper 兼容 `/audio/transcriptions`。
- 语音合成：Edge TTS，或 OpenAI 兼容 `/audio/speech`。FFmpeg 转为 24kHz 单声道 PCM，再按设备协商帧长编码 Opus。
- 本地断句：RMS 音量检测、可配置静音时间。支持 `manual` 输入结束和自动断句；这不是神经网络 VAD，也没有实现服务器 AEC。
- 唤醒回复：设备通过 `listen/detect.text` 上报固件识别到的唤醒词后，网关直接播报「设备唤醒后的回复」（默认“我在，请说。”），留空关闭。按钮进入聆听不会触发此回复。
- 语音前缀过滤：在「AI 设置 → 唤醒与语音输入」填写，例如 `小智`。每轮识别结果须以此前缀开头，网关移除前缀及后续标点，再将指令交给模型；不匹配或仅说前缀时不回复。留空关闭前缀限制，网页文字对话不受影响。此功能依赖设备已上传音频，不改变固件的待机唤醒词。
- 对话保留最近若干轮上下文；模型可调用已配置的远程和设备 MCP 工具。每轮最多执行四轮工具调用。

API Key 保存在仅当前用户可读的 `data/xiaozhi.sqlite` 中，管理 API 只返回掩码。也可用 `AI_API_KEY`、`AI_MODEL`、`ASR_API_KEY` 设置初始值；已有的数据库设置优先。

「自建网关」不等于完全离线。默认 Edge TTS 会访问微软服务，云模型和云 ASR 会访问配置的服务商。要全内网运行，应为这些位置填写对应的内网兼容服务。

## 本地声纹

```sh
bun run setup:voiceprint
```

从 sherpa-onnx 官方 Release 下载约 28MB 的 3D-Speaker CAMPPlus ONNX 模型到 `data/models/speaker.onnx`。`sherpa-onnx-node` 是可选平台依赖，当前实现已在 macOS arm64 + Bun 下验证。也可以导入已有模型：

```sh
bun run setup:voiceprint /绝对路径/兼容的声纹模型.onnx
```

在「声纹识别」选择「本地模型」，开启识别，添加说话人并上传至少 3 秒清晰录音。独立 Worker 提取 192 维特征，SQLite 保存特征，使用余弦相似度匹配已登记说话人；原始样本音频不会保存到数据库。

也支持外部兼容服务，Base URL 不含接口路径：

- `POST /voiceprint/register`：Bearer 认证，multipart `speaker_id` + `file`（16kHz 单声道 WAV）。
- `POST /voiceprint/identify`：Bearer 认证，multipart `speaker_ids`（逗号分隔）+ `file`，返回 `{ "speaker_id": "...", "score": 0.8 }`。

外部接口格式参考 Python 项目并增加登记约定；如果已有服务格式不同，需要对应适配，不会自动假定兼容 Go 项目的所有声纹接口。删除本地说话人只移除本地记录，不删除外部服务中的档案。

## MCP 与主动音频

欧尼博 registry 的独立 HTTP 适配、启动和身份配置见 [integrations/moment-factory/README.md](integrations/moment-factory/README.md)。适配代码在本项目内，不需要修改 registry 源码。

「MCP 工具」支持 Streamable HTTP 和旧版 SSE，可设置 Bearer Token、发现工具、查看参数并执行调用。设备端 MCP 走小智协议的 `type: mcp`，自动初始化并读取工具，支持本地调试和模型调用。

「设备与对话」提供三种下发方式：

- 发送对话：文字 → 模型 → TTS → 设备。
- 直接播报：文字 → TTS → 设备。
- 上传音频：WAV/MP3 等 → FFmpeg → Opus → 设备。

支持停止、打断、设备重连清理，音频按帧长节奏发送。**设备必须在线且音频通道已经打开**；MQTT+UDP 还需要设备先发送音频以建立 UDP 回程地址。不会把离线下发或尚未建立 UDP 通道标为播放成功。当前不实现离线队列或远程唤醒。

## 协议实现与范围

WebSocket 支持小智 v1 原始 Opus、v2 16 字节头、v3 4 字节头。MQTT 3.1.1 提供设备连接、用户名/密码认证、QoS 0/1 上行、订阅和心跳；设备主题按身份隔离。它是专用设备网关，不是完整的通用 MQTT Broker，不提供 QoS 2、持久会话或 retained 消息。

MQTT 控制配合 16 字节包头、AES-128-CTR UDP 音频，校验长度和序列号并丢弃重放包，匹配固件端协议。该协议本身没有认证加密；本项目面向可信局域网，不把这些端口直接发布到公网。管理 API 和页面限制本机访问。

OTA 只返回当前版本和本地连接参数，不自动升级固件；刷写完整固件通过浏览器执行。没有实现视觉、知识库、声音克隆或完整多租户管理。

## 检查

```sh
bun run check
bun test
bun run build
```

集成测试使用真实 TCP/WebSocket/UDP 连接和 Opus/FFmpeg，AI 使用本地测试替身，覆盖语音上行到模型与音频下行、主动播报、MCP HTTP 调用、OTA 认证与密钥遮蔽、断线清理。NVS 测试覆盖 CRC、覆盖更新、页切换、损坏数据和空间不足。测试不会访问串口或使用真实 API Key。

浏览器串口授权、实际 Flash 写入以及设备麦克风/喇叭的物理表现，需要真实设备验收；模拟设备测试不能替代这些检查。

## 文件结构

```text
src/                 React 控制台与浏览器串口工具
server/              Bun 网关、会话、AI、MCP、本地声纹 Worker
shared/              数据契约与 ESP-IDF NVS 编解码
tests/               单元测试与网络集成测试
scripts/             开发启动、模型安装
integrations/        独立 MCP 接入适配（欧尼博 HTTP Bridge）
firmware/            固件适配说明，不包含厂商二进制
data/                SQLite、声纹模型、运行数据（Git 忽略）
```

备份 `data/` 可保留设置、设备凭据、声纹特征和聊天记录。不要把数据库、NVS 备份、厂商完整 Flash 或密钥上传到公共仓库。

## 参考与致谢

这是独立的 Bun/TypeScript 实现，没有复制参考项目的服务端源代码或模型权重到代码仓库。协议与功能设计参考：

- [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)（本地检查版本 `d7a1c05`）：固件端协议、OTA 与持久化配置。
- [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)（`27399a2`）：OTA、声纹接口、AI 组件分工。
- [hackers365/xiaozhi-esp32-server-golang](https://github.com/hackers365/xiaozhi-esp32-server-golang)（`21f1a2e`）：MQTT+UDP 会话、主动音频与声纹能力。
- [espressif/esptool-js](https://github.com/espressif/esptool-js)：浏览器刷写，Apache-2.0。
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)：本地声纹运行时，Apache-2.0；模型授权按其原发布者说明执行。

本项目代码采用 MIT 许可证；第三方依赖与模型保留各自授权。
