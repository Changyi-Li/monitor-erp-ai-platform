'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { isPlatformRole, userRoleLabel } from '../lib/roles';
import { useAuth } from './auth-provider';

/**
 * Monitor ERP 主框架（issue #31）：登录后页面套上 Monitor 主界面三区布局
 * —— 左侧模块导轨（logo + 8 模块 + 主题 pill 外观）+ 侧边程序菜单（「查找程序」搜索
 * + 分类/程序项）+ 顶部工具栏（状态栏 + Home + Monitor 搜索 + 用户徽标）+ 07.jpg 内容区背景。
 *
 * 样式/结构提取自 Monitor WebClient 登录后页面 HTML 与组件样式
 * （styles-25UOYN5D.css + 组件 chunk）：尺寸、配色、hover/选中态与原版一致。
 * 菜单程序项内容由 #32 填充（当前为占位分类）；搜索交互由 #35、顶栏交互由 #34 实现。
 *
 * 登录/注册页为全屏认证布局（issue #29），此框架不渲染（与旧 Topbar 行为一致）。
 */
export function MonitorFrame({ children }: { children: ReactNode }) {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // 认证页全屏展示，不渲染主框架
  if (pathname === '/login' || pathname === '/register') return <>{children}</>;

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  const modules = [
    { key: 'manufacturing', title: '生产' },
    { key: 'purchase', title: '采购' },
    { key: 'sales', title: '销售' },
    { key: 'stock', title: '库存' },
    { key: 'timerecording', title: '时间记录' },
    { key: 'accounting', title: '会计' },
    { key: 'basicdata', title: '通用登记' },
    { key: 'customreports', title: '定制包' },
  ] as const;

  const categories: { key: string; label: string; items: { caption: string; href: string }[] }[] = [
    {
      key: 'recent',
      label: '最近',
      items: [
        { caption: '客户', href: '/customers' },
        { caption: '项目', href: '/projects' },
        { caption: '知识库', href: '/kb' },
      ],
    },
    {
      key: 'personal',
      label: '个人',
      items: [
        ...(isPlatformRole(user?.role)
          ? [
              { caption: '用户管理', href: '/users' },
              { caption: 'AI 客服', href: '/agent' },
              { caption: '用量统计', href: '/usage' },
            ]
          : []),
      ],
    },
    {
      key: 'internal',
      label: '内部应用程序',
      items: [
        { caption: 'AI 配置', href: '/ai' },
        { caption: 'RAG 调试台', href: '/rag' },
        { caption: '导入调试台', href: '/import' },
      ],
    },
  ];

  return (
    <div className="monitor-frame">
      {/* 1. 左侧模块导轨 */}
      <nav className="monitor-module-rail" aria-label="模块导航">
        <Link href="/" className="logo g5icon icon-module-monitor" aria-label="Monitor 首页" />
        <div className="module-menu-container">
          {modules.map((m) => (
            <div key={m.key} className="module" title={m.title} data-testid="module">
              <span className={`g5icon icon-module-${m.key}-o`} />
            </div>
          ))}
        </div>
        {/* 主题切换 pill（外观；交互由 #33 实现） */}
        <div className="theme-switch-container">
          <div className="theme-pill-outer" data-testid="theme-pill" title="切换主题">
            <div className="theme-pill-background" />
            <div className="theme-pill-indicator">
              <i className="g5icon icon-toggle-night-o" />
            </div>
          </div>
        </div>
      </nav>

      {/* 2. 侧边程序菜单 */}
      <aside className="monitor-side-menu" aria-label="程序菜单">
        <div className="search-container">
          <form className="search-form" onSubmit={(e) => e.preventDefault()}>
            <i className="search-icon g5icon icon-toggle-search-o" />
            <input
              type="text"
              data-testid="procedure-search"
              className="search-input"
              placeholder="查找程序"
            />
          </form>
        </div>
        <div className="sub-menu-container">
          <div className="sub-menu-fade" />
          <ul>
            {categories.map((cat) => (
              <li key={cat.key} data-testid={cat.key} className="category color-primary-light">
                <span className="header">{cat.label}</span>
                <ul>
                  {cat.items.map((item) => (
                    <li key={item.href}>
                      <Link href={item.href} className="has-hovered-elements">
                        <span className="module-bracket" />
                        <span className="caption">{item.caption}</span>
                        <span className="on-hover">
                          <span className="g5icon icon-button-window-new" />
                        </span>
                        <span className="on-hover">
                          <span className="g5icon icon-toggle-favourite-o" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* 3. 内容区：工具栏 + 07.jpg 背景 + 页面内容 */}
      <div className="monitor-content">
        <div className="background-fade" />
        <div className="background" />
        <header className="monitor-toolbar">
          <div className="status-container-wrapper">
            <span className="module-indicator" data-testid="module-indicator" />
            <div className="status-container" data-testid="desktopCaption">
              <span>Monitor ERP AI Platform | {user ? `${user.displayName} · ${userRoleLabel(user.role)}` : '未登录'}</span>
            </div>
          </div>
          <div className="action-container">
            <div className="navigation-actions">
              <button type="button" className="action-button" onClick={() => router.push('/')} aria-label="首页">
                <span className="g5icon icon-toggle-home-o" />
              </button>
            </div>
            <div className="search-container">
              <input type="text" className="search-input" placeholder="Monitor 搜索 (Ctrl + F)" />
            </div>
            <div className="user-actions">
              {status === 'loading' && <span style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>加载中…</span>}
              {status === 'authenticated' && user && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>
                    {user.displayName}
                  </span>
                  <button type="button" className="user-button" onClick={handleLogout} aria-label="登出">
                    <span className="g5icon icon-toggle-user-o" />
                  </button>
                </>
              )}
              {status === 'unauthenticated' && (
                <>
                  <Link href="/login" style={{ fontSize: 12, color: 'var(--mwc-secondary)' }}>
                    登录
                  </Link>
                  <Link href="/register" style={{ fontSize: 12, color: 'var(--mwc-secondary)' }}>
                    注册
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>
        <main className="monitor-main">{children}</main>
      </div>
    </div>
  );
}
