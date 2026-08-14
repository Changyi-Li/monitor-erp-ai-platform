'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useAuth } from '../components/auth-provider';
import { isCustomerRole, userRoleLabel } from '../lib/roles';

/**
 * 根页面：登录后显示 Monitor 风格「起始页 widget 桌面」
 * （原版 app-dashboard .start-page-view + mwc-widget-wrapper 半透明卡片：
 * 85% 透明度、hover 全实、标题栏 icon + title + 右侧 hover 显现按钮）。
 * 卡片入口与 #32 模块菜单归类一致（客户→销售、项目→会计、知识库/用户→通用登记、
 * AI 工具→定制包）；平台角色可见内部工具卡片。
 */

interface Widget {
  icon: string;
  color: string;
  title: string;
  href: string;
  desc: string;
}

const commonWidgets: Widget[] = [
  {
    icon: 'icon-module-sales-o',
    color: 'var(--mwc-module-sales)',
    title: '客户',
    href: '/customers',
    desc: '管理客户档案与联系信息',
  },
  {
    icon: 'icon-module-accounting-o',
    color: 'var(--mwc-module-accounting)',
    title: '项目',
    href: '/projects',
    desc: '项目实施全流程管理',
  },
  {
    icon: 'icon-module-basicdata-o',
    color: 'var(--mwc-module-basicdata)',
    title: '知识库',
    href: '/kb',
    desc: '知识文档、在线帮助与 RAG 知识源',
  },
];

const platformWidgets: Widget[] = [
  {
    icon: 'icon-module-customreports-o',
    color: 'var(--mwc-module-custom)',
    title: 'AI 客服',
    href: '/agent',
    desc: '基于知识库的 AI 对话助手',
  },
  {
    icon: 'icon-module-customreports-o',
    color: 'var(--mwc-module-custom)',
    title: '用量统计',
    href: '/usage',
    desc: 'AI 调用与 token 用量',
  },
  {
    icon: 'icon-module-customreports-o',
    color: 'var(--mwc-module-custom)',
    title: 'AI 配置',
    href: '/ai',
    desc: '模型、检索与提示词配置',
  },
  {
    icon: 'icon-module-customreports-o',
    color: 'var(--mwc-module-custom)',
    title: 'RAG 调试台',
    href: '/rag',
    desc: '知识库检索调试与索引管理',
  },
  {
    icon: 'icon-module-customreports-o',
    color: 'var(--mwc-module-custom)',
    title: '导入调试台',
    href: '/import',
    desc: '文档导入任务与暂存区管理',
  },
  {
    icon: 'icon-module-basicdata-o',
    color: 'var(--mwc-module-basicdata)',
    title: '用户管理',
    href: '/users',
    desc: '内部用户与权限管理',
  },
];

export default function HomePage() {
  const { user, status } = useAuth();

  if (status === 'loading') {
    return <p>加载中…</p>;
  }

  // 未登录：不显示欢迎词，由 MonitorFrame 守卫统一跳转 /login
  if (status === 'unauthenticated' || !user) {
    return null;
  }

  // 平台角色：全部卡片；客户角色：仅客户/项目/知识库
  const widgets = isCustomerRole(user.role) ? commonWidgets : [...commonWidgets, ...platformWidgets];

  return (
    <div className="monitor-start-page" data-testid="start-page">
      {widgets.map((w) => (
        <Link
          key={w.href}
          href={w.href}
          className="monitor-widget"
          style={{ '--widget-color': w.color } as CSSProperties}
        >
          <div className="widget-toolbar">
            <div className="widget-left-toolbar">
              <span className={`g5icon ${w.icon} widget-icon`} />
              <h2 className="widget-title">{w.title}</h2>
            </div>
            <div className="widget-right-toolbar">
              <span className="g5icon icon-button-window-new" />
            </div>
          </div>
          <div className="widget-content">
            <p className="widget-desc">{w.desc}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
