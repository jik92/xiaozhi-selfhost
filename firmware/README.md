# 固件来源与板型

## FoloToy AI Passport

打开 `http://localhost:18080/#flash`，设备板型选择 **FoloToy AI Passport**（ESP32-C3、8 MB）。已经运行兼容小智固件时可选「仅配置本地连接」；从其他应用切换时选择「完整固件」和内置 Passport 小智 `v2.5.0-folo.1`，Passport 仅提供内置固件。填写 2.4 GHz Wi-Fi 后选择串口并刷写。

内置镜像来自 [FoloToy 固件发布](https://github.com/FoloToy/folo-ai-passport-xiaozhi/releases/tag/v2.5.0-folo.1)，存放于 `public/firmware/`，附带 LICENSE / NOTICE。大小 7,616,468 字节，SHA-256：`b51eb892c702debef613b9705e617db155aeeb7ea0e20331d44c55d2c4e21518`，加载时校验。固件为 Passport 小智版本。

适配基准固定为上述发布标签的提交 `05b36eb2493967caaf87cdfeda83946e1f0c5d78`。已对照该版本的 `main/ota.cc`（`wifi.ota_url`）、`main/settings.cc`（字符串/i32 类型）及两种传输实现。发布分区表为 `partitions/v2/8m.csv`：NVS `0x9000/0x4000`、OTA data `0xd000/0x2000`、应用 `0x20000/0x2f0000` 和 `0x310000/0x2f0000`、资源 `0x600000/0x200000`。

工具不会根据同为 C3 自动判定板型。会检查芯片 ID、容量、Passport 标识、分区边界及应用完整性；板型字符串检查不能替代可信固件来源。写入前下载原 NVS 备份，再将保留的 NVS 与本地配置嵌入合并镜像，一起写入并由 esptool 校验 MD5，随后回读 NVS。NVS 扩容或裁去全空页可直接迁移；缩小后没有空闲页或需移动有效条目时，按原顺序压缩迁移全部有效记录（含命名空间、原始类型、blob 分块及载荷），确保至少保留一页供 ESP-IDF 回收。有效数据无法装入时停止。这样避免 `main/main.cc` 中 `ESP_ERR_NVS_NO_FREE_PAGES` 引发自动擦除配置。当前要求设备具有有效的默认 `0x8000` 分区表及可读取的非加密 NVS，不支持空白或加密 Flash。

该发布构建关闭语音唤醒（`CONFIG_USE_ESP_WAKE_WORD=n`）。联网后按 OK 键切换对话，上/下键调节音量；不能以“说唤醒词没有响应”判断刷写失败。

完成后释放串口并复位，页面收到本次刷写后的 OTA 请求或设备在线才显示 100%。90 秒内未接入会提示排查 Wi-Fi、防火墙与本地 OTA 地址。若自动复位失败，拔插 USB。浏览器串口选择框需要手动选择设备。

验证包括构建、自动回归、模拟串口全流程及真实浏览器页面；实机刷写、启动、屏幕、音频和联网对话需要连接 Passport 后验证。

## WHA103

当前设备：WHA103Board、ESP32-C3、16MB Flash、128×64 OLED。厂商固件已有音频和显示驱动，本项目可保留这些驱动并写入本地连接配置。

当前检查的 `78/xiaozhi-esp32` 主分支没有 WHA103Board 板级实现。不能用“同为 ESP32-C3”作为替代驱动的依据；需要知道 I2C、I2S、Codec、屏幕和按键的引脚，以及真实分区布局。

如果取得对应源码，使用它指定的 ESP-IDF 版本；官方当前主分支要求 ESP-IDF >=6.0.1，推荐 6.1，而厂商旧分支可能不同。

官方源码的常规编译方式：

```sh
source /path/to/esp-idf/export.sh
cd /path/to/xiaozhi-esp32
python3 scripts/build.py --list-boards
python3 scripts/build.py <已确认的板型目录> --name <具体构建名称> --language zh-CN
```

如需修改引脚，应创建新的板型或构建变体，不覆盖其他板型的身份。固件默认 OTA 地址应设置为你的本地接口；浏览器刷写后会再次写入持久化 OTA 地址。

把构建得到、从地址 `0x0` 开始的 `build/merged-binary.bin` 上传到控制台。工具检查芯片 ID、大小和 NVS 分区，无法检查每个 GPIO 是否适合当前硬件，因此仍需提供真正匹配的板型固件。

`firmware/` 不存放原设备完整 Flash。原 Flash/NVS 可能包含网络密码和设备令牌，应保存在私有备份目录。

## 待机唤醒词与服务端设置

对照本地 `xiaozhi-esp32` 的 `main/Kconfig.projbuild`、`main/audio/wake_words/esp_wake_word.cc` 和 `custom_wake_word.cc`：

- ESP32-C3 采用 WakeNet 模型检测唤醒词，词条由实际安装的模型决定。无法仅写一个 NVS 字符串或修改网关前缀来增加“小维”。
- MultiNet 的 `CUSTOM_WAKE_WORD`、`CUSTOM_WAKE_WORD_DISPLAY` 和阈值设置要求 ESP32-S3/P4/S31 与 PSRAM，不适用于当前 WHA103 / ESP32-C3。支持该方案的固件也可从资源包的 `index.json` 读取命令配置。
- 设备检测到唤醒词后，通过 `listen` / `state: detect` / `text` 上报给服务器；部分配置仅进入聆听，不上报此事件。

对照 `xiaozhi-esp32-server` 的 `config.yaml` 和 `core/handle/textHandler/listenMessageHandler.py`，`wakeup_words` 用于服务器区分唤醒词与普通讲话，`enable_greeting` 控制开场回复；它们不更新设备唤醒模型。本工作台的「设备唤醒后的回复」处理设备上报事件，「语音前缀过滤」处理 ASR 结果，两者都不配置待机唤醒模型。

若需让当前 C3 待机识别“小维”，应先取得兼容该词条的 WakeNet 模型，以及厂商对模型分区/资源更新的说明；需要更换完整固件时，还必须有 WHA103 的正确板级驱动。当前项目未实现该模型的生成、更新或实机验证。
