import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Descriptions, Flex, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { api } from './api';
import type { Snapshot } from '../shared/types';
import type { DingTalkSnapshot, DingTalkRecord } from '../shared/dingtalk';

const statusLabels = { disabled: '未启用', connecting: '正在连接', connected: 'Stream 已连接', reconnecting: '等待重连' };
const recordLabels: Record<DingTalkRecord['state'], string> = { queued: '等待设备空闲', playing: '正在播报', played: '音频已发送', notified: '通知已下发', failed: '播报失败', expired: '已过期', skipped: '已取消', unknown: '结果未知' };
export default function DingTalk({ data, visible }: { data: Snapshot; visible: boolean }) {
  const { message } = App.useApp(); const [form] = Form.useForm();
  const [state, setState] = useState<DingTalkSnapshot>(); const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function refresh() { try { setState(await api('/dingtalk')); setError(''); } catch (e) { setError(String(e)); } }
  useEffect(() => {
    if (!visible) return;
    let active = true;
    async function load() {
      try {
        const result = await api<DingTalkSnapshot>('/dingtalk');
        if (!active) return;
        setState(result); setError('');
        if (!form.isFieldsTouched()) form.setFieldsValue({ ...result.config, clientSecret: '', users: result.config.userIds.join('\n') });
      } catch (e) { if (active) setError(String(e)); }
    }
    void load(); const timer = setInterval(() => { void load(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [visible, form]);
  return <Flex vertical gap={12}>
    <Card size="small" title="钉钉消息通知" extra={<Space><Tag color={state?.status === 'connected' ? 'success' : 'default'}>{state ? statusLabels[state.status] : '读取中'}</Tag><Button icon={<ReloadOutlined/>} onClick={() => void refresh()}>刷新状态</Button></Space>}>
      <Flex vertical gap={12}>
        <Alert type="info" showIcon title="Stream 模式 · 收到消息后主动播报" description="在钉钉开发者后台创建并发布应用机器人，接收模式选择 Stream。接收与机器人单聊、群内 @机器人的文本消息，无法接收群内未 @机器人的普通消息。使用当前「角色与语音」的人设和音色播报，无需配置公网回调或 Webhook。"/>
        {(error || state?.error) && <Alert type="warning" showIcon title={error || state?.error}/>}
        <Form form={form} layout="vertical" onFinish={async values => {
          setSaving(true);
          try {
            const result = await api<DingTalkSnapshot>('/dingtalk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!values.enabled, clientId: values.clientId || '', clientSecret: values.clientSecret || '', deviceId: values.deviceId || '', conversationId: values.conversationId || '', userIds: String(values.users || '').split(/[\n,，]+/).map(s => s.trim()).filter(Boolean) }) });
            setState(result); form.setFieldsValue({ clientSecret: '' }); message.success('钉钉通知设置已保存');
          } catch (e) { message.error(String(e)); } finally { setSaving(false); }
        }}>
          <Form.Item name="enabled" label="启用 Stream 消息通知" valuePropName="checked"><Switch/></Form.Item>
          <Form.Item name="clientId" label="Client ID / AppKey"><Input autoComplete="off" maxLength={200}/></Form.Item>
          <Form.Item name="clientSecret" label="Client Secret / AppSecret" extra={state?.config.hasSecret ? '已保存密钥，留空保留；更换 Client ID 时填写新密钥。' : '密钥仅保存在本机，不会返回到页面。'}><Input.Password autoComplete="new-password" maxLength={500}/></Form.Item>
          <Form.Item name="deviceId" label="播报设备"><Select allowClear placeholder="选择小智设备" options={data.devices.map(d => ({ value: d.id, label: `${d.name} · ${d.online ? '在线' : '离线'} · ${d.id}` }))}/></Form.Item>
          <Form.Item name="conversationId" label="限定会话 / 群 ID" extra="留空接收所有可见会话；可从下方最近消息来源复制。"><Input maxLength={300}/></Form.Item>
          <Form.Item name="users" label="限定发送人 ID" extra="每行一个，留空允许所有向机器人发消息的人。"><Input.TextArea rows={2}/></Form.Item>
          <Typography.Paragraph type="secondary">设备需保持与本地服务连接；无法远程唤醒断线或休眠设备。Passport 使用 MQTT 可待机接收通知，无需开启 UDP 对话通道。其他设备需音频通道就绪。忙碌、离线或通道未就绪时排队等待，超过 10 分钟取消；已开始播报的消息不会因重启重复发送。「通知已下发」表示设备已请求音频，固件不提供播放完成回执，无法确认现场是否听见。</Typography.Paragraph>
          <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined/>}>保存设置</Button>
        </Form>
        {state?.lastSender && <Descriptions size="small" title="最近消息来源" column={1} items={[{ key: 'conversation', label: '会话 / 群 ID', children: <Typography.Text copyable>{state.lastSender.conversationId || '未提供'}</Typography.Text> }, { key: 'user', label: '发送人 ID', children: <Typography.Text copyable>{state.lastSender.userId || '未提供'}</Typography.Text> }]}/>}
      </Flex>
    </Card>
    <Card size="small" title="最近通知"><Table rowKey="id" size="small" dataSource={state?.records || []} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} columns={[
      { title: '时间', dataIndex: 'created', width: 155, render: v => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
      { title: '发送人', dataIndex: 'sender', width: 110 }, { title: '消息', dataIndex: 'text', ellipsis: true },
      { title: '状态', dataIndex: 'state', width: 140, render: (v: DingTalkRecord['state']) => <Tag color={(v === 'played' || v === 'notified') ? 'success' : v === 'failed' ? 'error' : 'default'}>{recordLabels[v]}</Tag> },
      { title: '说明', dataIndex: 'error', ellipsis: true },
    ]}/></Card>
  </Flex>;
}
