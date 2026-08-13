'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { InviteInfoResponseSchema, SetPasswordResponseSchema, type InviteInfoResponse } from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { getBackgroundImage } from '../../lib/background-image';

/**
 * 邀请链接首次设密（公开页，demo path：收到邀请链接 → 打开 → 设置密码 → 登录）。
 * 页面为完整 Monitor 外壳（grilling 点 5）：顶栏「Monitor ERP | 邀请」状态行
 * （复用 monitor-frame 的 .monitor-toolbar 全局类）+ mwc 卡片化表单（质感同 users 页
 * up-card / dx-editor-filled，作用域类见 globals.css .invite-page）。
 * token 从 URL query 读取，一次性；设密成功跳转登录页。
 * 邀请类型（issue #52）：进入时先查 GET /api/auth/invite-info——
 * - customer：需输入绑定邮箱 + 密码（链接绑定邮箱"只能本人激活"：不回显邮箱，
 *   持链接者必须知道被邀请的邮箱才能通过后端校验，防链接转发）
 * - project：仅密码（现有表单）
 */
function InviteForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [info, setInfo] = useState<InviteInfoResponse | null>(null);
  const [infoError, setInfoError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 背景图（grilling）：与主界面一致——会话内共享同一张图（getBackgroundImage 单例），
  // 挂载后设置（同 monitor-frame，避免 SSR/hydration 随机值不一致）
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);

  useEffect(() => {
    setBackgroundImage(getBackgroundImage());
  }, []);

  // 加载时查询邀请类型（#52）：无效/过期 token → 直接报错不渲染表单
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch(`/api/auth/invite-info?token=${encodeURIComponent(token)}`, {
      schema: InviteInfoResponseSchema,
      auth: false,
    })
      .then((res) => {
        if (!cancelled) {
          setInfo(res);
          setInfoError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setInfoError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

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
        body: {
          token,
          password,
          // 客户邀请必须携带绑定邮箱（用户自行输入，后端校验一致；成员邀请可不传）
          ...(info?.kind === 'customer' ? { email } : {}),
        },
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

  return (
    <div className="invite-page">
      {/* 背景与主界面完全一致（grilling）：复用 .monitor-content 的
          .background（全幅 cover 图）+ .background-fade（63px 起渐变）全局类，
          图片走同一 getBackgroundImage 单例 → 同会话同图 */}
      <div className="monitor-content">
        <div
          className="background"
          style={backgroundImage ? { backgroundImage: `url('${backgroundImage}')` } : undefined}
        />
        <div className="background-fade" />

        {/* Monitor 顶栏状态行（grilling 点 5）：复用 monitor-frame 的全局类，风格一致 */}
        <header className="monitor-toolbar">
          <div className="status-container-wrapper">
            <div className="status-container" data-testid="desktopCaption">
              <span>Monitor ERP | 邀请</span>
              <span data-testid="desktopCaption">首次登录 · 设置你的密码</span>
            </div>
          </div>
        </header>

        <main className="monitor-main invite-main">
        <div className="invite-card">
          {done ? (
            <div className="invite-done">
              <i className="fa-solid fa-check color-success-strong fs-3" aria-hidden="true" />
              <p className="invite-success">密码设置成功，请使用新密码登录</p>
              <Link href="/login" className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text">
                <span className="dx-button-text">去登录 →</span>
              </Link>
            </div>
          ) : !token ? (
            <div className="invite-msg invite-msg-error">
              <i className="fa-solid fa-xmark fs-3" aria-hidden="true" />
              <p>邀请链接无效：缺少 token 参数</p>
            </div>
          ) : infoError ? (
            <div className="invite-msg invite-msg-error">
              <i className="fa-solid fa-xmark fs-3" aria-hidden="true" />
              <p>{infoError}</p>
            </div>
          ) : !info ? (
            <div className="invite-msg">
              <p className="invite-loading">加载中…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="invite-form">
              <div className="invite-title">
                <i className="fa-solid fa-key fs-3 color-primary" aria-hidden="true" />
                <span>设置密码</span>
              </div>
              <p className="invite-sub">
                {info.kind === 'customer'
                  ? '首次登录前请设置你的密码（至少 6 位）。请输入邀请链接绑定的邮箱（联系人邮箱），验证通过后即可激活'
                  : '首次登录前请设置你的密码（至少 6 位）'}
              </p>
              {info.kind === 'customer' && (
                <label className="invite-field">
                  <span className="invite-label">绑定邮箱</span>
                  <input
                    type="email"
                    className="invite-input"
                    placeholder="被邀请的邮箱"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
              )}
              <label className="invite-field">
                <span className="invite-label">新密码</span>
                <input
                  type="password"
                  className="invite-input"
                  placeholder="至少 6 位"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <label className="invite-field">
                <span className="invite-label">确认密码</span>
                <input
                  type="password"
                  className="invite-input"
                  placeholder="再次输入密码"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </label>
              {error && <p className="invite-error">{error}</p>}
              <div className="invite-actions">
                <button
                  type="submit"
                  className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                  disabled={submitting || !password || !confirm || (info.kind === 'customer' && !email)}
                >
                  <span className="dx-button-text">{submitting ? '提交中…' : '设置密码'}</span>
                </button>
              </div>
            </form>
          )}
        </div>
        </main>
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={<div className="invite-page">加载中…</div>}>
      <InviteForm />
    </Suspense>
  );
}
