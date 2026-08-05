'use client';

import { LoginResponseSchema } from '@monitor/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthForm } from '../../components/auth-form';
import { useAuth } from '../../components/auth-provider';
import { apiFetch } from '../../lib/api';
import { saveTokens } from '../../lib/token-store';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  return (
    <div style={{ maxWidth: 420 }}>
      <h1>登录</h1>
      <AuthForm
        mode="login"
        submitLabel="登录"
        onSubmit={async ({ email, password }) => {
          const data = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: { email, password },
            schema: LoginResponseSchema,
            auth: false,
          });
          saveTokens(data.accessToken, data.refreshToken);
          await refresh();
          router.push('/');
        }}
      />
      <p style={{ marginTop: 16 }}>
        还没有账号？<Link href="/register">注册</Link>
      </p>
    </div>
  );
}
