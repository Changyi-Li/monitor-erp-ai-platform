'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { SetPasswordResponseSchema } from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';

/**
 * 邀请链接首次设密（公开页，demo path：收到邀请链接 → 打开 → 设置密码 → 登录）。
 * token 从 URL query 读取，一次性；设密成功跳转登录页。
 */
function InviteForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/api/auth/set-password', {
        method: 'POST',
        body: { token, password },
        schema: SetPasswordResponseSchema,
        auth: false,
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p>
        密码设置成功，{' '}
        <Link href="/login" style={{ color: '#2563eb' }}>
          去登录 →
        </Link>
      </p>
    );
  }

  if (!token) {
    return <p style={{ color: '#b91c1c' }}>邀请链接无效：缺少 token 参数</p>;
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
      <h2>设置密码</h2>
      <p style={{ color: '#6b7280', fontSize: 14 }}>首次登录前请设置你的密码（至少 6 位）</p>
      <input
        type="password"
        placeholder="新密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <input
        type="password"
        placeholder="确认密码"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <button type="submit" disabled={submitting || !password || !confirm}>
        {submitting ? '提交中…' : '设置密码'}
      </button>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
    </form>
  );
}

export default function InvitePage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <Suspense fallback={<p>加载中…</p>}>
        <InviteForm />
      </Suspense>
    </div>
  );
}
