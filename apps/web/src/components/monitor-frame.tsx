'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { UpdateUserResponseSchema } from '@monitor/contracts';
import type { UserRole } from '@monitor/shared';
import { apiFetch, errorMessage } from '../lib/api';
import { getBackgroundImage } from '../lib/background-image';
import { isPlatformRole, userRoleLabel } from '../lib/roles';
import { useAuth } from './auth-provider';
import {
  homeCategories,
  monitorModules,
  type MonitorMenuCategory,
  type MonitorMenuItem,
  type MonitorModule,
} from '../data/monitor-menu';

/** 平台角色专属入口（非平台角色隐藏；与侧边菜单同一过滤规则，供搜索下拉复用） */
const PLATFORM_HREFS = new Set(['/agent', '/usage']);
/** T4：客户 PM 专属入口（用户管理页对公司开放——customer_pm 可见本公司账号） */
const CUSTOMER_PM_HREFS = new Set(['/users']);

function filterCategories(
  categories: MonitorMenuCategory[],
  role: UserRole | undefined,
): MonitorMenuCategory[] {
  if (isPlatformRole(role)) return categories;
  return categories
    .map((cat) => ({
      ...cat,
      items: cat.items.filter((i) => isItemVisible(i, role)),
    }))
    .filter((cat) => cat.items.length > 0);
}

/** 客户侧菜单可见性：平台入口一律隐藏；客户 PM 专属入口仅 customer_pm 可见 */
function isItemVisible(item: MonitorMenuItem, role: UserRole | undefined): boolean {
  if (PLATFORM_HREFS.has(item.href)) return false;
  return CUSTOMER_PM_HREFS.has(item.href) ? role === 'customer_pm' : true;
}

/**
 * Monitor ERP 主框架（issue #31 + #32）：登录后页面套上 Monitor 主界面三区布局
 * —— 左侧模块导轨（logo + 8 模块 + 主题 pill 外观）+ 侧边程序菜单（「查找程序」搜索
 * + 分类/程序项）+ 顶部工具栏（状态栏 + Home + Monitor 搜索 + 用户徽标）+ 07.jpg 内容区背景。
 *
 * 样式/结构提取自 Monitor WebClient 登录后页面 HTML 与组件样式
 * （styles-25UOYN5D.css + 组件 chunk）：尺寸、配色、hover/选中态与原版一致。
 *
 * 模块切换（#32）：菜单数据来自 ../data/monitor-menu.ts（模块 → 分类 → 程序项，
 * 平台功能分门别类）；点击模块高亮并联动侧边菜单。
 * 模块路由感知（#36）：active 态完全由路由决定（数据驱动反查菜单，如 /users → basicdata，
 * 前缀匹配覆盖子路径如 /projects/123）——类名 active + 实心图标 + 竖线变粗 + 顶栏
 * module-indicator 模块色；侧边菜单自动展开显示程序项（验收），点 active 模块收起。
 * 点击模块按钮只切换菜单内容/开合，不改变 active 态（跳转到该模块页面才变色，用户确认）。
 * 「查找程序」实时过滤由 #35 实现；顶栏 Monitor 搜索（#34 实现）暂隐藏；主题切换 #33。
 *
 * 登录页为全屏认证布局（issue #29），此框架不渲染（与旧 Topbar 行为一致）。
 * 自助注册已关闭（AUTH_SELF_REGISTER=false），无 /register 页面。
 */
