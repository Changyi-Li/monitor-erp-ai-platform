'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  MemberCancelInviteResponseSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectGetResponseSchema,
  type MemberInviteResponse,
  type MembersListResponse,
  type PendingInvite,
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

  /** 刷新成员两栏列表（邀请/重发/取消/停用后共用） */
  async function refreshMembers() {
    const fresh = await apiFetch(`/api/projects/${id}/members`, {
      schema: MembersListResponseSchema,
    });
    setMembers(fresh);
  }

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
      await refreshMembers();
    } catch (err) {
      setInviteError(errorMessage(err));
    } finally {
      setInviting(false);
    }
  }

  /** 重发邀请（issue #43）：生成新链接（旧链接立即失效），展示供复制分发 */
  async function handleResend(p: PendingInvite) {
    setInviteError('');
    setInviteResult(null);
    try {
      const res = await apiFetch(`/api/projects/${id}/members`, {
        method: 'POST',
        body: { email: p.email, role: p.role },
        schema: MemberInviteResponseSchema,
      });
      setInviteResult(res);
      await refreshMembers();
    } catch (err) {
      setInviteError(errorMessage(err));
    }
  }

  /** 取消邀请（issue #43）：删除待激活账号，旧链接立即失效 */
  async function handleCancelInvite(p: PendingInvite) {
    if (!window.confirm(`取消对 ${p.email} 的邀请？该账号将被删除，旧链接立即失效。`)) {
      return;
    }
    setInviteError('');
    try {
      await apiFetch(`/api/projects/${id}/members/${p.userId}`, {
        method: 'DELETE',
        schema: MemberCancelInviteResponseSchema,
      });
      await refreshMembers();
    } catch (err) {
      setInviteError(errorMessage(err));
    }
  }

  async function handleToggle(memberUserId: string, isActive: boolean) {
    try {
      await apiFetch(`/api/projects/${id}/members/${memberUserId}`, {
        method: 'PATCH',
        body: { isActive: !isActive },
        schema: MemberCancelInviteResponseSchema,
      });
      await refreshMembers();
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
      <p style={{ marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link href={`/projects/${id}/blueprints`} style={{ color: '#2563eb' }}>
          蓝图 →
        </Link>
        <Link href={`/projects/${id}/stages`} style={{ color: '#2563eb' }}>
          阶段看板 →
        </Link>
        <Link href={`/projects/${id}/risks`} style={{ color: '#2563eb' }}>
          风险 →
        </Link>
        <Link href={`/projects/${id}/issues`} style={{ color: '#2563eb' }}>
          问题清单 →
        </Link>
        <Link href={`/projects/${id}/minutes`} style={{ color: '#2563eb' }}>
          会议纪要 →
        </Link>
        <Link href={`/projects/${id}/manuals`} style={{ color: '#2563eb' }}>
          操作手册 →
        </Link>
        <Link href="/kb" style={{ color: '#2563eb' }}>
          知识库 →
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

          <h3>待激活邀请</h3>
          {members && members.pendingInvites.length > 0 ? (
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
                  <th>邀请过期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {members.pendingInvites.map((p) => {
                  // 客户 PM 不能操作 project_manager 角色的邀请（后端 403 兜底）
                  const locked = viewerRole === 'project_manager' && p.role === 'project_manager';
                  const expired = Date.parse(p.expiresAt) < Date.now();
                  return (
                    <tr key={p.userId}>
                      <td>{p.displayName}</td>
                      <td>{p.email}</td>
                      <td>{PROJECT_ROLE_LABELS[p.role]}</td>
                      <td style={expired ? { color: '#b91c1c' } : undefined}>
                        {new Date(p.expiresAt).toLocaleString()}
                        {expired ? '（已过期）' : ''}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={locked}
                          title={locked ? '项目经理角色的邀请只能由内部用户操作' : undefined}
                          onClick={() => handleResend(p)}
                        >
                          重发
                        </button>{' '}
                        <button
                          type="button"
                          disabled={locked}
                          title={locked ? '项目经理角色的邀请只能由内部用户操作' : undefined}
                          onClick={() => handleCancelInvite(p)}
                        >
                          取消
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p style={{ color: '#6b7280' }}>暂无待激活邀请</p>
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
