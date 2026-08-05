'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from './auth-provider';

/** 右上角：登录态显示当前用户 + 登出按钮；未登录显示登录/注册链接 */
export function Topbar() {
  const { user, status, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 24px',
        borderBottom: '1px solid #e5e7eb',
      }}
    >
      <strong>Monitor ERP AI Platform</strong>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {status === 'loading' && <span>加载中…</span>}
        {status === 'authenticated' && user && (
          <>
            <span>
              {user.displayName}（{user.email}）
            </span>
            <button type="button" onClick={handleLogout}>
              登出
            </button>
          </>
        )}
        {status === 'unauthenticated' && (
          <>
            <Link href="/login">登录</Link>
            <Link href="/register">注册</Link>
          </>
        )}
      </div>
    </header>
  );
}
