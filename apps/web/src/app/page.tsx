'use client';

import Link from 'next/link';
import { useAuth } from '../components/auth-provider';
import { userRoleLabel } from '../lib/roles';

/** 主页：展示登录态与当前用户（demo path 落点） */
export default function HomePage() {
  const { user, status } = useAuth();

  if (status === 'loading') {
    return <p>加载中…</p>;
  }

  if (status === 'unauthenticated' || !user) {
    return (
      <div>
        <h1>欢迎来到 Monitor ERP AI Platform</h1>
        <p>请先登录以继续。</p>
        <Link href="/login">前往登录</Link>
      </div>
    );
  }

  return (
    <div>
      <h1>你好，{user.displayName}！</h1>
      <p>当前登录用户：</p>
      <ul>
        <li>邮箱：{user.email}</li>
        <li>角色：{userRoleLabel(user.role)}</li>
        <li>注册时间：{new Date(user.createdAt).toLocaleString()}</li>
      </ul>
      <p style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link href="/kb" style={{ color: '#2563eb' }}>
          知识库 →
        </Link>
        <Link href="/projects" style={{ color: '#2563eb' }}>
          项目列表 →
        </Link>
        {user.role !== 'customer' && (
          <>
            <Link href="/rag" style={{ color: '#2563eb' }}>
              RAG 调试台 →
            </Link>
            <Link href="/agent" style={{ color: '#2563eb' }}>
              AI 客服 →
            </Link>
            <Link href="/usage" style={{ color: '#2563eb' }}>
              用量统计 →
            </Link>
            <Link href="/ai" style={{ color: '#2563eb' }}>
              AI 配置 →
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
