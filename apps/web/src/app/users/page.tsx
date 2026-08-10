'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CreateUserResponseSchema,
  CustomerCreateResponseSchema,
  UpdateUserResponseSchema,
  UsersListResponseSchema,
  type CreateUserResponse,
  type CustomerCreateResponse,
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
  const { user } = useAuth();
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

  // 页签（原版 mwc-tabs；角色/用户权限内容 #38 完善，本 ticket 先呈现只读摘要；
  // 管理操作 = 建内部用户/建客户，超管专属，跟在「用户权限」后面）
  const [activeTab, setActiveTab] = useState<'general' | 'roles' | 'permissions' | 'admin'>('general');

  // 左侧列表按昵称搜索（#37 迭代：昵称唯一，支持搜索）
  const [nameQuery, setNameQuery] = useState('');

  // 管理操作（建内部用户/建客户，超管专属，US-3）
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [created, setCreated] = useState<CustomerCreateResponse | null>(null);
  const [form, setForm] = useState({ name: '', industry: '', region: '' });
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

  // 选中用户变化 → 描述/角色草稿同步（避免保存旧用户残留）
  useEffect(() => {
    setDescriptionDraft(selectedUser?.description ?? '');
    setRoleDraft(selectedUser?.role ?? 'internal');
    setSaveOk('');
    setSaveError('');
    setRoleSaveOk('');
    setRoleSaveError('');
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
    setCreated(null);
    setCreating(true);
    try {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        body: {
          name: form.name,
          industry: form.industry || undefined,
          region: form.region || undefined,
        },
        schema: CustomerCreateResponseSchema,
      });
      setCreated(res);
      setForm({ name: '', industry: '', region: '' });
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  const inputStyle = {
    padding: '6px 8px',
    border: '1px solid var(--mwc-border, #d1d5db)',
    borderRadius: 4,
    fontSize: 13,
  } as const;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '8px 0' }}>
      <h2 style={{ fontSize: 18, margin: '0 0 12px' }}>用户</h2>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {/* 主区：左侧账号列表 + 右侧详情（原版「用户」程序布局） */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* 左侧列表 */}
        <aside
          style={{
            width: 260,
            flexShrink: 0,
            border: '1px solid var(--mwc-border, #e5e7eb)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              fontSize: 13,
              fontWeight: 600,
              borderBottom: '1px solid var(--mwc-border, #e5e7eb)',
              background: 'var(--mwc-lighter, #f9fafb)',
            }}
          >
            平台账号（{data?.users.length ?? 0}）
          </div>
          {/* 昵称搜索（#37 迭代）：按 displayName 实时过滤列表 */}
          <div style={{ padding: 8, borderBottom: '1px solid var(--mwc-border, #e5e7eb)' }}>
            <input
              type="text"
              placeholder="按昵称搜索…"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 380, overflowY: 'auto' }}>
            {filteredUsers.length === 0 ? (
              <li style={{ padding: '12px', fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>
                {nameQuery.trim() ? '无匹配昵称' : '暂无账号'}
              </li>
            ) : (
              filteredUsers.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(u.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 12px',
                      border: 'none',
                      borderBottom: '1px solid var(--mwc-border, #f3f4f6)',
                      cursor: 'pointer',
                      background: selectedId === u.id
                        ? 'var(--mwc-primary-light, #eef2ff)'
                        : 'transparent',
                      fontSize: 13,
                      color: 'var(--mwc-text, #1f2937)',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{u.displayName}</div>
                    <div style={{ fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>
                      {u.email} · {userRoleLabel(u.role)}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* 右侧详情 */}
        <section style={{ flex: 1, minWidth: 0 }}>
          {!selectedUser ? (
            <p style={{ color: 'var(--mwc-text-light, #6b7280)', fontSize: 13, padding: 24 }}>
              请选择左侧用户查看详情
            </p>
          ) : (
            <>
              {/* header 区（原版 header section：bnCurrentKey + 描述 + 许可） */}
              <form
                onSubmit={handleSaveAll}
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 16,
                  flexWrap: 'wrap',
                  padding: '14px 16px',
                  border: '1px solid var(--mwc-border, #e5e7eb)',
                  borderRadius: '8px 8px 0 0',
                  background: 'var(--mwc-lighter, #f9fafb)',
                }}
              >
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>
                    昵称
                  </label>
                  {/* bnCurrentKey 风格：主键大字展示——昵称（#37 迭代：用户名位置放昵称） */}
                  <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--mwc-primary, #1a56db)' }}>
                    {selectedUser.displayName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>
                    {selectedUser.email}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>
                    描述
                  </label>
                  <input
                    type="text"
                    maxLength={35}
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    disabled={!isSuperAdmin}
                    placeholder={isSuperAdmin ? '输入描述（最多 35 字符）' : '（无描述）'}
                    style={{
                      ...inputStyle,
                      width: '100%',
                      background: isSuperAdmin ? '#fff' : 'var(--mwc-lighter, #f9fafb)',
                    }}
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
                  {saveError && <span style={{ color: '#b91c1c', fontSize: 12 }}>{saveError}</span>}
                  {saveOk && <span style={{ color: '#15803d', fontSize: 12 }}>{saveOk}</span>}
                </div>
              </form>

              {/* 页签条（原版 mwc-tabs） */}
              <div
                style={{
                  display: 'flex',
                  gap: 4,
                  borderBottom: '2px solid var(--mwc-border, #e5e7eb)',
                  padding: '0 12px',
                  background: '#fff',
                }}
                role="tablist"
              >
                {(
                  [
                    ['general', '通用'],
                    ['roles', '角色'],
                    ['permissions', '用户权限'],
                    ['admin', '管理操作'],
                  ] as const
                )
                  // 管理操作 = 超管专属页签（内部用户无创建权限）
                  .filter(([key]) => key !== 'admin' || isSuperAdmin)
                  .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    style={{
                      padding: '10px 16px',
                      border: 'none',
                      borderBottom: activeTab === key ? '3px solid var(--mwc-primary, #1a56db)' : '3px solid transparent',
                      fontWeight: activeTab === key ? 700 : 400,
                      cursor: 'pointer',
                      background: 'transparent',
                      fontSize: 13,
                      color: activeTab === key
                        ? 'var(--mwc-primary, #1a56db)'
                        : 'var(--mwc-text-light, #6b7280)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 页签内容 */}
              <div
                style={{
                  border: '1px solid var(--mwc-border, #e5e7eb)',
                  borderTop: 'none',
                  borderRadius: '0 0 8px 8px',
                  padding: 16,
                  background: 'var(--mwc-lighter, #fff)',
                }}
              >
                {activeTab === 'general' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(180px, 1fr))', gap: '12px 24px', maxWidth: 640 }}>
                    <Field label="邮箱" value={selectedUser.email} />
                    <Field label="显示名" value={selectedUser.displayName} />
                    <Field label="角色" value={userRoleLabel(selectedUser.role)} />
                    <Field label="状态" value={selectedUser.isActive ? '正常' : '未激活/已停用'} />
                    <Field
                      label="创建时间"
                      value={new Date(selectedUser.createdAt).toLocaleString()}
                    />
                    <Field label="描述" value={selectedUser.description ?? '—'} />
                  </div>
                )}
                {activeTab === 'roles' && (
                  <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                    <p style={{ margin: 0 }}>
                      当前角色：
                      <strong>{userRoleLabel(selectedUser.role)}</strong>
                    </p>
                    <p style={{ margin: '4px 0 0', color: 'var(--mwc-text-light, #6b7280)' }}>
                      {selectedUser.role === 'super_admin'
                        ? '超级管理员：全部功能 + 平台管理（用户/客户）。'
                        : selectedUser.role === 'internal'
                          ? '内部用户：全部业务功能与 AI 工具。'
                          : '客户角色：仅客户/项目/知识库。'}
                    </p>
                    {isSuperAdmin ? (
                      // #38：超管可改平台角色（self 与 customer 不可改，用户已拍板）
                      selectedUser.id === user?.id ? (
                        <p style={{ margin: '8px 0 0', color: 'var(--mwc-text-light, #6b7280)' }}>
                          不能修改自己的角色
                        </p>
                      ) : selectedUser.role === 'customer' ? (
                        <p style={{ margin: '8px 0 0', color: 'var(--mwc-text-light, #6b7280)' }}>
                          客户角色不可在此修改
                        </p>
                      ) : (
                        <form
                          onSubmit={handleSaveRole}
                          style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            marginTop: 12,
                          }}
                        >
                          <select
                            value={roleDraft}
                            onChange={(e) => setRoleDraft(e.target.value as UserRole)}
                            style={inputStyle}
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
                          {roleSaveOk && <span style={{ color: '#15803d' }}>{roleSaveOk}</span>}
                          {roleSaveError && <span style={{ color: '#b91c1c' }}>{roleSaveError}</span>}
                        </form>
                      )
                    ) : null}
                  </div>
                )}
                {activeTab === 'permissions' && (
                  <div style={{ fontSize: 13, lineHeight: 1.8 }}>
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
                )}
                {activeTab === 'admin' && (
                  <div style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
                    <section>
                      <h3 style={{ fontSize: 13, margin: '0 0 8px', color: 'var(--mwc-text-light, #6b7280)' }}>
                        创建内部用户（US-3）
                      </h3>
                      <form
                        onSubmit={handleCreateUser}
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          padding: 12,
                          border: '1px solid #e5e7eb',
                          borderRadius: 8,
                          background: 'var(--mwc-lighter, #f9fafb)',
                        }}
                      >
                        <input
                          type="email"
                          placeholder="邮箱"
                          value={userForm.email}
                          onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                          style={inputStyle}
                        />
                        <input
                          placeholder="昵称（唯一，可先留空）"
                          value={userForm.displayName}
                          onChange={(e) => setUserForm({ ...userForm, displayName: e.target.value })}
                          style={inputStyle}
                        />
                        <input
                          type="password"
                          placeholder="初始密码（至少 6 位）"
                          value={userForm.password}
                          onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                          style={inputStyle}
                        />
                        <select
                          value={userForm.role}
                          onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                          style={inputStyle}
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
                      {userCreateError && <p style={{ color: '#b91c1c', fontSize: 13 }}>{userCreateError}</p>}
                      {userCreated && (
                        <p style={{ color: '#15803d', fontSize: 13 }}>
                          已创建用户：{userCreated.user.displayName}（{userCreated.user.email} ·{' '}
                          {userRoleLabel(userCreated.user.role)}）——描述默认取昵称，可在通用页签查看
                        </p>
                      )}
                    </section>
                    <section>
                      <h3 style={{ fontSize: 13, margin: '0 0 8px', color: 'var(--mwc-text-light, #6b7280)' }}>
                        创建客户
                      </h3>
                      <form
                        onSubmit={handleCreateCustomer}
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          padding: 12,
                          border: '1px solid #e5e7eb',
                          borderRadius: 8,
                          background: 'var(--mwc-lighter, #f9fafb)',
                        }}
                      >
                        <input
                          placeholder="客户名称"
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          style={inputStyle}
                        />
                        <input
                          placeholder="行业（可选）"
                          value={form.industry}
                          onChange={(e) => setForm({ ...form, industry: e.target.value })}
                          style={inputStyle}
                        />
                        <input
                          placeholder="地区（可选）"
                          value={form.region}
                          onChange={(e) => setForm({ ...form, region: e.target.value })}
                          style={inputStyle}
                        />
                        <button
                          type="submit"
                          disabled={creating || !form.name}
                          className="dx-button dx-button-mode-text dx-button-normal default mwc-defined-width dx-button-has-text"
                        >
                          <span className="dx-button-text">{creating ? '创建中…' : '创建客户'}</span>
                        </button>
                      </form>
                      {createError && <p style={{ color: '#b91c1c', fontSize: 13 }}>{createError}</p>}
                      {created && (
                        <p style={{ color: '#15803d', fontSize: 13 }}>
                          已创建客户：{created.customer.name}（ID：{created.customer.id}）——可在项目详情页邀请成员时使用该 ID
                        </p>
                      )}
                    </section>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** 只读字段（通用页签） */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--mwc-text-light, #6b7280)' }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
