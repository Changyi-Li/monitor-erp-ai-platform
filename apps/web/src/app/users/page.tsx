'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CreateUserResponseSchema,
  CustomerCreateResponseSchema,
  ResendInviteResponseSchema,
  ResetUserPasswordResponseSchema,
  UpdateUserResponseSchema,
  UsersListResponseSchema,
  type CreateUserResponse,
  type CustomerCreateResponse,
  type ResendInviteResponse,
  type UpdateUserResponse,
  type UserAdmin,
  type UsersListResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { useAuth } from '../../components/auth-provider';
import { userRoleLabel } from '../../lib/roles';
import type { UserRole } from '@monitor/shared';

/**
 * 用户管理（内部/超管专属；issue #37 模仿原版 WebClient「用户」程序布局）。
 * 布局：左侧平台账号列表（点击选中）→ 右侧 header 区（用户名 bnCurrentKey 风格 +
 * 描述 maxlength 35 + 保存）+ 页签条（通用/角色/用户权限，通用默认 active）。
 * 最小字段集：只呈现平台已有字段（邮箱/显示名/角色/状态/描述），不引入
 * Monitor ERP 专属字段；角色/用户权限页签内容由 #38 完善。
 * 建内部用户（US-3）与建客户表单保留在「管理操作」工具区（超管专属）。
 */
