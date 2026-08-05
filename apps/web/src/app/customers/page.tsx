'use client';

import { useEffect, useState } from 'react';
import {
  CustomerUpdateResponseSchema,
  CustomersListResponseSchema,
  type Customer,
  type CustomersListResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { useAuth } from '../../components/auth-provider';
import { isPlatformRole } from '../../lib/roles';

/**
 * 客户列表：内部/超管看全部（可搜索、可编辑）；客户用户经 RLS 只见所属客户（只读，
 * 无编辑入口——demo path：#14 验收 ③）。编辑为空输入 = 清空 industry/region。
 */
export default function CustomersPage() {
  const { user } = useAuth();
  const [data, setData] = useState<CustomersListResponse | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', industry: '', region: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const canEdit = isPlatformRole(user?.role);

  async function load(keyword: string) {
    const query = keyword.trim() ? `?search=${encodeURIComponent(keyword.trim())}` : '';
    try {
      const res = await apiFetch(`/api/customers${query}`, {
        schema: CustomersListResponseSchema,
      });
      setData(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load('');
  }, []);

  // 防抖搜索：停止输入 300ms 后请求
  useEffect(() => {
    const t = setTimeout(() => void load(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  function startEdit(c: Customer) {
    setEditingId(c.id);
    setForm({ name: c.name, industry: c.industry ?? '', region: c.region ?? '' });
    setSaveError('');
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setSaving(true);
    setSaveError('');
    try {
      await apiFetch(`/api/customers/${editingId}`, {
        method: 'PATCH',
        // 空字符串 → null 清空（与「undefined 不动」区分）
        body: {
          name: form.name,
          industry: form.industry.trim() || null,
          region: form.region.trim() || null,
        },
        schema: CustomerUpdateResponseSchema,
      });
      setEditingId(null);
      await load(search);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h2>客户</h2>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      <input
        placeholder="搜索客户（名称 / 行业 / 地区）"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 16, padding: 8 }}
      />

      {data && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {data.customers.map((c) => (
            <li
              key={c.id}
              style={{
                padding: '10px 14px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              {editingId === c.id && canEdit ? (
                <form
                  onSubmit={handleSave}
                  style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
                >
                  <input
                    placeholder="客户名称"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                  <input
                    placeholder="行业"
                    value={form.industry}
                    onChange={(e) => setForm({ ...form, industry: e.target.value })}
                  />
                  <input
                    placeholder="地区"
                    value={form.region}
                    onChange={(e) => setForm({ ...form, region: e.target.value })}
                  />
                  <button type="submit" disabled={saving || !form.name}>
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button type="button" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                  {saveError && <span style={{ color: '#b91c1c' }}>{saveError}</span>}
                </form>
              ) : (
                <div>
                  <strong>{c.name}</strong>
                  <span style={{ color: '#6b7280', marginLeft: 8 }}>
                    {[c.industry, c.region].filter(Boolean).join(' · ') || '—'}
                  </span>
                  {canEdit && (
                    <button type="button" onClick={() => startEdit(c)} style={{ marginLeft: 8 }}>
                      编辑
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
          {data.customers.length === 0 && (
            <li style={{ color: '#6b7280' }}>{search ? '无匹配客户' : '暂无客户'}</li>
          )}
        </ul>
      )}
    </div>
  );
}
