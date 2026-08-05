'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CustomersListResponseSchema,
  ProjectsListResponseSchema,
  type CustomersListResponse,
  type ProjectsListResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { useAuth } from '../../components/auth-provider';
import { isPlatformRole } from '../../lib/roles';

/**
 * 项目列表：所有登录用户可见（数据边界=项目，客户只见自己成员的项目；
 * 跨项目/跨租户由后端 403/404 拦截）。建项目入口仅内部/超管。
 */
export default function ProjectsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<ProjectsListResponse | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState({ tenantId: '', name: '' });
  const [customers, setCustomers] = useState<CustomersListResponse | null>(null);

  useEffect(() => {
    apiFetch('/api/projects', { schema: ProjectsListResponseSchema })
      .then(setData)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  // 建项目表单的客户下拉（内部/超管专属表单才需要；GET /api/customers 对内部返回全部）
  useEffect(() => {
    if (user && isPlatformRole(user.role)) {
      apiFetch('/api/customers', { schema: CustomersListResponseSchema })
        .then(setCustomers)
        .catch(() => undefined);
    }
  }, [user]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      await apiFetch('/api/projects', {
        method: 'POST',
        body: { tenantId: form.tenantId, name: form.name },
        schema: ProjectsListResponseSchema.optional(),
      });
      setForm({ tenantId: '', name: '' });
      const fresh = await apiFetch('/api/projects', { schema: ProjectsListResponseSchema });
      setData(fresh);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h2>项目</h2>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {user && (user.role === 'super_admin' || user.role === 'internal') && (
        <form
          onSubmit={handleCreate}
          style={{
            display: 'flex',
            gap: 8,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <select
            value={form.tenantId}
            onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
            style={{ flex: 1, minWidth: 220 }}
          >
            <option value="">选择归属客户…</option>
            {customers?.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.industry ? `（${c.industry}）` : ''}
              </option>
            ))}
          </select>
          <input
            placeholder="项目名称"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <button type="submit" disabled={creating || !form.tenantId || !form.name}>
            {creating ? '创建中…' : '创建项目'}
          </button>
        </form>
      )}
      {createError && <p style={{ color: '#b91c1c' }}>{createError}</p>}

      {data && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {data.projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} style={{ textDecoration: 'none' }}>
                <div
                  style={{
                    padding: '10px 14px',
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                  }}
                >
                  <strong>{p.name}</strong>
                  {p.description && (
                    <span style={{ color: '#6b7280', marginLeft: 8 }}>{p.description}</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
          {data.projects.length === 0 && <li style={{ color: '#6b7280' }}>暂无可见项目</li>}
        </ul>
      )}
    </div>
  );
}