export default function UsersPage() {
  const { user, refresh } = useAuth();
  const [data, setData] = useState<UsersListResponse | null>(null);
  const [error, setError] = useState('');

  // 选中用户 + 描述草稿（header 区可编辑，保存走 PATCH /api/users/:id）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveOk, setSaveOk] = useState('');

  // 角色草稿（#38 角色页签：超管可改平台角色；保存走同一 PATCH 端点）
  const [roleDraft, setRoleDraft] = useState<UserRole>('internal');
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleSaveError, setRoleSaveError] = useState('');
  const [roleSaveOk, setRoleSaveOk] = useState('');

  // 重置密码（#39 安全页签：改自己 = 任何登录角色；改别人 = 仅超管）
  const [resetPw, setResetPw] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetOk, setResetOk] = useState('');

  // 页签（原版 mwc-tabs；角色/用户权限内容 #38 完善，本 ticket 先呈现只读摘要；
  // 安全 = #39 验证方式只读 + 重置密码（所有登录用户可见，可改自己）；
  // 管理操作 = 建内部用户/建客户，超管专属，跟在「安全」后面）
  const [activeTab, setActiveTab] = useState<'general' | 'roles' | 'permissions' | 'security' | 'admin'>('general');

  // 左侧列表按昵称搜索（#37 迭代：昵称唯一，支持搜索）
  const [nameQuery, setNameQuery] = useState('');

  // 账号列表 accordion 分组（grilling）：客户用户 / 内部与管理员，组头点击展开收起
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    customer: true,
    platform: true,
  });

  // 未激活客户邀请链接重发（grilling：链接再发放）——选中用户变化时复位
  const [resend, setResend] = useState<ResendInviteResponse | null>(null);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState('');
  const [resendCopied, setResendCopied] = useState(false);

  // 昵称编辑草稿（grilling：通用页签可编辑；本人或超管）
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameSaveOk, setDisplayNameSaveOk] = useState('');
  const [displayNameSaveError, setDisplayNameSaveError] = useState('');

  // 管理操作（建内部用户/建客户，超管专属，US-3）
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // 创建客户成功弹窗（#51）：存响应（含 inviteUrl）+ 绑定邮箱；null = 关闭
  const [inviteModal, setInviteModal] = useState<{ res: CustomerCreateResponse; email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', industry: '', region: '' });
  const [userForm, setUserForm] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'internal',
  });
  const [userCreating, setUserCreating] = useState(false);
  const [userCreateError, setUserCreateError] = useState('');
  const [userCreated, setUserCreated] = useState<CreateUserResponse | null>(null);

  useEffect(() => {
    apiFetch('/api/users', { schema: UsersListResponseSchema })
      .then((res) => {
        setData(res);
        // 默认选中第一个用户（原版程序进入即选中首行）
        setSelectedId((cur) => cur ?? res.users[0]?.id ?? null);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const selectedUser: UserAdmin | undefined = useMemo(
    () => data?.users.find((u) => u.id === selectedId),
    [data, selectedId],
  );

  // 左侧列表按昵称过滤（#37 迭代：昵称唯一 + 搜索）
  const filteredUsers = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    const list = data?.users ?? [];
    if (!q) return list;
    return list.filter((u) => u.displayName.toLowerCase().includes(q));
  }, [data, nameQuery]);

  // accordion 分组（grilling）：客户用户 vs 内部与管理员（超管归内部组）
  const groupedUsers = useMemo(
    () => ({
      customer: filteredUsers.filter((u) => u.role === 'customer'),
      platform: filteredUsers.filter((u) => u.role !== 'customer'),
    }),
    [filteredUsers],
  );

  // 选中用户变化 → 描述/角色草稿同步（避免保存旧用户残留）+ 重置密码状态清零
  useEffect(() => {
    setDescriptionDraft(selectedUser?.description ?? '');
    setRoleDraft(selectedUser?.role ?? 'internal');
    setDisplayNameDraft(selectedUser?.displayName ?? '');
    setSaveOk('');
    setSaveError('');
    setRoleSaveOk('');
    setRoleSaveError('');
    setResetPw('');
    setResetError('');
    setResetOk('');
    // 邀请链接重发结果跟随选中用户，切换即清空
    setResend(null);
    setResendError('');
    setResendCopied(false);
    setDisplayNameSaveOk('');
  }, [selectedUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSuperAdmin = user?.role === 'super_admin';

  // header 保存按钮：保存页面上所有操作（描述 + 角色变更一起提交，用户定义）
  async function handleSaveAll(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) return;
    // 角色变更仅当目标非自己、非 customer（后端对应 409 防护）时随描述一起提交
    const canChangeRole =
      isSuperAdmin && selectedUser.id !== user?.id && selectedUser.role !== 'customer';
    const roleChanged = canChangeRole && roleDraft !== selectedUser.role;
    setSaveError('');
    setSaveOk('');
    setRoleSaveError('');
    setRoleSaveOk('');
    setSaving(true);
    try {
      const res = await apiFetch(`/api/users/${selectedUser.id}`, {
        method: 'PATCH',
        body: {
          description: descriptionDraft || null,
          ...(roleChanged && { role: roleDraft }),
        },
        schema: UpdateUserResponseSchema,
      });
      // 同步列表数据（持久化后刷新可见）
      setData((cur) =>
        cur
          ? { users: cur.users.map((u) => (u.id === res.user.id ? res.user : u)) }
          : cur,
      );
      setSaveOk('已保存');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRole(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser || roleDraft === selectedUser.role) return;
    setRoleSaveError('');
    setRoleSaveOk('');
    setRoleSaving(true);
    try {
      const res = await apiFetch(`/api/users/${selectedUser.id}`, {
        method: 'PATCH',
        body: { role: roleDraft },
        schema: UpdateUserResponseSchema,
      });
      // 同步列表数据（角色持久化后列表与页签可见）；JWT 携带旧角色声明，
      // 被改用户重新登录后权限才生效（RolesGuard 从 JWT 读角色）
      setData((cur) =>
        cur
          ? { users: cur.users.map((u) => (u.id === res.user.id ? res.user : u)) }
          : cur,
      );
      setRoleSaveOk('角色已更新，该用户重新登录后生效');
    } catch (err) {
      setRoleSaveError(errorMessage(err));
    } finally {
      setRoleSaving(false);
    }
  }

  /** 重置密码（#39）：改自己 = 任何登录角色；改别人 = 仅超管（后端 service 层鉴权兜底） */
  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser || !resetPw) return;
    setResetError('');
    setResetOk('');
    setResetting(true);
    try {
      await apiFetch(`/api/users/${selectedUser.id}/reset-password`, {
        method: 'POST',
        body: { password: resetPw },
        schema: ResetUserPasswordResponseSchema,
      });
      setResetPw('');
      setResetOk('密码已重置，新密码已生效');
    } catch (err) {
      setResetError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setUserCreateError('');
    setUserCreated(null);
    setUserCreating(true);
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        body: {
          email: userForm.email,
          password: userForm.password,
          displayName: userForm.displayName || undefined,
          role: userForm.role,
        },
        schema: CreateUserResponseSchema,
      });
      setUserCreated(res);
      setUserForm({ email: '', displayName: '', password: '', role: 'internal' });
      const fresh = await apiFetch('/api/users', { schema: UsersListResponseSchema });
      setData(fresh);
    } catch (err) {
      setUserCreateError(errorMessage(err));
    } finally {
      setUserCreating(false);
    }
  }

  async function handleCreateCustomer(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        body: {
          name: form.name,
          email: form.email,
          industry: form.industry || undefined,
          region: form.region || undefined,
        },
        schema: CustomerCreateResponseSchema,
      });
      setInviteModal({ res, email: form.email });
      setForm({ name: '', email: '', industry: '', region: '' });
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  // 复制邀请链接（#51）：成功图标切对勾，1.6s 复位
  async function handleCopy() {
    if (!inviteModal) return;
    try {
      await navigator.clipboard.writeText(inviteModal.res.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用（非 HTTPS 等）：静默失败，链接可手动选中复制
    }
  }

  /** 昵称编辑（grilling）：本人或超管；保存后同步列表；改自己 → 刷新顶栏昵称 */
  async function handleSaveDisplayName(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser || !displayNameDraft.trim()) return;
    if (displayNameDraft.trim() === selectedUser.displayName) return;
    setDisplayNameSaveOk('');
    setDisplayNameSaving(true);
    try {
      const res = await apiFetch(`/api/users/${selectedUser.id}`, {
        method: 'PATCH',
        body: { displayName: displayNameDraft.trim() },
        schema: UpdateUserResponseSchema,
      });
      setData((cur) =>
        cur
          ? { users: cur.users.map((u) => (u.id === res.user.id ? res.user : u)) }
          : cur,
      );
      if (selectedUser.id === user?.id) {
        await refresh();
      }
      setDisplayNameSaveOk('昵称已更新');
    } catch (err) {
      setDisplayNameSaveError(errorMessage(err));
    } finally {
      setDisplayNameSaving(false);
    }
  }

  /** 重发客户邀请（grilling）：重新生成 token——旧链接立即失效，有效期刷新 7 天 */
  async function handleResend() {
    if (!selectedUser) return;
    setResendError('');
    setResending(true);
    try {
      const res = await apiFetch(`/api/users/${selectedUser.id}/resend-invite`, {
        method: 'POST',
        schema: ResendInviteResponseSchema,
      });
      setResend(res);
      setResendCopied(false);
    } catch (err) {
      setResendError(errorMessage(err));
    } finally {
      setResending(false);
    }
  }

  /** 复制重发后的邀请链接（grilling）：成功图标切对勾，1.6s 复位 */
  async function handleResendCopy() {
    if (!resend) return;
    try {
      await navigator.clipboard.writeText(resend.inviteUrl);
      setResendCopied(true);
      setTimeout(() => setResendCopied(false), 1600);
    } catch {
      // 剪贴板不可用（非 HTTPS 等）：静默失败，链接可手动选中复制
    }
  }

  // Esc 关闭弹窗（#51）：关闭按钮 / 遮罩点击 / Esc 三种方式
  useEffect(() => {
    if (!inviteModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInviteModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inviteModal]);

  // 输入框样式走 CSS 类 .up-input（原版 dx-editor-filled：浅灰填充底 +
  // 细边框，hover/focus 变主色，见 globals.css .users-page 块）
  return (
    <div className="users-page" style={{ width: '100%', paddingBottom: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 16px' }}>用户</h2>
      {error && <p className="up-error">{error}</p>}

      {/* 主区：左侧账号列表 + 右侧详情（全宽卡片铺满内容区，对齐原版） */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左侧列表：面板（1px 边框 + 4px 圆角）+ 选中 = 3px 主色竖条 + 网格选中蓝 */}
        <aside className="up-panel" style={{ width: 260, flexShrink: 0 }}>
          <div className="up-panel-header">
            平台账号（{data?.users.length ?? 0}）
          </div>
          {/* 昵称搜索（#37 迭代）：按 displayName 实时过滤列表；
             透明底 + 底边线（聚焦变主色），与侧边菜单 search-form 同构 */}
          <div className="up-search-wrap">
            <input
              type="text"
              placeholder="按昵称搜索…"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              className="up-search"
            />
          </div>
          {/* 账号列表（grilling accordion 分组）：客户用户 vs 内部与管理员，
              组头 = 原版树形折叠样式（箭头 + 分组名 + 计数），点击展开/收起；
              搜索关键字时两组自动展开（Monitor 树形搜索语义：展示匹配） */}
          <ul className="up-list" style={{ maxHeight: 380, overflowY: 'auto' }}>
            {filteredUsers.length === 0 ? (
              <li className="up-item-sub" style={{ padding: 12 }}>
                {nameQuery.trim() ? '无匹配昵称' : '暂无账号'}
              </li>
            ) : (
              (
                [
                  ['customer', '客户用户', groupedUsers.customer],
                  ['platform', '内部与管理员', groupedUsers.platform],
                ] as const
              ).map(([key, label, users]) => {
                const open = nameQuery.trim() !== '' || openGroups[key];
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="up-acc-header"
                      onClick={() =>
                        setOpenGroups((g) => ({ ...g, [key]: !g[key] }))
                      }
                      aria-expanded={open}
                    >
                      <i
                        className={`fa-solid fa-chevron-right up-acc-chevron${open ? ' open' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="up-acc-label">{label}</span>
                      <span className="up-acc-count">{users.length}</span>
                    </button>
                    {open && (
                      <ul className="up-acc-body">
                        {users.length === 0 ? (
                          <li className="up-item-sub" style={{ padding: '6px 12px' }}>
                            无匹配账号
                          </li>
                        ) : (
                          users.map((u) => (
                            <li key={u.id}>
                              <button
                                type="button"
                                onClick={() => setSelectedId(u.id)}
                                className={`up-item${selectedId === u.id ? ' selected' : ''}`}
                              >
                                <div className="up-item-name">{u.displayName}</div>
                                <div className="up-item-sub">
                                  {u.email} · {userRoleLabel(u.role)}
                                  {u.role === 'customer' && !u.isActive ? ' · 未激活' : ''}
                                </div>
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* 右侧详情 */}
        <section style={{ flex: 1, minWidth: 0 }}>
          {!selectedUser ? (
            <p style={{ color: 'var(--mwc-text-light)', fontSize: 13, padding: 24 }}>
              请选择左侧用户查看详情
            </p>
          ) : (
            <>
              {/* header 区（原版 section.header = mwc-box 卡片）：
                  卡片标题 + 昵称大字/描述/保存，下方接页签条 */}
              <form onSubmit={handleSaveAll} className="up-card" style={{ display: 'block' }}>
                <div className="up-card-title">用户信息</div>
                <div
                  className="up-card-body"
                  style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}
                >
                  <div>
                    <label className="up-label">昵称</label>
                    {/* bnCurrentKey 风格：主键大字展示——昵称（#37 迭代：用户名位置放昵称） */}
                    <div className="up-keyname">{selectedUser.displayName}</div>
                    <div className="up-subtext">{selectedUser.email}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <label className="up-label">描述</label>
                    <input
                      type="text"
                      maxLength={35}
                      value={descriptionDraft}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      disabled={!isSuperAdmin}
                      placeholder={isSuperAdmin ? '输入描述（最多 35 字符）' : '（无描述）'}
                      className="up-input"
                      style={{ width: '100%' }}
                    />
                  </div>
                  {isSuperAdmin && (
                    <button
                      type="submit"
                      className="icon-button-action"
                      disabled={saving}
                      title={saving ? '保存中…' : '保存'}
                      aria-label="保存"
                      data-testid="save-description"
                      style={{ marginLeft: 'auto' }}
                    >
                      {/* 保存按钮图标（Font Awesome 免费版 fa-floppy-disk，替代原版 icon-button-save；fs-3 放大） */}
                      <i className="fa-solid fa-floppy-disk fs-3 color-primary" aria-hidden="true" data-testid="icon" />
                    </button>
                  )}
                  <div style={{ width: '100%' }}>
                    {saveError && <span className="up-error" style={{ fontSize: 12 }}>{saveError}</span>}
                    {saveOk && <span className="up-success" style={{ fontSize: 12 }}>{saveOk}</span>}
                  </div>
                </div>
              </form>

              {/* 邀请链接重发（grilling：客户丢失链接 → 重新生成 + 复制）。
                  仅超管可见；重发语义 = 旧链接立即失效、有效期刷新 7 天 */}
              {isSuperAdmin &&
                selectedUser.role === 'customer' &&
                !selectedUser.isActive &&
                selectedUser.inviteKind === 'customer' && (
                <div className="up-card" style={{ marginTop: 12 }}>
                  <div className="up-card-title">邀请链接（账号未激活）</div>
                  <div className="up-card-body">
                    <p
                      style={{
                        margin: 0,
                        fontSize: 13,
                        color: 'var(--mwc-text-light)',
                        lineHeight: 1.6,
                      }}
                    >
                      该客户联系人尚未激活账号。邀请链接 7 天内有效，绑定{' '}
                      {selectedUser.email}。客户丢失链接时可重新生成——
                      旧链接立即失效，有效期重新计算。
                    </p>
                    {!resend ? (
                      <button
                        type="button"
                        onClick={handleResend}
                        disabled={resending}
                        className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                        style={{ marginTop: 10 }}
                      >
                        <span className="dx-button-text">
                          {resending ? '生成中…' : '重新生成链接'}
                        </span>
                      </button>
                    ) : (
                      <>
                        <div className="up-invite-row" style={{ marginTop: 10 }}>
                          <input
                            readOnly
                            value={resend.inviteUrl}
                            className="up-input"
                            aria-label="邀请链接"
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="icon-button-action"
                            aria-label={resendCopied ? '已复制' : '复制链接'}
                            title="复制链接"
                            onClick={handleResendCopy}
                          >
                            <i
                              className={`fa-solid ${resendCopied ? 'fa-check' : 'fa-copy'} fs-3 ${resendCopied ? 'color-success-strong' : 'color-primary'}`}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--mwc-text-light)',
                            marginTop: 6,
                          }}
                        >
                          有效期至{' '}
                          {new Date(resend.expiresAt).toLocaleString()}；旧链接已失效
                        </div>
                        <button
                          type="button"
                          onClick={handleResend}
                          disabled={resending}
                          className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                          style={{ marginTop: 10 }}
                        >
                          <span className="dx-button-text">
                            {resending ? '生成中…' : '再次重新生成'}
                          </span>
                        </button>
                      </>
                    )}
                    {resendError && (
                      <p className="up-error" style={{ marginTop: 8 }}>
                        {resendError}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* 页签条（原版 mwc-tabs：2px 分隔线 + 3px 主色下划线） */}
              <div className="up-tabbar" role="tablist">
                {(
                  [
                    ['general', '通用'],
                    ['roles', '角色'],
                    ['permissions', '用户权限'],
                    ['security', '安全'],
                    ['admin', '管理操作'],
                  ] as const
                )
                  // 安全 = 所有登录用户可见（可改自己密码）；管理操作 = 超管专属页签
                  .filter(([key]) => key !== 'admin' || isSuperAdmin)
                  .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    className={`up-tab${activeTab === key ? ' active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 页签内容：mwc-box property-group 卡片（原版质感，铺满内容区） */}
              <div style={{ padding: '12px 0 8px' }}>
                {activeTab === 'general' && (
                  <div className="up-card">
                    <div className="up-card-title">通用</div>
                    <div className="up-card-body">
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: '12px 24px',
                        }}
                      >
                        <Field label="邮箱" value={selectedUser.email} />
                        {/* 昵称编辑（grilling）：本人或超管可改；保存 PATCH displayName，
                            改自己时刷新顶栏昵称（auth 上下文） */}
                        <div>
                          <div className="up-label">显示名</div>
                          {isSuperAdmin || selectedUser.id === user?.id ? (
                            <>
                              <form
                                onSubmit={handleSaveDisplayName}
                                className="up-form-row"
                                style={{ marginTop: 4 }}
                              >
                                <input
                                  value={displayNameDraft}
                                  onChange={(e) => {
                                    setDisplayNameDraft(e.target.value);
                                    setDisplayNameSaveOk('');
                                  }}
                                  maxLength={64}
                                  className="up-input"
                                  aria-label="显示名"
                                />
                                <button
                                  type="submit"
                                  disabled={
                                    displayNameSaving ||
                                    !displayNameDraft.trim() ||
                                    displayNameDraft.trim() === selectedUser.displayName
                                  }
                                  className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                                >
                                  <span className="dx-button-text">
                                    {displayNameSaving ? '保存中…' : '保存'}
                                  </span>
                                </button>
                              </form>
                              {displayNameSaveOk && (
                                <span className="up-success">{displayNameSaveOk}</span>
                              )}
                              {displayNameSaveError && (
                                <span className="up-error">{displayNameSaveError}</span>
                              )}
                            </>
                          ) : (
                            <div style={{ fontSize: 13, color: 'var(--mwc-text)' }}>
                              {selectedUser.displayName}
                            </div>
                          )}
                        </div>
                        <Field label="角色" value={userRoleLabel(selectedUser.role)} />
                        <Field label="状态" value={selectedUser.isActive ? '正常' : '未激活/已停用'} />
                        <Field
                          label="创建时间"
                          value={new Date(selectedUser.createdAt).toLocaleString()}
                        />
                        <Field label="描述" value={selectedUser.description ?? '—'} />
                      </div>
                    </div>
                  </div>
                )}
                {activeTab === 'roles' && (
                  <div className="up-card">
                    <div className="up-card-title">角色</div>
                    <div className="up-card-body" style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--mwc-text)' }}>
                      <p style={{ margin: 0 }}>
                        当前角色：
                        <strong>{userRoleLabel(selectedUser.role)}</strong>
                      </p>
                    <p style={{ margin: '4px 0 0', color: 'var(--mwc-text-light)' }}>
                      {selectedUser.role === 'super_admin'
                        ? '超级管理员：全部功能 + 平台管理（用户/客户）。'
                        : selectedUser.role === 'internal'
                          ? '内部用户：全部业务功能与 AI 工具。'
                          : '客户角色：仅客户/项目/知识库。'}
                    </p>
                    {isSuperAdmin ? (
                      // #38：超管可改平台角色（self 与 customer 不可改，用户已拍板）
                      selectedUser.id === user?.id ? (
                        <p style={{ margin: '8px 0 0', color: 'var(--mwc-text-light)' }}>
                          不能修改自己的角色
                        </p>
                      ) : selectedUser.role === 'customer' ? (
                        <p style={{ margin: '8px 0 0', color: 'var(--mwc-text-light)' }}>
                          客户角色不可在此修改
                        </p>
                      ) : (
                        <form
                          onSubmit={handleSaveRole}
                          className="up-form-row"
                          style={{ marginTop: 12 }}
                        >
                          <select
                            value={roleDraft}
                            onChange={(e) => setRoleDraft(e.target.value as UserRole)}
                            className="up-input"
                            aria-label="角色"
                          >
                            {(['internal', 'super_admin'] as const).map((r) => (
                              <option key={r} value={r}>
                                {userRoleLabel(r)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            disabled={roleSaving || roleDraft === selectedUser.role}
                            className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                          >
                            <span className="dx-button-text">{roleSaving ? '保存中…' : '保存'}</span>
                          </button>
                          {roleSaveOk && <span className="up-success">{roleSaveOk}</span>}
                          {roleSaveError && <span className="up-error">{roleSaveError}</span>}
                        </form>
                      )
                    ) : null}
                    </div>
                  </div>
                )}
                {activeTab === 'permissions' && (
                  <div className="up-card">
                    <div className="up-card-title">用户权限</div>
                    <div className="up-card-body" style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--mwc-text)' }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>权限范围（按角色推导）</p>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                      {selectedUser.role === 'customer' ? (
                        <>
                          <li>客户管理（仅本客户相关）</li>
                          <li>项目：查看与参与项目</li>
                          <li>知识库：已发布文档</li>
                        </>
                      ) : (
                        <>
                          <li>客户、项目、知识库全部功能</li>
                          <li>
                            平台功能：AI 客服、用量统计、AI 配置、RAG 调试台、导入调试台
                            {selectedUser.role === 'super_admin' ? '、用户管理' : ''}
                          </li>
                        </>
                      )}
                    </ul>
                    </div>
                  </div>
                )}
                {activeTab === 'security' && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                      gap: 12,
                      alignItems: 'start',
                    }}
                  >
                    <section className="up-card">
                      <div className="up-card-title">验证方式（只读）</div>
                      <div className="up-card-body">
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: '12px 24px' }}>
                          <Field label="邮箱" value={selectedUser.email} />
                          {/* 不暴露密码明文，只展示状态（原版安全页签同样只显示掩码） */}
                          <Field label="密码" value={selectedUser.id === user?.id ? '（本人账号）' : '已设置'} />
                        </div>
                      </div>
                    </section>
                    <section className="up-card">
                      <div className="up-card-title">重置密码</div>
                      <div className="up-card-body">
                        {selectedUser.id === user?.id || isSuperAdmin ? (
                          <form onSubmit={handleResetPassword} className="up-form-row">
                            <input
                              type="password"
                              placeholder="新密码（至少 6 位）"
                              value={resetPw}
                              onChange={(e) => setResetPw(e.target.value)}
                              className="up-input"
                              autoComplete="new-password"
                            />
                            <button
                              type="submit"
                              disabled={resetting || resetPw.length < 6}
                              className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                            >
                              <span className="dx-button-text">{resetting ? '重置中…' : '重置密码'}</span>
                            </button>
                            {resetOk && <span className="up-success">{resetOk}</span>}
                            {resetError && <span className="up-error">{resetError}</span>}
                          </form>
                        ) : (
                          <p style={{ margin: 0, fontSize: 13, color: 'var(--mwc-text-light)' }}>
                            只能修改自己的密码
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                )}
                {activeTab === 'admin' && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                      gap: 12,
                      alignItems: 'start',
                    }}
                  >
                    <section className="up-card">
                      <div className="up-card-title">创建内部用户（US-3）</div>
                      <div className="up-card-body">
                        <form onSubmit={handleCreateUser} className="up-form-row">
                        <input
                          type="email"
                          placeholder="邮箱"
                          value={userForm.email}
                          onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                          className="up-input"
                        />
                        <input
                          placeholder="昵称（唯一，可先留空）"
                          value={userForm.displayName}
                          onChange={(e) => setUserForm({ ...userForm, displayName: e.target.value })}
                          className="up-input"
                        />
                        <input
                          type="password"
                          placeholder="初始密码（至少 6 位）"
                          value={userForm.password}
                          onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                          className="up-input"
                        />
                        <select
                          value={userForm.role}
                          onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                          className="up-input"
                        >
                          {(['internal', 'super_admin'] as const).map((r) => (
                            <option key={r} value={r}>
                              {userRoleLabel(r)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          disabled={userCreating || !userForm.email || !userForm.password}
                          className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                        >
                          <span className="dx-button-text">{userCreating ? '创建中…' : '创建内部用户'}</span>
                        </button>
                      </form>
                      {userCreateError && <p className="up-error">{userCreateError}</p>}
                        {userCreated && (
                          <p className="up-success">
                            已创建用户：{userCreated.user.displayName}（{userCreated.user.email} ·{' '}
                            {userRoleLabel(userCreated.user.role)}）——描述默认取昵称，可在通用页签查看
                          </p>
                        )}
                      </div>
                    </section>
                    <section className="up-card">
                      <div className="up-card-title">创建客户</div>
                      <div className="up-card-body">
                        <form onSubmit={handleCreateCustomer} className="up-form-row">
                        <input
                          placeholder="客户名称"
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="up-input"
                        />
                        <input
                          type="email"
                          placeholder="联系人邮箱（必填）"
                          value={form.email}
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                          className="up-input"
                        />
                        <input
                          placeholder="行业（可选）"
                          value={form.industry}
                          onChange={(e) => setForm({ ...form, industry: e.target.value })}
                          className="up-input"
                        />
                        <input
                          placeholder="地区（可选）"
                          value={form.region}
                          onChange={(e) => setForm({ ...form, region: e.target.value })}
                          className="up-input"
                        />
                        <button
                          type="submit"
                          disabled={creating || !form.name || !form.email}
                          className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                        >
                          <span className="dx-button-text">{creating ? '创建中…' : '创建客户'}</span>
                        </button>
                      </form>
                        {createError && <p className="up-error">{createError}</p>}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 创建客户成功 → 邀请链接弹窗（#51）：mwc 卡片质感，
          关闭方式 = 右上 × / 点击遮罩 / Esc；复制按钮成功切对勾 */}
      {inviteModal && (
        <div className="up-modal-backdrop" onClick={() => setInviteModal(null)}>
          <div
            className="up-modal"
            role="dialog"
            aria-modal="true"
            aria-label="客户创建成功"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="up-modal-header">
              <div className="up-modal-title">客户创建成功</div>
              <button
                type="button"
                className="icon-button-action"
                onClick={() => setInviteModal(null)}
                aria-label="关闭"
              >
                <i className="fa-solid fa-xmark fs-3 color-primary" aria-hidden="true" />
              </button>
            </div>
            <div className="up-modal-body">
              <div style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>客户名称</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--mwc-text)' }}>
                {inviteModal.res.customer.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--mwc-text-light)', marginTop: 14, marginBottom: 6 }}>
                邀请链接（7 天内有效，绑定 {inviteModal.email}，仅该邮箱可激活）
              </div>
              <div className="up-invite-row">
                <input
                  readOnly
                  value={inviteModal.res.inviteUrl}
                  className="up-input"
                  aria-label="邀请链接"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="icon-button-action"
                  aria-label={copied ? '已复制' : '复制链接'}
                  title="复制链接"
                  onClick={handleCopy}
                >
                  <i
                    className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'} fs-3 ${copied ? 'color-success-strong' : 'color-primary'}`}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 只读字段（通用页签）：label 12px 灰 + value 13px（原版 dx-field 同构） */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--mwc-text-light)' }}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--mwc-text)', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
