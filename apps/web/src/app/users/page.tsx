'use client';

import { useEffect, useState } from 'react';
import {
  CreateUserResponseSchema,
  CustomerCreateResponseSchema,
  UsersListResponseSchema,
  type CreateUserResponse,
  type CustomerCreateResponse,
  type UsersListResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { useAuth } from '../../components/auth-provider';
import { userRoleLabel } from '../../lib/roles';

/**
 * 用户管理（内部/超管专属；超管额外有建内部用户（US-3）与建客户入口——demo path）。
 * 建客户账号走项目成员邀请（/projects/:id 内发送邀请），此处为平台总览。
 */
export default function UsersPage() {
  const { user } = useAuth();
  const [data, setData] = useState<UsersListResponse | null>(null);
  const [error, setError] = useState('');
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
      .then(setData)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

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

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h2>用户管理</h2>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {user?.role === 'super_admin' && (
        <section style={{ marginBottom: 24 }}>
          <h3>创建内部用户（超管专属）</h3>
          <form
            onSubmit={handleCreateUser}
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              padding: 12,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}
          >
            <input
              type="email"
              placeholder="邮箱"
              value={userForm.email}
              onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
            />
            <input
              placeholder="显示名（可选）"
              value={userForm.displayName}
              onChange={(e) => setUserForm({ ...userForm, displayName: e.target.value })}
            />
            <input
              type="password"
              placeholder="初始密码（至少 8 位）"
              value={userForm.password}
              onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            />
            <select
              value={userForm.role}
              onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
            >
              {(['internal', 'super_admin'] as const).map((r) => (
                <option key={r} value={r}>
                  {userRoleLabel(r)}
                </option>
              ))}
            </select>
            <button type="submit" disabled={userCreating || !userForm.email || !userForm.password}>
              {userCreating ? '创建中…' : '创建用户'}
            </button>
          </form>
          {userCreateError && <p style={{ color: '#b91c1c' }}>{userCreateError}</p>}
          {userCreated && (
            <p style={{ color: '#15803d' }}>
              已创建用户：{userCreated.user.displayName}（{userCreated.user.email} ·{' '}
              {userRoleLabel(userCreated.user.role)}）——本人登录后可自行修改资料
            </p>
          )}
        </section>
      )}

      {user?.role === 'super_admin' && (
        <section style={{ marginBottom: 24 }}>
          <h3>创建客户（超管专属）</h3>
          <form
            onSubmit={handleCreateCustomer}
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              padding: 12,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}
          >
            <input
              placeholder="客户名称"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              placeholder="行业（可选）"
              value={form.industry}
              onChange={(e) => setForm({ ...form, industry: e.target.value })}
            />
            <input
              placeholder="地区（可选）"
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
            <button type="submit" disabled={creating || !form.name}>
              {creating ? '创建中…' : '创建客户'}
            </button>
          </form>
          {createError && <p style={{ color: '#b91c1c' }}>{createError}</p>}
          {created && (
            <p style={{ color: '#15803d' }}>
              已创建客户：{created.customer.name}（ID：{created.customer.id}）——可在项目详情页邀请成员时使用该 ID
            </p>
          )}
        </section>
      )}

      <h3>平台账号</h3>
      {data && (
        <table
          style={{ borderCollapse: 'collapse', width: '100%' }}
          border={1}
          cellPadding={8}
        >
          <thead>
            <tr>
              <th>显示名</th>
              <th>邮箱</th>
              <th>角色</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{userRoleLabel(u.role)}</td>
                <td>{u.isActive ? '正常' : '未激活/已停用'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
