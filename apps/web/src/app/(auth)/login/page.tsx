'use client';

import { LoginResponseSchema } from '@monitor/contracts';
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
    </div>
  );
}
