'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';

interface AuthFormProps {
  submitLabel: string;
  onSubmit: (values: { email: string; password: string }) => Promise<void>;
}

/** 字段容器/输入框/按钮样式：Monitor 登录页风格（深色背景上用，白色下划线输入框） */
const fieldStyle: CSSProperties = { display: 'block' };
const labelStyle: CSSProperties = {
  display: 'block',
  color: 'rgba(255, 255, 255, 0.7)',
  fontSize: 13,
  letterSpacing: 2,
};
const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '8px 0',
  background: 'transparent',
  border: 'none',
  // 原版：#fefefe80（白色 50%）、2px 下划线
  borderBottom: '2px solid rgba(254, 254, 254, 0.5)',
  borderRadius: 0,
  color: '#fefefe',
  fontSize: 16,
  outline: 'none',
};
const submitStyle: CSSProperties = {
  width: '100%',
  marginTop: 8,
  padding: '12px 0',
  // 原版：mwc-button 半透明白底 + 白字（hover 见 globals.css .auth-submit:hover）
  background: 'rgba(247, 247, 247, 0.2)',
  color: '#fefefe',
  border: 'none',
  borderRadius: 2,
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 4,
  cursor: 'pointer',
};

/**
 * 登录表单：邮箱 + 密码，错误提示读取契约错误文案；样式为深色背景 Monitor 风格。
 * 自助注册已关闭（AUTH_SELF_REGISTER=false）：账号只能由管理员创建或邀请链接加入，
 * 登录页不再有注册入口（auth-form 只服务登录）。
 */
export function AuthForm({ submitLabel, onSubmit }: AuthFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ email, password });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 20, width: '100%' }}
    >
      <label style={fieldStyle}>
        <span style={labelStyle}>邮箱</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="auth-input"
          style={inputStyle}
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelStyle}>密码</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={1}
          className="auth-input"
          style={inputStyle}
        />
      </label>
      {error && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="auth-submit"
        style={{
          ...submitStyle,
          ...(submitting ? { opacity: 0.6, cursor: 'default' } : {}),
        }}
      >
        {submitting ? '提交中…' : submitLabel}
      </button>
    </form>
  );
}
