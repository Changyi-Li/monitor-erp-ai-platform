import { describe, expect, it } from 'vitest';
import { can, PERMISSION_MATRIX, PERMISSIONS } from '@monitor/shared';

/**
 * 权限矩阵 sanity（spec §2.4）：shared 常量与矩阵的守护测试。
 * 矩阵是唯一事实源；后续功能模块落端点时直接复用 can()。
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

  it('spec §2.4 客户侧差异：评论（PM/KeyUser，普通用户不可）', () => {
    expect(can('regular_user', 'issue:comment')).toBe(false);
    expect(can('key_user', 'issue:comment')).toBe(true);
    expect(can('project_manager', 'issue:comment')).toBe(true);
    expect(can('internal', 'issue:comment')).toBe(true);
  });

  it('spec §2.4：问题管理（仅 PM+），Key User 不可', () => {
    expect(can('key_user', 'issue:manage')).toBe(false);
    expect(can('regular_user', 'issue:manage')).toBe(false);
    expect(can('project_manager', 'issue:manage')).toBe(true);
  });

  it('spec §2.4：提交问题全员可', () => {
    for (const role of ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user']) {
      expect(can(role as never, 'issue:create')).toBe(true);
    }
  });

  it('#16：蓝图查看全员（§2.4 line 77），维护=仅内部（§2.4 line 81 蓝图维护）', () => {
    for (const role of ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user']) {
      expect(can(role as never, 'blueprint:view')).toBe(true);
    }
    expect(can('super_admin', 'blueprint:manage')).toBe(true);
    expect(can('internal', 'blueprint:manage')).toBe(true);
    expect(can('project_manager', 'blueprint:manage')).toBe(false);
    expect(can('key_user', 'blueprint:manage')).toBe(false);
    expect(can('regular_user', 'blueprint:manage')).toBe(false);
  });

  it('#17：阶段查看全员（§2.4 line 77），阶段/风险管理=仅内部（§2.4 line 81）', () => {
    for (const role of ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user']) {
      expect(can(role as never, 'phase:view')).toBe(true);
    }
    for (const permission of ['phase:manage', 'risk:manage'] as const) {
      expect(can('super_admin', permission)).toBe(true);
      expect(can('internal', permission)).toBe(true);
      expect(can('project_manager', permission)).toBe(false);
      expect(can('key_user', permission)).toBe(false);
      expect(can('regular_user', permission)).toBe(false);
    }
  });

  it('#15：状态流转=内部专属（spec 37 内部处理问题；客户侧无流转）', () => {
    expect(can('super_admin', 'issue:transition')).toBe(true);
    expect(can('internal', 'issue:transition')).toBe(true);
    expect(can('project_manager', 'issue:transition')).toBe(false);
    expect(can('key_user', 'issue:transition')).toBe(false);
    expect(can('regular_user', 'issue:transition')).toBe(false);
  });

  it('本期强制项：建项目=内部+；建客户=仅超管；编辑客户=内部+；成员管理=PM+', () => {
    expect(can('internal', 'project:create')).toBe(true);
    expect(can('project_manager', 'project:create')).toBe(false);
    expect(can('super_admin', 'customer:create')).toBe(true);
    expect(can('internal', 'customer:create')).toBe(false);
    // #14：编辑客户资料 = 内部+（客户侧无任何客户写权限）
    expect(can('super_admin', 'customer:update')).toBe(true);
    expect(can('internal', 'customer:update')).toBe(true);
    expect(can('project_manager', 'customer:update')).toBe(false);
    expect(can('regular_user', 'customer:update')).toBe(false);
    expect(can('project_manager', 'member:manage')).toBe(true);
    expect(can('key_user', 'member:manage')).toBe(false);
  });

  it('null/undefined 角色无权限（fail closed）', () => {
    expect(can(null, 'project:read')).toBe(false);
    expect(can(undefined, 'issue:create')).toBe(false);
  });
});
