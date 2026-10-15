# 固件来源与板型

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
