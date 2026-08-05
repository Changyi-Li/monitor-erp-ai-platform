'use client';

import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';

interface AuthFormProps {
  mode: 'login' | 'register';
  submitLabel: string;
  onSubmit: (values: {
    email: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
}

/** 通用认证表单：邮箱 + 密码（注册含昵称），错误提示读取契约错误文案 */
export function AuthForm({ mode, submitLabel, onSubmit }: AuthFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        email,
        password,
        ...(mode === 'register' ? { displayName: displayName.trim() || undefined } : {}),
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}
    >
      <label>
        邮箱
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ display: 'block', width: '100%', padding: 8 }}
        />
      </label>
      {mode === 'register' && (
        <label>
          昵称（可选）
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ display: 'block', width: '100%', padding: 8 }}
          />
        </label>
      )}
      <label>
        密码
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={mode === 'register' ? 8 : 1}
          style={{ display: 'block', width: '100%', padding: 8 }}
        />
      </label>
      {error && <p style={{ color: '#dc2626' }}>{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? '提交中…' : submitLabel}
      </button>
    </form>
  );
}
