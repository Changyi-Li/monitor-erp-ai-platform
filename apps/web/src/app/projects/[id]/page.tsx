'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectGetResponseSchema,
  type MemberInviteResponse,
  type MembersListResponse,
  type ProjectGetResponse,
} from '@monitor/contracts';
import { PROJECT_ROLE_LABELS } from '../../../lib/roles';
import { apiFetch, errorMessage } from '../../../lib/api';

const MANAGER_ROLES = ['key_user', 'regular_user'] as const;

/**
 * 项目详情（含成员管理）：
 * - viewerRole 决定管理入口显隐（内部/PM 可见邀请与停用）
 * - 客户用户跨项目访问 → 后端 403（本页展示错误）；跨租户 → 404
 * - PM 邀请表单角色只给 key_user/regular_user（不可升级角色由后端强制）
 */
export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ProjectGetResponse | null>(null);
  const [members, setMembers] = useState<MembersListResponse | null>(null);
  const [error, setError] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteResult, setInviteResult] = useState<MemberInviteResponse | null>(null);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', displayName: '', role: 'regular_user' });

  const viewerRole = detail?.viewerRole ?? null;
  const canManage = viewerRole === 'internal' || viewerRole === 'project_manager';

  useEffect(() => {
    if (!id) {
      return;
    }
    apiFetch(`/api/projects/${id}`, { schema: ProjectGetResponseSchema })
      .then((d) => {
        setDetail(d);
        if (d.viewerRole === 'internal' || d.viewerRole === 'project_manager') {
          return apiFetch(`/api/projects/${id}/members`, {
            schema: MembersListResponseSchema,
          }).then(setMembers);
        }
        return undefined;
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [id]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError('');
    setInviteResult(null);
    setInviting(true);
    try {
      const res = await apiFetch(`/api/projects/${id}/members`, {
        method: 'POST',
        body: { email: form.email, displayName: form.displayName || undefined, role: form.role },
        schema: MemberInviteResponseSchema,
      });
      setInviteResult(res);
      setForm({ email: '', displayName: '', role: 'regular_user' });
      const fresh = await apiFetch(`/api/projects/${id}/members`, {
        schema: MembersListResponseSchema,
      });
      setMembers(fresh);
    } catch (err) {
      setInviteError(errorMessage(err));
    } finally {
      setInviting(false);
    }
  }

  async function handleToggle(memberUserId: string, isActive: boolean) {
    try {
      await apiFetch(`/api/projects/${id}/members/${memberUserId}`, {
        method: 'PATCH',
        body: { isActive: !isActive },
        schema: MemberInviteResponseSchema.optional(),
      });
      const fresh = await apiFetch(`/api/projects/${id}/members`, {
        schema: MembersListResponseSchema,
      });
      setMembers(fresh);
    } catch (err) {
      setInviteError(errorMessage(err));
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href="/projects">← 返回项目列表</Link>
      </div>
    );
  }
  if (!detail) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href="/projects">← 返回项目列表</Link>
      </p>
      <h2>{detail.project.name}</h2>
      {detail.project.description && (
        <p style={{ color: '#6b7280' }}>{detail.project.description}</p>
      )}
      <p style={{ marginTop: 8, display: 'flex', gap: 16 }}>
        <Link href={`/projects/${id}/blueprints`} style={{ color: '#2563eb' }}>
          蓝图 →
        </Link>
        <Link href={`/projects/${id}/issues`} style={{ color: '#2563eb' }}>
          问题清单 →
        </Link>
      </p>

      {canManage && (
        <section style={{ marginTop: 24 }}>
          <h3>邀请成员</h3>
          <form
            onSubmit={handleInvite}
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
              placeholder="邮箱"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <input
              placeholder="显示名（可选）"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {MANAGER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {PROJECT_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={inviting || !form.email}>
              {inviting ? '邀请中…' : '发送邀请'}
            </button>
          </form>
          {inviteError && <p style={{ color: '#b91c1c' }}>{inviteError}</p>}
          {inviteResult?.inviteUrl && (
            <p
              style={{
                padding: 10,
                background: '#f0fdf4',
                border: '1px solid #86efac',
                borderRadius: 8,
                wordBreak: 'break-all',
              }}
            >
              邀请链接（复制发给对方）：<code>{inviteResult.inviteUrl}</code>
            </p>
          )}
          {inviteResult && !inviteResult.inviteUrl && (
            <p style={{ color: '#6b7280' }}>该用户已是活跃账号，已直接加入项目。</p>
          )}

          <h3>成员</h3>
          {members && (
            <table
              style={{ borderCollapse: 'collapse', width: '100%' }}
              border={1}
              cellPadding={8}
            >
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {members.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.displayName}</td>
                    <td>{m.email}</td>
                    <td>{PROJECT_ROLE_LABELS[m.role]}</td>
                    <td>{m.isActive ? '正常' : '已停用'}</td>
                    <td>
                      {m.role !== 'project_manager' && (
                        <button
                          type="button"
                          onClick={() => handleToggle(m.userId, m.isActive)}
                        >
                          {m.isActive ? '停用' : '启用'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
