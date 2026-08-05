'use client';

import { RegisterResponseSchema } from '@monitor/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthForm } from '../../components/auth-form';
import { apiFetch } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();

  return (
    <div style={{ maxWidth: 420 }}>
      <h1>注册</h1>
      <AuthForm
        mode="register"
        submitLabel="注册"
        onSubmit={async ({ email, password, displayName }) => {
          // 注册只创建账号：请求/响应均经契约校验，成功后去登录页
          await apiFetch('/api/auth/register', {
            method: 'POST',
            body: { email, password, displayName },
            schema: RegisterResponseSchema,
            auth: false,
          });
          router.push('/login');
        }}
      />
      <p style={{ marginTop: 16 }}>
        已有账号？<Link href="/login">登录</Link>
      </p>
    </div>
  );
}
