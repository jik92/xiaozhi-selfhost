import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import 'antd/dist/reset.css';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} componentSize="small" theme={{ algorithm: theme.compactAlgorithm }}>
      <AntApp><App/></AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
