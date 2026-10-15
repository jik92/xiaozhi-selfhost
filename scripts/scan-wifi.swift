import Foundation
import CoreWLAN

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

do {
    guard let wifi = CWWiFiClient.shared().interface() else {
        output(["error": "未找到本机 Wi-Fi 网卡"])
        exit(0)
    }
    guard wifi.powerOn() else {
        output(["error": "请先开启电脑的 Wi-Fi"])
        exit(0)
    }
    let scanned = try wifi.scanForNetworks(withName: nil)
    let networks: [[String: Any]] = scanned.compactMap { network in
        guard let ssid = network.ssid, !ssid.isEmpty else { return nil }
        return ["ssid": ssid, "signal": network.rssiValue, "band": network.wlanChannel?.channelBand == .band2GHz ? "2.4GHz" : "5/6GHz"]
    }
    output(["networks": networks, "warning": networks.isEmpty ? "未获取到可见 Wi-Fi 名称。请检查附近网络；macOS 可能需要在系统设置 → 隐私与安全性 → 定位服务中允许启动服务的终端或应用访问位置，也可手动输入。" : ""])
} catch {
    output(["error": "Wi-Fi 扫描失败，请检查无线网卡及 macOS 定位权限，也可手动输入网络名称。"])
}
