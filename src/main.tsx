import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#3459d5', colorText: '#25324b', colorTextSecondary: '#758198', colorBorder: '#dfe5ef', colorBgLayout: '#f5f7fb', fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif', borderRadius: 9, controlHeight: 38 }, components: { Button: { primaryShadow: 'none' }, Menu: { itemSelectedBg: '#e9efff', itemSelectedColor: '#3459d5' } } }}><AntApp><App/></AntApp></ConfigProvider></React.StrictMode>);
