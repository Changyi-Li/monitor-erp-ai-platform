'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isPlatformRole, userRoleLabel } from '../lib/roles';
import { useAuth } from './auth-provider';

/**
 * 顶部导航：登录态显示角色菜单（项目=全部登录用户；用户管理=内部/超管，demo path：
 * 菜单与按钮按权限显示/隐藏）+ 当前用户 + 登出；未登录显示登录/注册链接。
 */
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {status === 'loading' && <span>加载中…</span>}
        {status === 'authenticated' && user && (
          <>
            <nav style={{ display: 'flex', gap: 12 }}>
              <Link href="/customers">客户</Link>
              <Link href="/projects">项目</Link>
              {isPlatformRole(user.role) && (
                <>
                  <Link href="/users">用户管理</Link>
                  <Link href="/agent">AI 客服</Link>
                  <Link href="/usage">用量统计</Link>
                </>
              )}
            </nav>
            <span>
              {user.displayName}（{user.email} · {userRoleLabel(user.role)}）
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
