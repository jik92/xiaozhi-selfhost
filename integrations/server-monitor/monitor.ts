import { z } from 'zod';

export const monitorConfigSchema = z.object({
  grafanaUrl: z.string().url().default('https://monitor.ounirobot.com').refine(value => { const u = new URL(value); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }, 'Grafana 地址只能为 HTTPS 源站或本机测试地址'),
  orgId: z.number().int().positive().default(1), datasourceUid: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default('prometheus'),
  grafanaTokenFile: z.string().min(1).default('grafana.token'),
  expectedNodeCount: z.number().int().min(1).max(100).default(5),
  expectedNodes: z.array(z.string().min(1).max(120)).max(100).default([]),
  maxAgeSeconds: z.number().int().min(30).max(600).default(120),
  thresholds: z.object({ cpu: z.number().min(1).max(100).default(80), memory: z.number().min(1).max(100).default(85), disk: z.number().min(1).max(100).default(85), critical: z.number().min(1).max(100).default(95) }).default({ cpu: 80, memory: 85, disk: 85, critical: 95 }),
});
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export const QUERIES = {
  node_up: 'up{job="node-exporter"} and (timestamp(up{job="node-exporter"}) > time() - 120)',
  cpu: '100 - (avg by (node) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m])) * 100)',
  memory: '(1 - node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"}) * 100',
  disk: '(1 - node_filesystem_avail_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{job="node-exporter",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}) * 100',
  network_rx_bps: 'sum by (node) (rate(node_network_receive_bytes_total{job="node-exporter",device!~"lo|docker.*|veth.*|br-.*"}[5m])) * 8',
  network_tx_bps: 'sum by (node) (rate(node_network_transmit_bytes_total{job="node-exporter",device!~"lo|docker.*|veth.*|br-.*"}[5m])) * 8',
  cadvisor_up: 'up{job="cadvisor"} and (timestamp(up{job="cadvisor"}) > time() - 120)',
  containers: 'count by (node) (container_last_seen{job="cadvisor",image!=""} > (time() - 120))',
  pg_exporter_up: 'up{job="postgres-exporter-primary"} and (timestamp(up{job="postgres-exporter-primary"}) > time() - 120)', pg_up: 'pg_up{job="postgres-exporter-primary"} and (timestamp(pg_up{job="postgres-exporter-primary"}) > time() - 120)',
  pg_connections: 'sum(pg_stat_database_numbackends{job="postgres-exporter-primary"})',
  pg_connections_percent: '100 * sum(pg_stat_database_numbackends{job="postgres-exporter-primary"}) / max(pg_settings_max_connections{job="postgres-exporter-primary"})',
  redis_exporter_up: 'up{job="redis-exporter-shared"} and (timestamp(up{job="redis-exporter-shared"}) > time() - 120)', redis_up: 'redis_up{job="redis-exporter-shared"} and (timestamp(redis_up{job="redis-exporter-shared"}) > time() - 120)',
  redis_memory_bytes: 'redis_memory_used_bytes{job="redis-exporter-shared"}', redis_clients: 'redis_connected_clients{job="redis-exporter-shared"}',
} as const;
type Query = keyof typeof QUERIES;
interface Sample { name: string; value: number; timestamp: number; }
export interface Metric { value: number; timestamp: number; }
export interface NodeStatus { name: string; scrape: 'up' | 'down' | 'unknown'; containerScrape: 'up' | 'down' | 'unknown'; cpu: Metric | null; memory: Metric | null; disk: Metric | null; networkRxBps: Metric | null; networkTxBps: Metric | null; containers: Metric | null; }
export interface MonitorReport {
  queriedAt: string; source: string; status: 'ok' | 'warning' | 'critical' | 'unknown';
  expectedNodes: number; discoveredNodes: number; scrapeUp: number; nodes: NodeStatus[];
  services: { name: string; scrape: 'up' | 'down' | 'unknown'; health: 'up' | 'down' | 'unknown'; metrics: Record<string, Metric | null> }[];
  alerts: { severity: 'warning' | 'critical'; message: string }[]; unknowns: string[]; speech: string;
  thresholds: MonitorConfig['thresholds'];
}
function samples(result: any, now: number, age: number): Sample[] {
  if (result?.error || (result?.status && result.status !== 200)) return [];
  const found: Sample[] = [];
  for (const frame of (Array.isArray(result?.frames) ? result.frames : []).slice(0, 200)) {
    const fields = frame?.schema?.fields; const values = frame?.data?.values;
    if (!Array.isArray(fields) || !Array.isArray(values)) continue;
    const timeIndex = fields.findIndex((f: any) => f.type === 'time');
    for (let i = 0; i < fields.length; i++) {
      if (fields[i]?.type !== 'number' || !Array.isArray(values[i])) continue;
      const index = values[i].length - 1; const value = values[i][index]; const timestamp = values[timeIndex]?.[index];
      if (typeof value !== 'number' || !Number.isFinite(value) || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp > now + 30000 || now - timestamp > age * 1000) continue;
      const name = String(fields[i].labels?.node || fields[i].labels?.instance || 'aggregate');
      found.push({ name, value, timestamp });
    }
  }
  return found;
}
const metric = (sample?: Sample): Metric | null => sample ? { value: Math.round(sample.value * 100) / 100, timestamp: sample.timestamp } : null;
function worst(samples: Sample[]): 'up' | 'down' | 'unknown' { return samples.length ? samples.reduce((a, b) => a.value < b.value ? a : b).value === 1 ? 'up' : 'down' : 'unknown'; }
export function summarize(data: any, config: MonitorConfig, now = Date.now()): MonitorReport {
  const series = Object.fromEntries(Object.keys(QUERIES).map(key => [key, samples(data.results?.[key], now, config.maxAgeSeconds)])) as Record<Query, Sample[]>;
  const names = new Set([...config.expectedNodes, ...(['node_up', 'cpu', 'memory', 'disk', 'cadvisor_up', 'containers'] as Query[]).flatMap(key => series[key].map(s => s.name))]);
  names.delete('aggregate');
  const alerts: MonitorReport['alerts'] = []; const unknowns: string[] = [];
  for (const key of Object.keys(QUERIES) as Query[]) if (!data.results?.[key] || data.results[key].error || (data.results[key].status && data.results[key].status !== 200)) unknowns.push(`${key} 查询失败或未返回`);
  const nodes: NodeStatus[] = [...names].sort().map(name => {
    const find = (key: Query) => series[key].filter(s => s.name === name);
    const percentage = (key: 'cpu' | 'memory' | 'disk') => {
      const candidates = find(key).filter(s => s.value >= 0 && s.value <= 100);
      return metric(candidates.sort((a, b) => b.value - a.value)[0]);
    };
    const node: NodeStatus = { name, scrape: worst(find('node_up')), containerScrape: worst(find('cadvisor_up')), cpu: percentage('cpu'), memory: percentage('memory'), disk: percentage('disk'), networkRxBps: metric(find('network_rx_bps')[0]), networkTxBps: metric(find('network_tx_bps')[0]), containers: metric(find('containers')[0]) };
    if (node.scrape === 'down') alerts.push({ severity: 'critical', message: `${name} 节点采集不可达，不代表已确认服务器关机` });
    if (node.containerScrape === 'down') alerts.push({ severity: 'warning', message: `${name} 容器采集不可达` });
    if (node.containerScrape === 'unknown' || !node.containers) unknowns.push(`${name} 容器指标缺失或过期`);
    if (node.scrape === 'unknown') unknowns.push(`${name} 节点采集状态缺失或过期`);
    for (const key of ['cpu', 'memory', 'disk'] as const) {
      const label = { cpu: 'CPU', memory: '内存', disk: '根分区磁盘' }[key]; const m = node[key];
      if (!m) unknowns.push(`${name} ${label}指标缺失或过期`);
      else if (node.scrape === 'up' && m.value >= config.thresholds[key]) alerts.push({ severity: m.value >= config.thresholds.critical ? 'critical' : 'warning', message: `${name} ${label}使用率 ${m.value}%` });
    }
    return node;
  });
  if (nodes.length < config.expectedNodeCount) unknowns.push(`预期 ${config.expectedNodeCount} 个节点，只发现 ${nodes.length} 个`);
  const services: MonitorReport['services'] = [
    { name: 'PostgreSQL RDS', scrape: worst(series.pg_exporter_up), health: worst(series.pg_up), metrics: { connections: metric(series.pg_connections[0]), connectionUsagePercent: metric(series.pg_connections_percent[0]) } },
    { name: 'Redis', scrape: worst(series.redis_exporter_up), health: worst(series.redis_up), metrics: { memoryBytes: metric(series.redis_memory_bytes[0]), clients: metric(series.redis_clients[0]) } },
  ];
  for (const service of services) {
    if (service.scrape === 'down' || service.health === 'down') alerts.push({ severity: 'critical', message: `${service.name}${service.scrape === 'down' ? '采集异常' : '连接探测异常'}` });
    if (service.scrape === 'unknown' || service.health === 'unknown') unknowns.push(`${service.name}状态指标缺失或过期`);
  }
  const status = alerts.some(a => a.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : unknowns.length || !nodes.length ? 'unknown' : 'ok';
  const scrapeUp = nodes.filter(n => n.scrape === 'up').length;
  const speech = `刚刚检查了服务器监控，${nodes.length} 个节点中有 ${scrapeUp} 个采集在线。${alerts.length ? '需要注意：' + alerts.slice(0, 4).map(a => a.message).join('；') + '。' : '已返回的指标未触发告警阈值。'}${unknowns.length ? `还有 ${unknowns.length} 项指标缺失或过期，不能确认全部正常。` : ''}`;
  return { queriedAt: new Date(now).toISOString(), source: new URL(config.grafanaUrl).origin, status, expectedNodes: config.expectedNodeCount, discoveredNodes: nodes.length, scrapeUp, nodes, services, alerts, unknowns, speech, thresholds: config.thresholds };
}
export class GrafanaMonitor {
  private cached?: { at: number; value: MonitorReport }; private inflight?: Promise<MonitorReport>;
  constructor(public config: MonitorConfig, private token: string, private request: typeof fetch = fetch, private now = Date.now) {}
  async overview(signal?: AbortSignal): Promise<MonitorReport> {
    if (this.cached && this.now() - this.cached.at < 15000) return structuredClone(this.cached.value);
    if (!this.inflight) {
      this.inflight = this.load(signal).then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.inflight = undefined; });
    }
    return structuredClone(await this.inflight);
  }
  private async load(signal?: AbortSignal) {
    const response = await this.request(new URL('/api/ds/query', this.config.grafanaUrl), { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Grafana-Org-Id': String(this.config.orgId) },
      body: JSON.stringify({ from: 'now-5m', to: 'now', queries: Object.entries(QUERIES).map(([refId, expr]) => ({ refId, expr, datasource: { type: 'prometheus', uid: this.config.datasourceUid }, instant: true, range: false, format: 'table', intervalMs: 15000, maxDataPoints: 1 })) }) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Grafana 拒绝访问，请检查只读 Token 和数据源权限' : `Grafana 查询失败（HTTP ${response.status}）`);
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (!reader) throw new Error('Grafana 返回空响应');
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1048576) { await reader.cancel(); throw new Error('Grafana 查询响应过大'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let data: any; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Grafana 返回格式无效'); }
    if (!data || typeof data.results !== 'object') throw new Error('Grafana 返回缺少指标结果');
    return summarize(data, this.config, this.now());
  }
}
