import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '../components/auth-provider';
import { Topbar } from '../components/topbar';
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
          <Topbar />
          <main style={{ padding: 24 }}>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
