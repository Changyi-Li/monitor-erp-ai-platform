'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { pickBackgroundImage } from '../../lib/background-image';

/**
 * 认证页（登录/注册）全屏布局：Monitor 风格随机背景图（每次挂载随机一张，
 * 原版 newBackgroundImage=true 行为）+ 暗色 overlay + 居中白色 logo。
 * 随机结果写入共享 store，登录后主界面复用同一张（见 lib/background-image.ts）。
 * route group 不影响 URL（仍为 /login、/register）。
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);

  useEffect(() => {
    // 每次挂载强制随机一张；主界面挂载时经 getBackgroundImage() 复用此图
    setBackgroundImage(pickBackgroundImage());
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : undefined,
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
