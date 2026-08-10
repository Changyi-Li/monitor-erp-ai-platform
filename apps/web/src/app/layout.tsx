import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '../components/auth-provider';
import { ChatWidget } from '../components/chat-widget';
import { MonitorFrame } from '../components/monitor-frame';
import './globals.css';

export const metadata: Metadata = {
  title: 'Monitor ERP AI Platform',
  description: 'Monitor ERP 项目实施管理平台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          {/* Monitor 主框架（issue #31）：登录/注册页在组件内按路径退化为纯内容渲染 */}
          <MonitorFrame>{children}</MonitorFrame>
          {/* AI 客服悬浮小组件（内部用户；组件内部按 agent:use 判定渲染） */}
          <ChatWidget />
        </AuthProvider>
      </body>
    </html>
  );
}
