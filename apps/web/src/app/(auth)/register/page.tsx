'use client';

import { RegisterResponseSchema } from '@monitor/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthForm } from '../../../components/auth-form';
import { apiFetch } from '../../../lib/api';

export default function RegisterPage() {
  const router = useRouter();

  return (
    <div style={{ width: '100%' }}>
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
      <p style={{ marginTop: 24, textAlign: 'center' }}>
        <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: 14 }}>
          已有账号？
        </span>{' '}
        <Link href="/login" style={{ color: '#ffffff', fontWeight: 600 }}>
          登录
        </Link>
      </p>
    </div>
  );
}
