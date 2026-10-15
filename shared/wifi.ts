export interface WifiNetwork { ssid: string; signal: number; band: '2.4GHz' | '5/6GHz' }
export interface WifiScan { networks: WifiNetwork[]; warning?: string }
