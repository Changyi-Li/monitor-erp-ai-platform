import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '../components/auth-provider';
import { ChatWidget } from '../components/chat-widget';
import { MonitorFrame } from '../components/monitor-frame';
import './globals.css';
// Font Awesome 免费图标（保存按钮等通用图标；FA7 中图标 class 映射在 all.css，
// solid.css 仅含字体声明，故用 all.min.css）
import '@fortawesome/fontawesome-free/css/all.min.css';

export const metadata: Metadata = {
  title: 'Monitor ERP AI Platform',
  description: 'Monitor ERP 项目实施管理平台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body suppressHydrationWarning>
        {/* 主题防闪烁（issue #33）：React 挂载前应用持久化主题 class，
            避免刷新时先亮后暗一闪；key 与 monitor-frame 的 applyTheme 共用 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('monitor-theme')==='blue.dark.contrast'){document.body.classList.add('monitor-dark-contrast')}}catch(e){}})();`,
          }}
        />
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
