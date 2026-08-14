import { describe, expect, it } from 'vitest';
import { can, PERMISSION_MATRIX, PERMISSIONS, type UserRole } from '@monitor/shared';

const ALL_ROLES: UserRole[] = ['super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user'];
const CUSTOMER_ROLES: UserRole[] = ['customer_pm', 'customer_key_user', 'customer_user'];

/**
 * 权限矩阵 sanity（spec §2.4 + T1 平台角色拆分）：shared 常量与矩阵的守护测试。
 * 矩阵是唯一事实源；后续功能模块落端点时直接复用 can()。
 * T2：权限判定完全基于平台角色（project_members.role 已退役）。
 */
describe('权限矩阵', () => {
  it('每项权限至少映射一个角色', () => {
    for (const permission of PERMISSIONS) {
      expect(
        PERMISSION_MATRIX[permission].length,
        `${permission} 未映射任何角色`,
      ).toBeGreaterThan(0);
    }
  });

  it('super_admin ⊇ internal：internal 出现的行 super_admin 必在（超管=内部全权限）', () => {
    for (const permission of PERMISSIONS) {
      if (PERMISSION_MATRIX[permission].includes('internal')) {
        expect(
          PERMISSION_MATRIX[permission],
          `${permission} 缺 super_admin`,
        ).toContain('super_admin');
      }
    }
  });

  it('客户侧差异：评论（PM/KeyUser 可，普通用户不可）', () => {
    expect(can('customer_user', 'issue:comment')).toBe(false);
    expect(can('customer_key_user', 'issue:comment')).toBe(true);
    expect(can('customer_pm', 'issue:comment')).toBe(true);
    expect(can('internal', 'issue:comment')).toBe(true);
  });

  it('问题管理（仅 PM+），Key User 不可', () => {
    expect(can('customer_key_user', 'issue:manage')).toBe(false);
    expect(can('customer_user', 'issue:manage')).toBe(false);
    expect(can('customer_pm', 'issue:manage')).toBe(true);
  });

  it('提交问题全员可', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'issue:create')).toBe(true);
    }
  });

  it('#16：蓝图查看全员，维护=仅内部', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'blueprint:view')).toBe(true);
    }
    expect(can('super_admin', 'blueprint:manage')).toBe(true);
    expect(can('internal', 'blueprint:manage')).toBe(true);
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'blueprint:manage')).toBe(false);
    }
  });

  it('#17：阶段查看全员，阶段/风险管理=仅内部', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'phase:view')).toBe(true);
    }
    for (const permission of ['phase:manage', 'risk:manage'] as const) {
      expect(can('super_admin', permission)).toBe(true);
      expect(can('internal', permission)).toBe(true);
      for (const role of CUSTOMER_ROLES) {
        expect(can(role, permission)).toBe(false);
      }
    }
  });

  it('#18：会议纪要查看全员，维护=仅内部', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'meeting:view')).toBe(true);
    }
    expect(can('super_admin', 'meeting:manage')).toBe(true);
    expect(can('internal', 'meeting:manage')).toBe(true);
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'meeting:manage')).toBe(false);
    }
  });

  it('#19：知识库文档编辑=仅内部；查看默认开放无 kb:view', () => {
    for (const role of ['super_admin', 'internal'] as UserRole[]) {
      expect(can(role, 'kb:edit')).toBe(true);
    }
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'kb:edit')).toBe(false);
    }
  });

  it('#21：RAG 同步状态/调试台=仅内部', () => {
    for (const role of ['super_admin', 'internal'] as UserRole[]) {
      expect(can(role, 'rag:view')).toBe(true);
    }
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'rag:view')).toBe(false);
    }
  });

  it('#15：状态流转=内部专属（客户侧无流转）', () => {
    expect(can('super_admin', 'issue:transition')).toBe(true);
    expect(can('internal', 'issue:transition')).toBe(true);
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'issue:transition')).toBe(false);
    }
  });

  it('本期强制项：建项目=内部+；建客户=仅超管；编辑客户=内部+；成员管理=PM+', () => {
    expect(can('internal', 'project:create')).toBe(true);
    expect(can('customer_pm', 'project:create')).toBe(false);
    expect(can('super_admin', 'customer:create')).toBe(true);
    expect(can('internal', 'customer:create')).toBe(false);
    // #14：编辑客户资料 = 内部+（客户侧无任何客户写权限）
    expect(can('super_admin', 'customer:update')).toBe(true);
    expect(can('internal', 'customer:update')).toBe(true);
    for (const role of CUSTOMER_ROLES) {
      expect(can(role, 'customer:update')).toBe(false);
    }
    // T2：成员管理权 = 平台角色 customer_pm（内部+；Key User/普通用户无）
    expect(can('customer_pm', 'member:manage')).toBe(true);
    expect(can('customer_key_user', 'member:manage')).toBe(false);
    expect(can('customer_user', 'member:manage')).toBe(false);
  });

  it('null/undefined 角色无权限（fail closed）', () => {
    expect(can(null, 'project:read')).toBe(false);
    expect(can(undefined, 'issue:create')).toBe(false);
  });
});
