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
 * 「查找程序」实时过滤由 #35 实现；顶栏 Monitor 搜索（#34 实现）暂隐藏；主题切换 #33。
 *
 * 登录/注册页为全屏认证布局（issue #29），此框架不渲染（与旧 Topbar 行为一致）。
 */
export function MonitorFrame({ children }: { children: ReactNode }) {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // 当前选中的模块 key（null = 默认视图：最近/个人/内部应用程序）
  const [selectedModuleKey, setSelectedModuleKey] = useState<string | null>(null);

  // 侧边菜单展开状态（原版 sidenavService menuIsOpen）：默认收起，
  // 点击模块展开，再点当前模块收起（原版 toggleSidebar 语义）
  const [menuOpen, setMenuOpen] = useState(false);

  // 「查找程序」实时过滤关键字（issue #35）：按程序项 caption 过滤当前菜单
  const [procedureQuery, setProcedureQuery] = useState('');

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

  // 主题切换（issue #33）：body class 在亮/暗主题间切换（原版 themeService.applyTheme
  // 语义 blue.light.contrast ↔ blue.dark.contrast），localStorage 记忆，刷新后保持；
  // 首帧 class 由 layout.tsx 内联脚本预置（防闪烁），此处与之一致后同步状态
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem('monitor-theme');
    const dark = saved === 'blue.dark.contrast';
    applyTheme(dark);
    setIsDark(dark);
  }, []);

  function applyTheme(dark: boolean) {
    document.body.classList.remove('monitor-light-contrast', 'monitor-dark-contrast');
    document.body.classList.add(dark ? 'monitor-dark-contrast' : 'monitor-light-contrast');
    localStorage.setItem('monitor-theme', dark ? 'blue.dark.contrast' : 'blue.light.contrast');
  }

  function handleThemeToggle() {
    const next = !isDark;
    applyTheme(next);
    setIsDark(next);
  }

  // 未登录访问受保护页面 → 直接跳登录页（刷新后登录态丢失的场景），
  // 不在主界面停留显示欢迎词；认证页自身不跳转（避免死循环）
  useEffect(() => {
    if (status === 'unauthenticated' && pathname !== '/login' && pathname !== '/register') {
      router.replace('/login');
    }
  }, [status, pathname, router]);

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
  )
    // issue #35：按「查找程序」关键字实时过滤程序项（中文/英文、大小写不敏感），
    // 无匹配程序项的分类自动隐藏
    .map((cat) => ({
      ...cat,
      items: cat.items.filter((i) =>
        i.caption.toLowerCase().includes(procedureQuery.trim().toLowerCase()),
      ),
    }))
    .filter((cat) => cat.items.length > 0);

  function handleModuleClick(m: MonitorModule) {
    if (selectedModuleKey === m.key) {
      // 再点当前模块 → 收起菜单并取消选中（回默认视图；原版 toggleSidebar 的 toggle 分支）
      setSelectedModuleKey(null);
      setMenuOpen(false);
    } else {
      // 点其他模块 → 选中并展开菜单（原版 toggleSidebar 的 open 分支）
      setSelectedModuleKey(m.key);
      setMenuOpen(true);
    }
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
        {/* 主题切换 pill（issue #33：点击切换亮/暗主题；isActive 滑块右移 + 实心月图标，
            原版 app-theme-switch 行为；localStorage 持久化见上方 applyTheme） */}
        <div className="theme-switch-container">
          <div
            className={`theme-pill-outer${isDark ? ' isActive' : ''}`}
            data-testid="theme-pill"
            title="切换主题"
            onClick={handleThemeToggle}
          >
            <div className="theme-pill-background" />
            <div className="theme-pill-indicator">
              <i className={`g5icon ${isDark ? 'icon-toggle-night' : 'icon-toggle-night-o'}`} />
            </div>
          </div>
        </div>
      </nav>

      {/* 2. 侧边程序菜单（默认收起，点击模块展开；宽度动画见 globals.css） */}
      <aside
        className={menuOpen ? 'monitor-side-menu open' : 'monitor-side-menu'}
        style={sideMenuStyle}
        aria-label="程序菜单"
      >
        <div className="search-container">
          <form className="search-form" onSubmit={(e) => e.preventDefault()}>
            <i className="search-icon g5icon icon-toggle-search-o" />
            <input
              type="text"
              data-testid="procedure-search"
              className="search-input"
              placeholder="查找程序"
              value={procedureQuery}
              onChange={(e) => setProcedureQuery(e.target.value)}
            />
          </form>
        </div>
        <div className="sub-menu-container">
          <div className="sub-menu-fade" />
          {visibleCategories.length === 0 ? (
            <p className="menu-empty" data-testid="menu-empty">
              {procedureQuery.trim()
                ? '无匹配程序'
                : selectedModule
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
            {/* Monitor 搜索 (Ctrl + F) 暂隐藏：功能属 T5 #34，先移除避免用户在未实现
                的搜索框里输入造成误解（样式 .monitor-toolbar .search-container 保留，#34 恢复） */}
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
