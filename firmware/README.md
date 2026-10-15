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
