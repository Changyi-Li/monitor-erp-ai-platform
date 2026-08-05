import { describe, expect, it } from 'vitest';
import {
  MemberInviteRequestSchema,
  MemberInviteResponseSchema,
  MemberSchema,
  MemberUpdateRequestSchema,
  MembersListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validMember = {
  id: validUuid,
  projectId: validUuid,
  userId: validUuid,
  role: 'key_user',
  isActive: true,
  email: 'alice@example.com',
  displayName: 'Alice',
  createdAt: validIsoDate,
};

describe('members 契约：MemberSchema', () => {
  it('接受合法成员对象', () => {
    expect(MemberSchema.safeParse(validMember).success).toBe(true);
  });

  it('只接受三个项目角色', () => {
    for (const role of ['project_manager', 'key_user', 'regular_user'] as const) {
      expect(MemberSchema.safeParse({ ...validMember, role }).success).toBe(true);
    }
    expect(MemberSchema.safeParse({ ...validMember, role: 'internal' }).success).toBe(false);
    expect(MemberSchema.safeParse({ ...validMember, role: 'admin' }).success).toBe(false);
  });

  it('拒绝非法邮箱', () => {
    expect(MemberSchema.safeParse({ ...validMember, email: 'nope' }).success).toBe(false);
  });
});

describe('members 契约：邀请', () => {
  it('接受合法邀请请求', () => {
    expect(
      MemberInviteRequestSchema.safeParse({ email: 'bob@example.com', role: 'regular_user' }).success,
    ).toBe(true);
    expect(
      MemberInviteRequestSchema.safeParse({ email: 'bob@example.com', role: 'project_manager' }).success,
    ).toBe(true);
  });

  it('拒绝非法邮箱 / 非法角色 / 空 displayName', () => {
    expect(MemberInviteRequestSchema.safeParse({ email: 'x', role: 'regular_user' }).success).toBe(false);
    expect(MemberInviteRequestSchema.safeParse({ email: 'bob@example.com', role: 'admin' }).success).toBe(false);
    expect(
      MemberInviteRequestSchema.safeParse({ email: 'bob@example.com', role: 'key_user', displayName: '  ' }).success,
    ).toBe(false);
  });

  it('邀请响应 inviteUrl 可为 null（同租户已有账号直接加入）', () => {
    expect(
      MemberInviteResponseSchema.safeParse({ member: validMember, inviteUrl: 'https://localhost:3000/invite?token=x' }).success,
    ).toBe(true);
    expect(
      MemberInviteResponseSchema.safeParse({ member: validMember, inviteUrl: null }).success,
    ).toBe(true);
    expect(MemberInviteResponseSchema.safeParse({ member: validMember }).success).toBe(false);
  });
});

describe('members 契约：停用/启用与列表', () => {
  it('更新请求只有 isActive', () => {
    expect(MemberUpdateRequestSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(MemberUpdateRequestSchema.safeParse({ isActive: true }).success).toBe(true);
    expect(MemberUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(MemberUpdateRequestSchema.safeParse({ isActive: 'yes' }).success).toBe(false);
  });

  it('列表响应为 { members: Member[] }', () => {
    expect(MembersListResponseSchema.safeParse({ members: [validMember] }).success).toBe(true);
  });
});
