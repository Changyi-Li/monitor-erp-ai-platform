'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { getBackgroundImage } from '../lib/background-image';
import { isPlatformRole, userRoleLabel } from '../lib/roles';
import { useAuth } from './auth-provider';
import {
  homeCategories,
  monitorModules,
  type MonitorMenuCategory,
  type MonitorModule,
} from '../data/monitor-menu';

/**
 * Monitor ERP 主框架（issue #31 + #32）：登录后页面套上 Monitor 主界面三区布局
 * —— 左侧模块导轨（logo + 8 模块 + 主题 pill 外观）+ 侧边程序菜单（「查找程序」搜索
 * + 分类/程序项）+ 顶部工具栏（状态栏 + Home + Monitor 搜索 + 用户徽标）+ 07.jpg 内容区背景。
 *
 * 样式/结构提取自 Monitor WebClient 登录后页面 HTML 与组件样式
 * （styles-25UOYN5D.css + 组件 chunk）：尺寸、配色、hover/选中态与原版一致。
 *
 * 模块切换（#32）：菜单数据来自 ../data/monitor-menu.ts（模块 → 分类 → 程序项，
 * 平台功能分门别类）；点击模块高亮并联动侧边菜单，再点当前模块取消选中回默认视图。
 * 搜索过滤由 #35、顶栏交互由 #34、主题切换由 #33 实现。
 *
 * 登录/注册页为全屏认证布局（issue #29），此框架不渲染（与旧 Topbar 行为一致）。
 */
export function MonitorFrame({ children }: { children: ReactNode }) {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // 当前选中的模块 key（null = 默认视图：最近/个人/内部应用程序）
  const [selectedModuleKey, setSelectedModuleKey] = useState<string | null>(null);

  // 内容区背景：复用会话内共享图（登录页随机后写入；无值时随机一张）——
  // 原版 BackgroundImageService 单例行为：登录时选中哪张，主界面就显示哪张，
  // 只有整页刷新（模块重载）才随机下一张。用 useEffect 避免 SSR/hydration 不一致。
  // 注意：本组件在 /login、/register 下也挂载（仅 return children），认证路径必须
  // 跳过读取，否则会先于登录页 layout 随机抢图污染共享状态；随 pathname 变化重读，
  // 保证登录后主界面复用登录页那张
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  useEffect(() => {
    if (pathname === '/login' || pathname === '/register') return;
    setBackgroundImage(getBackgroundImage());
  }, [pathname]);

  // 认证页全屏展示，不渲染主框架
  if (pathname === '/login' || pathname === '/register') return <>{children}</>;

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  const selectedModule =
    monitorModules.find((m) => m.key === selectedModuleKey) ?? null;

  // 平台角色过滤：非平台角色隐藏 用户管理/AI 客服/用量统计 等内部入口
  const platformHrefs = new Set(['/users', '/agent', '/usage']);
  function filterCategories(categories: MonitorMenuCategory[]): MonitorMenuCategory[] {
    if (isPlatformRole(user?.role)) return categories;
    return categories
      .map((cat) => ({ ...cat, items: cat.items.filter((i) => !platformHrefs.has(i.href)) }))
      .filter((cat) => cat.items.length > 0);
  }

  const visibleCategories = filterCategories(
    selectedModule ? selectedModule.categories : homeCategories,
  );

  function handleModuleClick(m: MonitorModule) {
    // 再点当前模块 → 取消选中回默认视图
    setSelectedModuleKey((current) => (current === m.key ? null : m.key));
  }

  // 模块色联动：侧边菜单的搜索下划线/分类标题/程序项竖条随选中模块变色（原版行为）
  const moduleColor = selectedModule?.color ?? 'var(--mwc-primary)';
  const sideMenuStyle = {
    '--main-module-color': moduleColor,
    '--module-color-light': moduleColor,
  } as CSSProperties;

  return (
    <div className="monitor-frame">
      {/* 1. 左侧模块导轨 */}
      <nav className="monitor-module-rail" aria-label="模块导航">
        <Link href="/" className="logo g5icon icon-module-monitor" aria-label="Monitor 首页" />
        <div className="module-menu-container">
          {monitorModules.map((m) => (
            <div
              key={m.key}
              className={`module ${m.key}${selectedModuleKey === m.key ? ' selected' : ''}`}
              style={{ '--module-color': m.color } as CSSProperties}
              title={m.title}
              data-testid="module"
              onClick={() => handleModuleClick(m)}
            >
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
      <aside className="monitor-side-menu" style={sideMenuStyle} aria-label="程序菜单">
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
          {visibleCategories.length === 0 ? (
            <p className="menu-empty" data-testid="menu-empty">
              {selectedModule
                ? `「${selectedModule.title}」模块暂无程序`
                : '暂无程序'}
            </p>
          ) : (
            <ul>
              {visibleCategories.map((cat) => (
                <li key={cat.label} data-testid={cat.label} className="category color-primary-light">
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
          )}
        </div>
      </aside>

      {/* 3. 内容区：工具栏 + 随机背景图 + fade 渐变 + 页面内容
          渲染链与原版 app-home 完全一致：背景图 100vh 全幅 + 63px 以下
          linear-gradient(180deg, var(--mwc-lighter) 0%, transparent 200%)
          ——无遮罩，fade 数学上等效登录页遮罩的 30% 可见度（见 globals.css 注释） */}
      <div className="monitor-content">
        <div className="background" style={backgroundImage ? { backgroundImage: `url('${backgroundImage}')` } : undefined} />
        <div className="background-fade" />
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
