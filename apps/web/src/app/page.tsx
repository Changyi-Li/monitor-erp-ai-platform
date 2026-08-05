'use client';

import Link from 'next/link';
import { useAuth } from '../components/auth-provider';

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
        <li>角色：{user.role === 'internal' ? '内部用户' : '客户用户'}</li>
        <li>注册时间：{new Date(user.createdAt).toLocaleString()}</li>
      </ul>
    </div>
  );
}
