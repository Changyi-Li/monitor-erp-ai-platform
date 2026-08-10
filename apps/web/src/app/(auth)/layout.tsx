import type { ReactNode } from 'react';

/**
 * 认证页（登录/注册）全屏布局：Monitor 风格背景图 + 暗色 overlay + 居中白色 logo。
 * route group 不影响 URL（仍为 /login、/register），Topbar 在组件内按路径隐藏。
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: 'url(/images/login/07.jpg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          // 原版 Monitor 登录页 overlay：#646152b3（灰褐色、70% 不透明、均匀无渐变）
          background: '#646152b3',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 40,
          width: '100%',
          maxWidth: 500,
          padding: '24px 24px 48px',
        }}
      >
        <img
          src="/images/login/logo-text.svg"
          alt="Monitor"
          style={{ width: 280, maxWidth: '80%', height: 'auto' }}
        />
        {children}
      </div>
    </div>
  );
}
