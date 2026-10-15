import { Children, useEffect, useRef, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Flex, Form, Grid, Input, InputNumber, Layout, Menu, Modal, Progress, Row, Select, Slider, Space, Spin, Statistic, Switch, Table, Tag, Typography, Upload } from 'antd';
import { ApiOutlined, AudioOutlined, CheckOutlined, DashboardOutlined, DeleteOutlined, DisconnectOutlined, ExperimentOutlined, FileTextOutlined, LinkOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SendOutlined, SoundOutlined, StopOutlined, ThunderboltOutlined, UploadOutlined, UsbOutlined } from '@ant-design/icons';
import type { Json, Settings, Snapshot } from '../shared/types';
import { api, post, upload } from './api';
import { SerialFlasher, type ChipInfo } from './serial';

type Page = 'overview' | 'flash' | 'devices' | 'ai' | 'voice' | 'mcp' | 'logs';
const pages = [
  { key: 'overview', label: '概览', icon: <DashboardOutlined/> },
  { key: 'flash', label: '串口刷写', icon: <UsbOutlined/> },
  { key: 'devices', label: '设备与对话', icon: <RobotOutlined/> },
  { key: 'ai', label: 'AI 设置', icon: <ExperimentOutlined/> },
  { key: 'voice', label: '声纹', icon: <AudioOutlined/> },
  { key: 'mcp', label: 'MCP', icon: <ApiOutlined/> },
  { key: 'logs', label: '日志', icon: <FileTextOutlined/> },
];
const states: Record<string, string> = { offline: '未连接', ready: '已接通 OTA', connected: '已连接', idle: '待命', listening: '聆听中', recognizing: '识别中', thinking: '思考中', speaking: '播报中' };
const shortTime = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
function Status({ online, text }: { online: boolean; text: string }) { return <Badge status={online ? 'success' : 'default'} text={text}/>; }
function Panel({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) { return <Card size="small" title={title} extra={extra}>{children}</Card>; }
function Columns({ children, count = 2 }: { children: React.ReactNode; count?: number }) {
  return <Row gutter={[12, 12]}>{Children.toArray(children).map((child, i) => <Col key={i} xs={24} md={count === 3 ? 12 : 24 / count} xl={24 / count}>{child}</Col>)}</Row>;
}
function useSnapshot() {
  const [data, setData] = useState<Snapshot>(); const [connected, setConnected] = useState(false); const [error, setError] = useState('');
  async function refresh() { try { setData(await api<Snapshot>('/snapshot')); setError(''); } catch (e) { setError(String(e)); } }
  useEffect(() => {
    let ws: WebSocket; let retry: ReturnType<typeof setTimeout>; let stopped = false;
    function connect() {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events`);
      ws.onopen = () => { setConnected(true); setError(''); };
      ws.onmessage = event => {
        const e = JSON.parse(event.data); if (e.type === 'snapshot') { setData(e.data); return; }
        setData(d => {
          if (!d) return d;
          if (e.type === 'log') return { ...d, logs: [...d.logs, e.data].slice(-150) };
          if (e.type === 'message') return { ...d, messages: [...d.messages, e.data].slice(-200) };
          if (e.type === 'device') return { ...d, devices: [...d.devices.filter(v => v.id !== e.data.id), e.data] };
          if (e.type === 'settings') return { ...d, settings: e.data };
          return d;
        });
      };
      ws.onclose = () => { setConnected(false); if (!stopped) retry = setTimeout(connect, 2500); };
      ws.onerror = () => { setError('无法连接本地服务，请检查 Bun 后端是否已启动。'); ws.close(); };
    }
    connect(); const timer = setInterval(refresh, 15000);
    return () => { stopped = true; clearTimeout(retry); clearInterval(timer); ws.close(); };
  }, []);
  return { data, connected, error, refresh };
}

export default function App() {
  const initial = location.hash.slice(1); const [page, setPage] = useState<Page>(pages.some(p => p.key === initial) ? initial as Page : 'overview');
  const { data, connected, error, refresh } = useSnapshot();
  const screens = Grid.useBreakpoint();
  function navigate(p: Page) { location.hash = p; setPage(p); }
  useEffect(() => { const listener = () => { const key = location.hash.slice(1); if (pages.some(p => p.key === key)) setPage(key as Page); }; addEventListener('hashchange', listener); return () => removeEventListener('hashchange', listener); }, []);
  return <Layout style={{ minHeight: '100vh' }}>
    <Layout.Header style={{ height: 'auto', lineHeight: 'normal', padding: '0 16px', background: 'var(--ant-color-bg-container)' }}>
      <Flex align="center" justify="space-between" gap={12} style={{ minHeight: 44 }}>
        <Space><RobotOutlined/><Typography.Text strong>小智本地工作台</Typography.Text></Space>
        <Space><Badge status={connected ? 'success' : 'error'} text={screens.sm ? (connected ? '网关在线' : '网关离线') : undefined}/><Button icon={<ReloadOutlined/>} onClick={refresh} aria-label="刷新状态"/></Space>
      </Flex>
      <Menu mode="horizontal" selectedKeys={[page]} items={pages} onClick={({ key }) => navigate(key as Page)}/>
    </Layout.Header>
    <Layout.Content style={{ padding: screens.sm ? 16 : 8, width: '100%', maxWidth: 1440, margin: '0 auto' }}>
      <Flex vertical gap={12}>
        {error && <Alert type="error" showIcon title={error}/>}
        {!data ? <Card><Flex align="center" justify="center" gap={12}><Spin/><Button onClick={refresh}>重新连接</Button></Flex></Card> : <>
          {page === 'overview' && <Overview data={data} navigate={navigate}/>}
          <div hidden={page !== 'flash'}><Flash data={data} refresh={refresh} navigate={navigate}/></div>
          {page === 'devices' && <Devices data={data} refresh={refresh}/>}
          {page === 'ai' && <AiSettings data={data} refresh={refresh}/>}
          {page === 'voice' && <Voice data={data} refresh={refresh}/>}
          {page === 'mcp' && <Mcp data={data} refresh={refresh}/>}
          {page === 'logs' && <Logs data={data}/>}
        </>}
      </Flex>
    </Layout.Content>
  </Layout>;
}

function Overview({ data, navigate }: { data: Snapshot; navigate: (p: Page) => void }) {
  return <Flex vertical gap={12}>
    <Row gutter={[12, 12]}>{[
      { title: '在线设备', value: data.devices.filter(d => d.online).length, suffix: `/ ${data.devices.length}` },
      { title: '对话记录', value: data.messages.filter(m => m.role === 'user').length },
      { title: 'MCP 服务', value: data.endpoints.length },
      { title: '已登记声纹', value: data.speakers.filter(s => s.enrolled).length },
    ].map(s => <Col key={s.title} xs={12} md={6}><Card size="small"><Statistic {...s}/></Card></Col>)}</Row>
    <Columns>
      <Panel title="设备" extra={<Space><Button onClick={() => navigate('flash')} icon={<UsbOutlined/>}>连接设备</Button><Button onClick={() => navigate('devices')}>对话</Button></Space>}>
        <Table rowKey="id" size="small" dataSource={data.devices} pagination={false} scroll={{ x: 400 }} columns={[
          { title: '名称', dataIndex: 'name' }, { title: '板型', dataIndex: 'board' },
          { title: '状态', render: (_, d) => <Status online={d.online} text={states[d.state] || d.state}/> },
        ]}/>
      </Panel>
      <Panel title="AI 服务" extra={<Button onClick={() => navigate('ai')}>设置</Button>}>
        <Descriptions size="small" column={1} items={[
          { key: 'llm', label: '大模型', children: <Space><Typography.Text>{data.settings.llm.model}</Typography.Text><Tag color={data.settings.llm.apiKey ? 'green' : 'default'}>{data.settings.llm.apiKey ? '已配置' : '未配置'}</Tag></Space> },
          { key: 'asr', label: '语音识别', children: <Space><Typography.Text>{data.settings.asr.model}</Typography.Text><Tag color={data.settings.asr.apiKey ? 'green' : 'default'}>{data.settings.asr.apiKey ? '已配置' : '未配置'}</Tag></Space> },
          { key: 'tts', label: '语音合成', children: <Space><Typography.Text>{data.settings.tts.type === 'edge' ? 'Edge TTS' : data.settings.tts.model}</Typography.Text><Tag color={data.health.ffmpeg ? 'green' : 'orange'}>{data.health.ffmpeg ? 'FFmpeg 就绪' : '缺少 FFmpeg'}</Tag></Space> },
        ]}/>
      </Panel>
    </Columns>
    <Panel title="接入地址"><Descriptions size="small" column={{ xs: 1, sm: 1, md: 2 }} items={[
      { key: 'ota', label: 'OTA', children: <Typography.Text copyable>{data.connection.otaUrl}</Typography.Text> },
      { key: 'ws', label: 'WebSocket', children: <Typography.Text copyable>{data.connection.websocketUrl}</Typography.Text> },
    ]}/></Panel>
    <Panel title="最近日志" extra={<Button onClick={() => navigate('logs')}>全部日志</Button>}><EventList logs={data.logs.slice(-5).reverse()}/></Panel>
  </Flex>;
}
function EventList({ logs }: { logs: Snapshot['logs'] }) {
  const colors: Record<string, string> = { info: 'blue', success: 'green', warn: 'orange', error: 'red' };
  return <Table rowKey="id" size="small" dataSource={logs} pagination={false} scroll={{ x: 640 }} columns={[
    { title: '时间', dataIndex: 'time', width: 90, render: shortTime },
    { title: '模块', dataIndex: 'scope', width: 100 },
    { title: '级别', dataIndex: 'level', width: 75, render: v => <Tag color={colors[v]}>{({ info: '信息', success: '成功', warn: '提醒', error: '错误' } as Record<string, string>)[v]}</Tag> },
    { title: '内容', dataIndex: 'message', render: v => <Typography.Text style={{ overflowWrap: 'anywhere' }}>{v}</Typography.Text> },
  ]}/>;
}

function Flash({ data, refresh, navigate }: { data: Snapshot; refresh: () => void; navigate: (p: Page) => void }) {
  const { message } = AntApp.useApp(); const [logs, setLogs] = useState<string[]>(['小智本地刷写工具已就绪。', '连接设备后，系统会识别芯片并备份 NVS 配置。']); const [chip, setChip] = useState<ChipInfo>();
  const [progress, setProgress] = useState(0); const [stage, setStage] = useState('等待连接串口'); const [busy, setBusy] = useState(false); const [mode, setMode] = useState('config'); const [firmware, setFirmware] = useState<File>();
  const [transport, setTransport] = useState<'websocket' | 'mqtt'>(data.settings.defaultTransport); const [ssid, setSsid] = useState(''); const [password, setPassword] = useState(''); const [waiting, setWaiting] = useState<{ id: string; since: number }>(); const [monitoring, setMonitoring] = useState(false);
  const logBottom = useRef<HTMLDivElement>(null); const flasher = useRef<SerialFlasher | null>(null);
  if (!flasher.current) flasher.current = new SerialFlasher(text => setLogs(l => [...l, text].slice(-200)), (value, text) => { setProgress(value); setStage(text); });
  useEffect(() => { logBottom.current?.scrollIntoView({ block: 'nearest' }); }, [logs]);
  useEffect(() => () => { void flasher.current?.disconnect(); }, []);
  useEffect(() => {
    if (!waiting) return;
    const device = data.devices.find(d => d.id === waiting.id && d.lastSeen >= waiting.since && (d.state === 'ready' || d.online));
    if (device) { setWaiting(undefined); setProgress(100); setStage(device.online ? '设备已连接本地环境' : '本地 OTA 已接通，唤醒设备开始对话'); message.success('设备已接入你的本地环境'); }
  }, [data.devices, waiting]);
  useEffect(() => { if (!waiting) return; const timer = setTimeout(() => { setWaiting(undefined); setStage('尚未收到设备接入，请检查 Wi-Fi 与本机防火墙'); message.warning('配置已写入，但尚未验证本地连接。可以打开串口日志排查。'); }, 90000); return () => clearTimeout(timer); }, [waiting]);
  async function run(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (e) { const text = e instanceof Error ? e.message : String(e); setLogs(l => [...l, `[错误] ${text}`]); setStage('操作未完成'); message.error(text); } finally { setBusy(false); refresh(); } }
  async function flash() { const since = Date.now(); const id = await flasher.current!.flash({ transport, ssid: ssid || undefined, password: ssid ? password : undefined, firmware: mode === 'firmware' ? firmware : undefined }); setPassword(''); setWaiting({ id, since }); }
  const supported = 'serial' in navigator && window.isSecureContext;
  return <Flex vertical gap={12}>
    {!supported && <Alert type="warning" showIcon title="请使用 Chrome / Edge 通过 localhost 访问串口"/>}
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={14}><Panel title="串口刷写" extra={<Tag>WHA103 / ESP32-C3</Tag>}>
        <Flex vertical gap={12}>
          <Flex wrap align="center" justify="space-between" gap={8}>
            <Typography.Text>{chip ? `${chip.name} · ${chip.mac} · ${chip.flashSize / 1048576} MB` : '未连接串口'}</Typography.Text>
            {chip ? <Button disabled={busy} onClick={() => run(async () => { await flasher.current!.disconnect(); setChip(undefined); setStage('等待连接串口'); })} icon={<DisconnectOutlined/>}>释放串口</Button> : <Button type="primary" disabled={!supported || monitoring} loading={busy} icon={<UsbOutlined/>} onClick={() => run(async () => { setChip(await flasher.current!.connect()); })}>选择串口</Button>}
          </Flex>
          <Form layout="vertical" disabled={busy}>
            <Form.Item label="刷写内容" tooltip="选择串口会重启设备并进入下载模式。写入前自动备份 NVS。"><Select value={mode} onChange={setMode} options={[{ label: '仅配置本地连接', value: 'config' }, { label: '完整固件', value: 'firmware' }]}/></Form.Item>
            {mode === 'firmware' && <Form.Item label="固件" extra="选择匹配 WHA103、从 0x0 开始的合并固件。"><Upload accept=".bin" maxCount={1} beforeUpload={file => { setFirmware(file); return false; }} onRemove={() => setFirmware(undefined)}><Button icon={<UploadOutlined/>}>选择 .bin 文件</Button></Upload></Form.Item>}
            <Form.Item label="连接协议"><Select value={transport} onChange={setTransport} options={[{ label: 'WebSocket', value: 'websocket' }, { label: 'MQTT + UDP', value: 'mqtt' }]}/></Form.Item>
            <Form.Item label="OTA 地址" tooltip="设备与电脑需在同一局域网。"><Typography.Text copyable>{data.connection.otaUrl}</Typography.Text></Form.Item>
            <Columns><Form.Item label="Wi-Fi 名称"><Input autoComplete="off" value={ssid} onChange={e => setSsid(e.target.value)} placeholder="留空保留已有网络" maxLength={32}/></Form.Item><Form.Item label="Wi-Fi 密码"><Input.Password autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="2.4GHz Wi-Fi" disabled={!ssid || busy} maxLength={64}/></Form.Item></Columns>
          </Form>
          <Button type="primary" icon={<ThunderboltOutlined/>} disabled={!chip || (mode === 'firmware' && !firmware) || !!waiting || monitoring} loading={busy} onClick={() => run(flash)}>{mode === 'config' ? '写入配置并重启' : '刷写固件并重启'}</Button>
          <Typography.Text type="secondary">写入前自动备份 NVS</Typography.Text>
        </Flex>
      </Panel></Col>
      <Col xs={24} lg={10}><Flex vertical gap={12}>
        <Panel title="进度"><Typography.Text>{stage}</Typography.Text><Progress percent={progress} status={busy || waiting ? 'active' : 'normal'}/>{progress === 100 && <Button onClick={() => navigate('devices')}>设备与对话</Button>}</Panel>
        <Panel title="串口日志" extra={<Space><Button onClick={() => setLogs([])}>清空</Button><Button disabled={busy || !!waiting || !supported} onClick={async () => { if (monitoring) { await flasher.current!.disconnect(); setMonitoring(false); setChip(undefined); } else { setMonitoring(true); setChip(undefined); try { await flasher.current!.readLogs(); } catch (e) { message.error(String(e)); } finally { setMonitoring(false); } } }}>{monitoring ? '停止监听' : '监听日志'}</Button></Space>}>
          <pre className="console-output">{logs.join('\n')}<span ref={logBottom}/></pre>
        </Panel>
      </Flex></Col>
    </Row>
  </Flex>;
}

function Devices({ data, refresh }: { data: Snapshot; refresh: () => void }) {
  const { message } = AntApp.useApp(); const [selected, setSelected] = useState(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [register, setRegister] = useState(false); const [mac, setMac] = useState(''); const [protocol, setProtocol] = useState('websocket'); const [tools, setTools] = useState<Json[]>([]); const [tool, setTool] = useState(''); const [args, setArgs] = useState('{}'); const [result, setResult] = useState('');
  const id = selected || data.devices[0]?.id; const device = data.devices.find(d => d.id === id); const chatEnd = useRef<HTMLDivElement>(null);
  const messages = data.messages.filter(m => m.deviceId === id); useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest' }); }, [data.messages]);
  async function action(kind: string) { if (!id) return; setBusy(true); try { await post(`/devices/${encodeURIComponent(id)}/${kind}`, { text }); if (kind !== 'abort') setText(''); message.success(kind === 'abort' ? '已停止播报' : '请求已提交，结果见对话和日志'); } catch (e) { message.error(String(e)); } finally { setBusy(false); } }
  return <Row gutter={[12, 12]}>
    <Col xs={24} lg={6}><Panel title="设备" extra={<Button icon={<PlusOutlined/>} onClick={() => setRegister(true)}>登记</Button>}>
      {data.devices.length ? <Menu mode="inline" selectedKeys={id ? [id] : []} onClick={({ key }) => { setSelected(key); setTools([]); setTool(''); setResult(''); }} items={data.devices.map(d => ({ key: d.id, label: <Space><Badge status={d.online ? 'success' : 'default'}/>{d.name}</Space>, title: `${d.board} · ${d.id}` }))}/> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备"/>}
      {device && <Descriptions size="small" column={1} style={{ marginTop: 12 }} items={[
        { key: 'mac', label: 'MAC', children: device.id }, { key: 'board', label: '板型', children: device.board || '未知' },
        { key: 'firmware', label: '固件', children: device.firmware || '待上报' },
        { key: 'frames', label: '音频帧', children: `↑ ${device.inputFrames} / ↓ ${device.outputFrames}` },
        ...(device.speaker ? [{ key: 'speaker', label: '说话人', children: device.speaker }] : []),
      ]}/>}
    </Panel></Col>
    <Col xs={24} lg={18}><Flex vertical gap={12}>
      <Panel title={<Space>{device?.name || '设备对话'}{device && <Status online={device.online} text={states[device.state] || device.state}/>}</Space>} extra={device && <Tag>{device.transport === 'mqtt' ? 'MQTT + UDP' : 'WebSocket'}</Tag>}>
        <Flex vertical gap={12}>
          <div className="chat-history">{messages.length ? messages.map(m => <Card size="small" key={m.id} style={{ marginBottom: 8 }}>
            <Flex vertical gap={4}><Space><Typography.Text strong>{m.role === 'user' ? m.speaker || '用户' : m.role === 'broadcast' ? '播报' : '小智'}</Typography.Text><Typography.Text type="secondary">{shortTime(m.time)}</Typography.Text></Space><Typography.Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</Typography.Text></Flex>
          </Card>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={device?.online ? '暂无对话' : '请先唤醒设备'}/>}<div ref={chatEnd}/></div>
          <Input.TextArea value={text} onChange={e => setText(e.target.value)} placeholder="输入对话或播报内容" autoSize={{ minRows: 2, maxRows: 5 }} maxLength={4000}/>
          <Flex justify="space-between" wrap gap={8}>
            <Upload accept="audio/*" showUploadList={false} beforeUpload={file => { void upload(`/devices/${encodeURIComponent(id!)}/audio`, file).then(() => message.success('音频已提交')).catch(e => message.error(String(e))); return false; }} disabled={!device?.online}><Button disabled={!device?.online} icon={<UploadOutlined/>}>上传音频</Button></Upload>
            <Space wrap><Button disabled={!device?.online} icon={<StopOutlined/>} onClick={() => action('abort')}>停止</Button><Button disabled={!device?.online || !text.trim()} loading={busy} icon={<SoundOutlined/>} onClick={() => action('speak')}>播报</Button><Button type="primary" disabled={!device?.online || !text.trim()} loading={busy} icon={<SendOutlined/>} onClick={() => action('chat')}>发送</Button></Space>
          </Flex>
        </Flex>
      </Panel>
      <Panel title="设备工具" extra={<Button disabled={!device?.online} icon={<ReloadOutlined/>} onClick={async () => { try { setTools((await api(`/devices/${encodeURIComponent(id!)}/tools`)).tools); } catch (e) { message.error(String(e)); } }}>读取工具</Button>}>
        <Flex vertical gap={8}><Select placeholder="选择工具" value={tool || undefined} options={tools.map(t => ({ label: t.name, value: t.name }))} onChange={setTool}/><Input.TextArea value={args} onChange={e => setArgs(e.target.value)} rows={2} placeholder="参数 JSON"/><Button style={{ alignSelf: 'flex-start' }} disabled={!device?.online || !tool} icon={<PlayCircleOutlined/>} onClick={async () => { try { setResult(JSON.stringify(await post(`/devices/${encodeURIComponent(id!)}/call`, { name: tool, arguments: JSON.parse(args) }), null, 2)); } catch (e) { message.error(String(e)); } }}>调用</Button>{result && <pre className="console-output">{result}</pre>}</Flex>
      </Panel>
    </Flex></Col>
    <Modal title="登记设备" open={register} onCancel={() => setRegister(false)} onOk={async () => { try { await post('/provision', { id: mac.trim().toLowerCase(), transport: protocol, board: 'wha103' }); setRegister(false); refresh(); message.success('已登记，请在设备配网页面设置 OTA 地址'); } catch (e) { message.error(String(e)); } }}>
      <Form layout="vertical"><Form.Item label="设备 OTA 地址"><Typography.Text copyable>{data.connection.otaUrl}</Typography.Text></Form.Item><Form.Item label="MAC 地址"><Input value={mac} onChange={e => setMac(e.target.value)} placeholder="aa:bb:cc:dd:ee:ff"/></Form.Item><Form.Item label="协议"><Select value={protocol} onChange={setProtocol} options={[{ label: 'WebSocket', value: 'websocket' }, { label: 'MQTT + UDP', value: 'mqtt' }]}/></Form.Item></Form>
    </Modal>
  </Row>;
}

function AiSettings({ data, refresh }: { data: Snapshot; refresh: () => void }) {
  const [form] = Form.useForm<Settings>(); const { message } = AntApp.useApp(); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(''); const [testResult, setTestResult] = useState(''); const audio = useRef<HTMLAudioElement | null>(null); const audioUrl = useRef('');
  useEffect(() => { form.setFieldsValue(data.settings); }, [JSON.stringify(data.settings)]);
  useEffect(() => () => { audio.current?.pause(); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); }, []);
  async function save() { const values = await form.validateFields(); await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }); refresh(); }
  async function test(kind: string) { setTesting(kind); try { await save(); if (kind === 'llm') { const r = await post('/ai/test'); setTestResult(`${r.text} · ${r.elapsed}ms`); message.success('模型连接成功'); } else { const r = await fetch('/api/tts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，我是小智。现在连接的是你的本地环境。' }) }); if (!r.ok) throw new Error((await r.json()).error); audio.current?.pause(); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = URL.createObjectURL(await r.blob()); audio.current = new Audio(audioUrl.current); await audio.current.play(); message.success('语音合成成功，正在浏览器试听'); } } catch (e) { message.error(String(e)); } finally { setTesting(''); } }
  return <Form form={form} layout="vertical" initialValues={data.settings} onFinish={async () => { setSaving(true); try { await save(); message.success('设置已保存'); } catch (e) { message.error(String(e)); } finally { setSaving(false); } }}>
    <Flex vertical gap={12}>
      <Flex justify="flex-end"><Button type="primary" htmlType="submit" loading={saving} icon={<CheckOutlined/>}>保存设置</Button></Flex>
      <Columns>
        <Panel title="本地接入"><Columns><Form.Item name="publicHost" label="局域网 IP / 主机名" rules={[{ required: true }]}><Input placeholder="192.168.1.100"/></Form.Item><Form.Item name="defaultTransport" label="默认协议"><Select options={[{ value: 'websocket', label: 'WebSocket' }, { value: 'mqtt', label: 'MQTT + UDP' }]}/></Form.Item></Columns></Panel>
        <Panel title="唤醒与断句"><Columns>
          <Form.Item name="wakeGreeting" label="唤醒回复" tooltip="设备上报唤醒事件后播报，留空关闭。" rules={[{ max: 200 }]}><Input maxLength={200} allowClear/></Form.Item>
          <Form.Item name="wakePrefix" label="语音前缀过滤" tooltip="每轮语音需以此前缀开头，留空不限。不修改设备待机唤醒词。" rules={[{ max: 80 }]}><Input maxLength={80} allowClear placeholder="留空不限制"/></Form.Item>
          <Form.Item name={['vad', 'threshold']} label="音量阈值（RMS）"><InputNumber min={0.001} max={1} step={0.005} style={{ width: '100%' }}/></Form.Item>
          <Form.Item name={['vad', 'silenceMs']} label="静音断句（ms）"><InputNumber min={300} max={5000} step={100} style={{ width: '100%' }}/></Form.Item>
        </Columns></Panel>
      </Columns>
      <Columns count={3}>
        <Panel title="大模型" extra={<Button loading={testing === 'llm'} onClick={() => test('llm')} icon={<LinkOutlined/>}>测试</Button>}>
          <Form.Item name={['llm', 'baseUrl']} label="API Base URL" rules={[{ required: true }]}><Input/></Form.Item>
          <Form.Item name={['llm', 'model']} label="模型" rules={[{ required: true }]}><Input/></Form.Item>
          <Form.Item name={['llm', 'apiKey']} label="API Key"><Input.Password autoComplete="new-password"/></Form.Item>
          <Form.Item name={['llm', 'systemPrompt']} label="角色设定"><Input.TextArea rows={3}/></Form.Item>
        </Panel>
        <Panel title="语音识别">
          <Form.Item name={['asr', 'type']} label="服务"><Select options={[{ label: 'Qwen ASR', value: 'qwen' }, { label: 'OpenAI / Whisper', value: 'openai' }]}/></Form.Item>
          <Form.Item name={['asr', 'baseUrl']} label="API Base URL"><Input/></Form.Item>
          <Form.Item name={['asr', 'model']} label="模型"><Input/></Form.Item>
          <Form.Item name={['asr', 'apiKey']} label="API Key"><Input.Password autoComplete="new-password"/></Form.Item>
          <Upload accept="audio/*" showUploadList={false} beforeUpload={file => { setTesting('asr'); void save().then(() => upload('/asr/test', file)).then(r => { setTestResult(`语音识别：${r.text || '未识别到文字'}`); message.success(r.text || '未识别到文字'); }).catch(e => message.error(String(e))).finally(() => setTesting('')); return false; }}><Button icon={<UploadOutlined/>} loading={testing === 'asr'}>上传测试</Button></Upload>
        </Panel>
        <Panel title="语音合成" extra={<Button icon={<PlayCircleOutlined/>} loading={testing === 'tts'} onClick={() => test('tts')}>试听</Button>}>
          <Form.Item name={['tts', 'type']} label="服务"><Select options={[{ label: 'Edge TTS', value: 'edge' }, { label: 'OpenAI 兼容', value: 'openai' }]}/></Form.Item>
          <Form.Item name={['tts', 'voice']} label="音色"><Input placeholder="zh-CN-XiaoxiaoNeural"/></Form.Item>
          <Form.Item name={['tts', 'baseUrl']} label="API Base URL" tooltip="Edge TTS 不使用此项。"><Input/></Form.Item>
          <Form.Item name={['tts', 'model']} label="模型"><Input/></Form.Item>
          <Form.Item name={['tts', 'apiKey']} label="API Key"><Input.Password autoComplete="new-password"/></Form.Item>
          {!data.health.ffmpeg && <Alert type="warning" title="请安装 FFmpeg"/>}
        </Panel>
      </Columns>
      {testResult && <Alert type="success" title={testResult} closable onClose={() => setTestResult('')}/>}
    </Flex>
    <Form.Item name={['voiceprint', 'mode']} hidden><Input/></Form.Item><Form.Item name={['voiceprint', 'enabled']} hidden valuePropName="checked"><Switch/></Form.Item><Form.Item name={['voiceprint', 'baseUrl']} hidden><Input/></Form.Item><Form.Item name={['voiceprint', 'apiKey']} hidden><Input/></Form.Item><Form.Item name={['voiceprint', 'threshold']} hidden><InputNumber/></Form.Item>
  </Form>;
}

function Voice({ data, refresh }: { data: Snapshot; refresh: () => void }) {
  const [form] = Form.useForm(); const { message } = AntApp.useApp(); const [modal, setModal] = useState(false); const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { form.setFieldsValue(data.settings.voiceprint); }, [JSON.stringify(data.settings.voiceprint)]);
  const mode = Form.useWatch('mode', form) || data.settings.voiceprint.mode;
  return <Row gutter={[12, 12]}>
    <Col xs={24} lg={8}><Panel title="声纹设置" extra={<Tag color={data.health.voiceprintModel ? 'green' : 'default'}>{data.health.voiceprintModel ? '模型就绪' : '模型未安装'}</Tag>}>
      <Form form={form} layout="vertical" initialValues={data.settings.voiceprint} onFinish={async values => { try { await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data.settings, voiceprint: values }) }); refresh(); message.success('声纹设置已保存'); } catch (e) { message.error(String(e)); } }}>
        <Form.Item name="enabled" label="识别说话人" valuePropName="checked"><Switch/></Form.Item>
        <Form.Item name="mode" label="运行方式"><Select options={[{ label: '本地模型', value: 'local' }, { label: '外部服务', value: 'remote' }]}/></Form.Item>
        <Form.Item name="baseUrl" label="服务地址" hidden={mode === 'local'}><Input placeholder="http://127.0.0.1:8005"/></Form.Item>
        <Form.Item name="apiKey" label="服务密钥" hidden={mode === 'local'}><Input.Password autoComplete="new-password"/></Form.Item>
        <Form.Item name="threshold" label="相似度阈值"><Slider min={0} max={1} step={0.05}/></Form.Item>
        {mode === 'local' && !data.health.voiceprintModel && <Alert type="info" title={<Typography.Text>安装模型：<Typography.Text code> bun run setup:voiceprint</Typography.Text></Typography.Text>} style={{ marginBottom: 12 }}/>}<Button type="primary" htmlType="submit">保存</Button>
      </Form>
    </Panel></Col>
    <Col xs={24} lg={16}><Panel title="说话人" extra={<Button type="primary" icon={<PlusOutlined/>} onClick={() => setModal(true)}>添加</Button>}>
      <Table rowKey="id" size="small" dataSource={data.speakers} pagination={false} scroll={{ x: 480 }} columns={[
        { title: '姓名', dataIndex: 'name' }, { title: '备注', dataIndex: 'description' },
        { title: '状态', dataIndex: 'enrolled', render: v => <Tag color={v ? 'green' : 'default'}>{v ? '已登记' : '待上传'}</Tag> },
        { title: '操作', render: (_, r) => <Space><Upload accept="audio/*" showUploadList={false} beforeUpload={file => { setBusy(r.id); void upload(`/speakers/${r.id}/enroll`, file).then(() => { refresh(); message.success('声纹样本注册成功'); }).catch(e => message.error(String(e))).finally(() => setBusy('')); return false; }}><Button loading={busy === r.id} icon={<UploadOutlined/>} title="至少 3 秒清晰单人录音">上传样本</Button></Upload><Button type="text" danger icon={<DeleteOutlined/>} onClick={() => api(`/speakers/${r.id}`, { method: 'DELETE' }).then(refresh).catch(e => message.error(String(e)))} aria-label={`移除${r.name}`}/></Space> },
      ]}/>
    </Panel></Col>
    <Modal title="添加说话人" open={modal} onCancel={() => setModal(false)} onOk={async () => { try { await post('/speakers', { name, description }); setModal(false); setName(''); setDescription(''); refresh(); } catch (e) { message.error(String(e)); } }}><Form layout="vertical"><Form.Item label="姓名"><Input value={name} onChange={e => setName(e.target.value)}/></Form.Item><Form.Item label="备注"><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="可选"/></Form.Item></Form></Modal>
  </Row>;
}

function Mcp({ data, refresh }: { data: Snapshot; refresh: () => void }) {
  const { message } = AntApp.useApp(); const [modal, setModal] = useState(false); const [form] = Form.useForm(); const [selected, setSelected] = useState(''); const [tools, setTools] = useState<Json[]>([]); const [tool, setTool] = useState(''); const [args, setArgs] = useState('{}'); const [result, setResult] = useState(''); const [busy, setBusy] = useState(false);
  async function load(id: string) { setBusy(true); setSelected(id); setTool(''); setResult(''); try { setTools((await api(`/mcp/${id}/tools`)).tools); message.success('MCP 连接成功，已读取工具'); } catch (e) { setTools([]); message.error(String(e)); } finally { setBusy(false); } }
  return <Flex vertical gap={12}>
    <Panel title="MCP 服务" extra={<Button type="primary" icon={<PlusOutlined/>} onClick={() => setModal(true)}>添加服务</Button>}>
      <Table rowKey="id" size="small" dataSource={data.endpoints} pagination={false} scroll={{ x: 560 }} columns={[
        { title: '名称', dataIndex: 'name' }, { title: '地址', dataIndex: 'url', render: v => <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>{v}</Typography.Text> },
        { title: '协议', dataIndex: 'transport', render: v => <Tag>{v.toUpperCase()}</Tag> },
        { title: '操作', render: (_, e) => <Space><Button type={selected === e.id ? 'primary' : 'default'} onClick={() => load(e.id)} loading={busy && selected === e.id} icon={<LinkOutlined/>}>读取工具</Button><Button type="text" danger icon={<DeleteOutlined/>} aria-label={`删除${e.name}`} onClick={() => api(`/mcp/${e.id}`, { method: 'DELETE' }).then(() => { if (selected === e.id) { setSelected(''); setTools([]); setTool(''); setResult(''); } refresh(); }).catch(error => message.error(String(error)))}/></Space> },
      ]}/>
    </Panel>
    <Panel title="工具调试"><Flex vertical gap={8}>
      <Select value={tool || undefined} placeholder={tools.length ? '选择工具' : '请先读取服务工具'} options={tools.map(t => ({ label: t.name, value: t.name }))} onChange={setTool}/>
      {tools.find(t => t.name === tool)?.description && <Typography.Text type="secondary">{tools.find(t => t.name === tool)!.description}</Typography.Text>}
      <Columns><Form layout="vertical"><Form.Item label="参数 JSON"><Input.TextArea value={args} onChange={e => setArgs(e.target.value)} rows={4}/></Form.Item></Form><div>{tools.find(t => t.name === tool)?.inputSchema && <pre className="console-output">{JSON.stringify(tools.find(t => t.name === tool)!.inputSchema, null, 2)}</pre>}</div></Columns>
      <Button type="primary" style={{ alignSelf: 'flex-start' }} disabled={!tool || !selected} loading={busy} icon={<PlayCircleOutlined/>} onClick={async () => { setBusy(true); try { setResult(JSON.stringify(await post(`/mcp/${selected}/call`, { name: tool, arguments: JSON.parse(args) }), null, 2)); } catch (e) { message.error(String(e)); } finally { setBusy(false); } }}>执行</Button>
      {result && <pre className="console-output">{result}</pre>}
    </Flex></Panel>
    <Modal title="添加 MCP 服务" open={modal} onCancel={() => setModal(false)} onOk={() => form.submit()}><Form layout="vertical" form={form} initialValues={{ transport: 'http', token: '' }} onFinish={async values => { try { await post('/mcp', values); refresh(); setModal(false); form.resetFields(); message.success('服务已保存'); } catch (e) { message.error(String(e)); } }}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input/></Form.Item><Form.Item name="url" label="地址" rules={[{ required: true, type: 'url' }]}><Input placeholder="http://127.0.0.1:3001/mcp"/></Form.Item><Form.Item name="transport" label="协议"><Select options={[{ value: 'http', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE' }]}/></Form.Item><Form.Item name="token" label="Bearer Token"><Input.Password autoComplete="new-password"/></Form.Item></Form></Modal>
  </Flex>;
}

function Logs({ data }: { data: Snapshot }) {
  const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const logs = data.logs.filter(l => (filter === 'all' || l.level === filter) && `${l.scope} ${l.message} ${l.deviceId || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <Panel title="运行日志" extra={<Tag color="green">实时</Tag>}><Flex vertical gap={12}>
    <Flex justify="space-between" wrap gap={8}><Select style={{ width: 100 }} value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'info', label: '信息' }, { value: 'success', label: '成功' }, { value: 'warn', label: '提醒' }, { value: 'error', label: '错误' }]}/><Input.Search placeholder="搜索日志" value={query} onChange={e => setQuery(e.target.value)} allowClear style={{ width: 240, maxWidth: '100%' }}/></Flex>
    <EventList logs={logs.slice().reverse()}/>
  </Flex></Panel>;
}
