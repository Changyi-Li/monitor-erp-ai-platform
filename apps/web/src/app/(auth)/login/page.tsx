'use client';

import { LoginResponseSchema } from '@monitor/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthForm } from '../../../components/auth-form';
import { useAuth } from '../../../components/auth-provider';
import { apiFetch } from '../../../lib/api';
import { saveTokens } from '../../../lib/token-store';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  return (
    <div style={{ width: '100%' }}>
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
      <p style={{ marginTop: 24, textAlign: 'center' }}>
        <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: 14 }}>
          还没有账号？
        </span>{' '}
        <Link href="/register" style={{ color: '#ffffff', fontWeight: 600 }}>
          注册
        </Link>
      </p>
    </div>
  );
}