export function MonitorFrame({ children }: { children: ReactNode }) {
  const { user, status, logout, refresh } = useAuth();
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
  // 注意：本组件在 /login、/invite 下也挂载（仅 return children），认证路径必须
  // 跳过读取，否则会先于登录页 layout 随机抢图污染共享状态；随 pathname 变化重读，
  // 保证登录后主界面复用登录页那张
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  useEffect(() => {
    if (pathname === '/login' || pathname === '/invite') return;
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

  // 顶栏功能（issue #34）：工具栏 Monitor 搜索框与侧边菜单「查找程序」联动（同一关键字），
  // Ctrl+F 聚焦工具栏搜索框（浏览器默认查找被拦截）
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setProcedureQuery('');
        searchInputRef.current?.blur();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 全局搜索下拉：跨全部模块/首页分类（角色过滤后），caption 包含关键字即命中，按 href 去重，
  // 最多显示 20 条。输入即出结果，不依赖侧边菜单展开（用户要求：不点开菜单也能看到页面）。
  // 条目带所属模块色（homeCategories 无模块归属 → 默认主色），下拉左侧竖线与模块导轨同色
  const searchResults = useMemo(() => {
    const q = procedureQuery.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const results: { caption: string; href: string; group: string; color?: string }[] = [];
    const push = (item: MonitorMenuItem, cat: MonitorMenuCategory, color?: string) => {
      if (!item.caption.toLowerCase().includes(q) || seen.has(item.href)) return;
      seen.add(item.href);
      results.push({ caption: item.caption, href: item.href, group: cat.label, color });
    };
    // 模块优先（带模块色）：同一页面在首页分类与模块分类里重复出现时，
    // 取模块主色（如「客户」= 销售绿，而非首页「最近」的无色条目）
    for (const m of monitorModules) {
      for (const cat of filterCategories(m.categories, user?.role)) {
        for (const item of cat.items) push(item, cat, m.color);
      }
    }
    // 首页分类兜底：仅补模块里没有的条目（当前数据全部有归属，此分支为未来扩展留位）
    for (const cat of filterCategories(homeCategories, user?.role)) {
      for (const item of cat.items) push(item, cat);
    }
    return results.slice(0, 20);
  }, [procedureQuery, user?.role]);

  // 搜索下拉：点击面板外收起（清空关键字，输入框同步失焦）
  const searchWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!searchResults.length) return;
    function onDocClick(e: MouseEvent) {
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setProcedureQuery('');
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [searchResults.length]);

  // 用户菜单（issue #34）：徽标点击展开（icon 空心/实心切换，原版 toggleUserIcon），
  // 点击菜单外任意处收起
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  useEffect(() => {
    if (!userMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('.user-menu-wrapper')) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [userMenuOpen]);

  // 未登录访问受保护页面 → 直接跳登录页（刷新后登录态丢失的场景），
  // 不在主界面停留显示欢迎词；登录页自身不跳转（避免死循环）。
  // /invite 是公开页（邀请链接的目标用户必然未登录）——豁免重定向，否则
  // 点开邀请链接被弹回登录页（grilling 发现 #52 遗留缺口）
  useEffect(() => {
    if (
      status === 'unauthenticated' &&
      pathname !== '/login' &&
      pathname !== '/invite'
    ) {
      router.replace('/login');
    }
  }, [status, pathname, router]);

  // 路由 → 模块反查（issue #36）：遍历模块菜单数据，当前路径命中的程序项所属模块
  // 即为 active 模块。前缀匹配（href 或 href/子路径）——动态路由如 /projects/123、
  // /kb/[documentId] 同样激活所属模块；数据驱动，新增页面无需硬编码映射
  // （/ → 默认视图，无模块）。
  // 注意：必须放在认证页早 return 之前——否则 /login → /users 切换时
  // hooks 顺序变化（React Rules of Hooks 报错）
  const routeModuleKey = useMemo(() => {
    for (const m of monitorModules) {
      for (const cat of m.categories) {
        if (
          cat.items.some((i) => pathname === i.href || pathname.startsWith(i.href + '/'))
        ) {
          return m.key;
        }
      }
    }
    return null;
  }, [pathname]);

  // 路由感知激活（issue #36 验收）：进入页面自动选中所属模块并展开侧边菜单
  // （验收：访问 /users → basicdata active + 菜单展开显示程序项；点 active 模块
  // 收起菜单形成展开↔收起循环）。仅当模块归属变化时触发——用户手动收起后，
  // 同模块内点程序项（路由变但模块不变）不强制重开；刷新页面重新激活。
  // 这里同时把菜单模块同步为 active 模块（active 由路由决定，点击模块按钮不改变它）
  useEffect(() => {
    if (routeModuleKey) {
      setSelectedModuleKey(routeModuleKey);
      setMenuOpen(true);
    }
  }, [routeModuleKey]);

  // 修改昵称 state（grilling：任何登录用户可改自己，含客户用户——用户菜单入口）。
  // 必须放在认证页早 return 之前（同 routeModuleKey 注释）：/login、/invite 渲染
  // 提前 return，若 state 在 return 之后声明则 hooks 顺序随路由切换变化（React 报错）
  const [nicknameModal, setNicknameModal] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState('');

  // 认证页与邀请页全屏展示，不渲染主框架（/invite 是公开页，自带 mwc 外壳）
  if (pathname === '/login' || pathname === '/invite') return <>{children}</>;

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  function openNicknameModal() {
    setUserMenuOpen(false);
    setNicknameDraft(user?.displayName ?? '');
    setNicknameError('');
    setNicknameModal(true);
  }

  async function handleNicknameSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !nicknameDraft.trim()) return;
    setNicknameError('');
    setNicknameSaving(true);
    try {
      // 本人改自己：目标鉴权（改别人仅超管）由后端 service 判定
      await apiFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { displayName: nicknameDraft.trim() },
        schema: UpdateUserResponseSchema,
      });
      await refresh();
      setNicknameModal(false);
    } catch (err) {
      setNicknameError(errorMessage(err));
    } finally {
      setNicknameSaving(false);
    }
  }

  // active 模块由路由决定（#36）：模块按钮高亮 + 顶栏 indicator 颜色跟随路由，
  // 与用户点击的菜单模块（selectedModuleKey）解耦——点击模块按钮只换菜单内容，
  // 不改变 active 态（用户确认的行为：跳转才变色）
  const activeModule =
    monitorModules.find((m) => m.key === routeModuleKey) ?? null;
  // 菜单模块：用户点击模块按钮后菜单显示哪个模块的程序项（默认跟随 active 模块，
  // 路由变化时由下方 useEffect 同步）
  const selectedModule =
    monitorModules.find((m) => m.key === selectedModuleKey) ?? null;

  const visibleCategories = filterCategories(
    selectedModule ? selectedModule.categories : homeCategories,
    user?.role,
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
      // 再点当前菜单模块 → 收起 ↔ 展开（toggle，原版 toggleSidebar 的 toggle 分支）。
      // 注意：不取消选中——active 由路由决定（#36），页面还在该模块下，收起≠失活，
      // 因此必须用函数式 toggle 而不是 setMenuOpen(false)（否则收起后无法再展开）
      setMenuOpen((open) => !open);
    } else {
      // 点其他模块 → 菜单切换到该模块程序项并展开（原版 toggleSidebar 的 open 分支）。
      // 注意：不改变 active 态——模块按钮高亮/indicator 颜色由路由决定（#36 用户确认：
      // 在 /users 点 sales 只换菜单，跳转 /customers 才变绿）
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
              className={`module ${m.key}${activeModule?.key === m.key ? ' active' : ''}`}
              style={{ '--module-color': m.color } as CSSProperties}
              title={m.title}
              data-testid="module"
              onClick={() => handleModuleClick(m)}
            >
              {/* active 模块用实心图标（原版：icon-module-<key> 无 -o 后缀） */}
              <span
                className={`g5icon icon-module-${m.key}${activeModule?.key === m.key ? '' : '-o'}`}
              />
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
                          <span
                            className="on-hover"
                            title="在新标签页打开"
                            onClick={(e) => {
                              // 新标签页打开该程序项页面（issue #44）；阻止 Link 默认导航与冒泡
                              e.preventDefault();
                              e.stopPropagation();
                              window.open(item.href, '_blank', 'noopener');
                            }}
                          >
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
            {/* 模块指示器（issue #36 验收）：active 由路由决定，跳转后显示对应模块色
                （globals.css）；点击模块按钮不跳转 → 保持当前模块色 */}
            <span
              className={`module-indicator${activeModule ? ` ${activeModule.key}` : ''}`}
              data-testid="module-indicator"
            />
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
            {/* Monitor 搜索（issue #34 + 用户要求）：Ctrl+F 聚焦；输入即出全局搜索下拉
                （跨模块命中页面，点击跳转，不依赖侧边菜单）；关键字同时联动侧边菜单
                「查找程序」过滤（同一 procedureQuery，两种入口行为一致） */}
            <div className="search-container">
              <div className="monitor-search-wrapper" ref={searchWrapRef}>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="search-input"
                  placeholder="Monitor 搜索 (Ctrl + F)"
                  value={procedureQuery}
                  onChange={(e) => setProcedureQuery(e.target.value)}
                />
                {searchResults.length > 0 && (
                  <div className="monitor-search-dropdown" data-testid="search-dropdown">
                    {searchResults.map((r) => (
                      <button
                        key={r.href}
                        type="button"
                        className="monitor-search-item"
                        style={{ '--module-color': r.color } as CSSProperties}
                        onClick={() => {
                          setProcedureQuery('');
                          searchInputRef.current?.blur();
                          router.push(r.href);
                        }}
                      >
                        <span className="monitor-search-bracket" />
                        <span className="monitor-search-caption">{r.caption}</span>
                        <span className="monitor-search-group">{r.group}</span>
                      </button>
                    ))}
                    {searchResults.length === 20 && (
                      <div className="monitor-search-more">更多结果，请输入更精确的关键字</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="user-actions">
              {status === 'loading' && <span style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>加载中…</span>}
              {status === 'authenticated' && user && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>
                    {user.displayName}
                  </span>
                  <div className="user-menu-wrapper">
                    <button
                      type="button"
                      className="user-button"
                      onClick={() => setUserMenuOpen((o) => !o)}
                      aria-label="用户菜单"
                    >
                      <span className={`g5icon ${userMenuOpen ? 'icon-toggle-user' : 'icon-toggle-user-o'}`} />
                    </button>
                    {userMenuOpen && (
                      <div className="user-menu" data-testid="user-menu">
                        <div className="user-menu-header">
                          <span className="user-menu-name">{user.displayName}</span>
                          <span className="user-menu-role">{userRoleLabel(user.role)}</span>
                          <span className="user-menu-email">{user.email}</span>
                        </div>
                        {/* 修改昵称（grilling）：所有登录用户可改自己，含客户用户 */}
                        <button
                          type="button"
                          className="user-menu-item"
                          onClick={openNicknameModal}
                        >
                          修改昵称
                        </button>
                        <button type="button" className="user-menu-item" onClick={handleLogout}>
                          登出
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              {status === 'unauthenticated' && (
                // 自助注册已关闭（AUTH_SELF_REGISTER=false）：顶栏只保留登录入口，
                // 账号由管理员创建或邀请链接加入
                <Link href="/login" style={{ fontSize: 12, color: 'var(--mwc-secondary)' }}>
                  登录
                </Link>
              )}
            </div>
          </div>
        </header>
        <main className="monitor-main">{children}</main>
      </div>

      {/* 修改昵称弹窗（grilling）：mwc 卡片质感（同 users 页 .up-modal 风格） */}
      {nicknameModal && (
        <div className="frame-modal-backdrop" onClick={() => setNicknameModal(false)}>
          <div
            className="frame-modal"
            role="dialog"
            aria-modal="true"
            aria-label="修改昵称"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="frame-modal-header">
              <div className="frame-modal-title">修改昵称</div>
              <button
                type="button"
                className="icon-button-action"
                onClick={() => setNicknameModal(false)}
                aria-label="关闭"
              >
                <i className="fa-solid fa-xmark fs-3 color-primary" aria-hidden="true" />
              </button>
            </div>
            <form onSubmit={handleNicknameSave} className="frame-modal-body">
              <input
                value={nicknameDraft}
                onChange={(e) => setNicknameDraft(e.target.value)}
                maxLength={64}
                className="frame-modal-input"
                autoFocus
                aria-label="新昵称"
              />
              <p className="frame-modal-hint">
                昵称显示在顶栏与用户列表中；同一昵称不可重复使用
              </p>
              {nicknameError && <p className="frame-modal-error">{nicknameError}</p>}
              <div className="frame-modal-actions">
                <button
                  type="submit"
                  className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                  disabled={
                    nicknameSaving ||
                    !nicknameDraft.trim() ||
                    nicknameDraft.trim() === user?.displayName
                  }
                >
                  <span className="dx-button-text">
                    {nicknameSaving ? '保存中…' : '保存'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
