import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AttachmentResponseSchema,
  MemberInviteResponseSchema,
  MinuteGetResponseSchema,
  MinuteResponseSchema,
  MinutesListResponseSchema,
  SetPasswordResponseSchema,
  type MeetingMinute,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 会议纪要 e2e（issue #18 验收）：
 * - ① 创建纪要（结构化字段 + 富文本正文）→ 编辑 → 删除
 * - ② 附件上传 → 下载/预览 → 删除（对象存储经 StoragePort，字节一致）
 * - ③ 客户用户只读查看 + 附件下载（创建/编辑/删除/附件管理 403）；非成员 403；跨租户 404
 * - 审计：minute.create/update/delete、attachment.upload/delete 落 audit_logs
 */
describe('Minutes e2e：会议纪要', () => {
  let app: NestFastifyApplication;

  const password = 'password123';

  let internalToken: string;
  let pmToken: string;
  let keyUserToken: string;
  let regularUserToken: string;
  let outsiderToken: string; // 同租户非项目成员
  let crossTenantToken: string; // 另一客户（跨租户 → 404 防探测）
  let projectAId: string;
  let minuteId: string;
  let secondMinuteId: string;
  let attachmentId: string;

  async function register(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: { id: string } };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    return { id: user.id, token: (login.json() as { accessToken: string }).accessToken };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  async function inviteMember(
    projectId: string,
    body: { email: string; role: string },
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const parsed = MemberInviteResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const inviteUrl = parsed.data!.inviteUrl!;
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const setPw = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect(setPw.statusCode).toBe(200);
    expect(SetPasswordResponseSchema.safeParse(setPw.json()).success).toBe(true);
    return login(body.email);
  }

  async function createMinute(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; minute: MeetingMinute | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, minute: null };
    }
    const parsed = MinuteResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, minute: parsed.data!.minute };
  }

  async function listMinutes(token: string): Promise<{ status: number; minutes: MeetingMinute[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, minutes: [] };
    }
    const parsed = MinutesListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, minutes: parsed.data!.minutes };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    // 用户：internal 默认；outsider/crossTenant 为两个不同客户的客户用户
    const internal = await register('internal@corp.test');
    const outsider = await register('outsider@tenant-a.test');
    const crossTenant = await register('cross@tenant-b.test');
    internalToken = internal.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer_user' where id = ${outsider.id}`;
      await owner`update users set role = 'customer_user' where id = ${crossTenant.id}`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${outsider.id}, ${customerA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${crossTenant.id}, ${customerB.id})`;
      const cidA = customerA.id as string;
      // 项目 A 归客户 A
      const [projectA] = await owner`insert into projects (tenant_id, name) values (${cidA}, 'P-A1') returning id`;
      projectAId = projectA.id as string;
    } finally {
      await owner.end();
    }
    outsiderToken = await login('outsider@tenant-a.test');
    crossTenantToken = await login('cross@tenant-b.test');

    // 邀请三客户角色（真实成员链路）：PM 先按 key user 邀请，再升级为 customer_pm
    pmToken = await inviteMember(projectAId, {
      email: 'pm@tenant-a.test',
      role: 'customer_key_user',
    });
    const ownerUp = connectOwner();
    try {
      await ownerUp`update users set role = 'customer_pm' where email = 'pm@tenant-a.test'`;
    } finally {
      await ownerUp.end();
    }
    pmToken = await login('pm@tenant-a.test'); // 角色在登录时签发进 JWT，升级后须重新登录
    keyUserToken = await inviteMember(projectAId, {
      email: 'ku@tenant-a.test',
      role: 'customer_key_user',
    });
    regularUserToken = await inviteMember(projectAId, {
      email: 'ru@tenant-a.test',
      role: 'customer_user',
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('验收①-1：创建纪要（结构化字段 + 富文本正文）→ 列表倒序', async () => {
    // 创建：主题/日期/参会人/富文本正文
    const first = await createMinute(internalToken, {
      title: '项目启动会',
      meetingDate: '2026-08-01',
      participants: '张实施、李客户（PM）',
      body: '<p><strong>决议：</strong>下周进入蓝图设计</p>',
    });
    expect(first.status).toBe(201);
    const minute = first.minute!;
    expect(minute.title).toBe('项目启动会');
    expect(minute.meetingDate).toBe('2026-08-01');
    expect(minute.participants).toBe('张实施、李客户（PM）');
    expect(minute.body).toContain('决议');
    expect(minute.attachments).toEqual([]);
    expect(minute.createdBy?.displayName).toBeTruthy();
    minuteId = minute.id;

    // 第二条（日期更晚）→ 列表按会议日期倒序
    const second = await createMinute(internalToken, {
      title: '蓝图评审会',
      meetingDate: '2026-08-06',
      body: '<p>评审通过</p>',
    });
    expect(second.status).toBe(201);
    secondMinuteId = second.minute!.id;
    expect(second.minute!.participants).toBeNull(); // 未传为 null

    const list = await listMinutes(internalToken);
    expect(list.status).toBe(200);
    expect(list.minutes.map((m) => m.id)).toEqual([secondMinuteId, minuteId]);

    // 校验失败：主题缺失 / 日期格式错
    const noTitle = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { meetingDate: '2026-08-06' },
    });
    expect(noTitle.statusCode).toBe(400);
    const badDate = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { title: '周会', meetingDate: '2026/08/06' },
    });
    expect(badDate.statusCode).toBe(400);
  });

  it('验收①-2：编辑（标题/参会人 null 清空）+ 详情 + 删除', async () => {
    // 编辑：改主题 + 清空参会人
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/minutes/${minuteId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { title: '项目启动会（修订）', participants: null },
    });
    expect(patch.statusCode).toBe(200);
    const updated = MinuteResponseSchema.safeParse(patch.json()).data!.minute;
    expect(updated.title).toBe('项目启动会（修订）');
    expect(updated.participants).toBeNull();
    expect(updated.body).toContain('决议'); // 未传字段保留

    // 详情（客户 PM 可读）
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${minuteId}`,
      headers: { authorization: `Bearer ${pmToken}` },
    });
    expect(get.statusCode).toBe(200);
    const detail = MinuteGetResponseSchema.safeParse(get.json());
    expect(detail.success).toBe(true);
    expect(detail.data!.minute.title).toBe('项目启动会（修订）');
    expect(detail.data!.viewerRole).toBe('customer_pm');

    // 不存在 → 404
    const missing = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(missing.statusCode).toBe(404);

    // 删除第二条 → 204；再访问 404
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/minutes/${secondMinuteId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${secondMinuteId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(after.statusCode).toBe(404);
  });

  it('验收②：附件上传 → 下载（字节一致 + 文件名编码）→ 删除 → 再下载 404', async () => {
    // 上传（JSON + base64；中文文件名）
    const content = Buffer.from('会议纪要附件内容-测试', 'utf8');
    const upload = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        name: '会议材料.pdf',
        contentType: 'application/pdf',
        base64: content.toString('base64'),
      },
    });
    expect(upload.statusCode).toBe(201);
    const attachment = AttachmentResponseSchema.safeParse(upload.json());
    expect(attachment.success).toBe(true);
    expect(attachment.data!.attachment.name).toBe('会议材料.pdf');
    expect(attachment.data!.attachment.size).toBe(content.byteLength); // 实测字节数
    attachmentId = attachment.data!.attachment.id;

    // 详情内联附件
    const detail = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${minuteId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const parsed = MinuteGetResponseSchema.safeParse(detail.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data!.minute.attachments.map((a) => a.id)).toContain(attachmentId);

    // 下载：字节一致 + Content-Type + RFC 5987 中文文件名
    const download = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments/${attachmentId}/file`,
      headers: { authorization: `Bearer ${pmToken}` }, // 客户用户可下载
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['content-disposition']).toContain('inline');
    expect(download.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('会议材料.pdf')}`);
    expect(download.rawPayload.toString('utf8')).toBe('会议纪要附件内容-测试');

    // 跨纪要删除 → 404（附件属于别的纪要）
    const wrongDelete = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/minutes/00000000-0000-0000-0000-000000000000/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(wrongDelete.statusCode).toBe(404);

    // 删除附件 → 204；再下载 404
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments/${attachmentId}/file`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it('验收③：客户用户只读——查看/下载 200，创建/编辑/删除/附件管理 403', async () => {
    for (const token of [pmToken, keyUserToken, regularUserToken]) {
      const list = await listMinutes(token);
      expect(list.status).toBe(200);
      expect(list.minutes.length).toBeGreaterThan(0);

      const create = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/minutes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '越权纪要', meetingDate: '2026-08-06' },
      });
      expect(create.statusCode).toBe(403);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/minutes/${minuteId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '越权修改' },
      });
      expect(patch.statusCode).toBe(403);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}/minutes/${minuteId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(403);
      const upload = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'x.pdf', contentType: 'application/pdf', base64: 'aGk=' },
      });
      expect(upload.statusCode).toBe(403);
      const delAttachment = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}/minutes/${minuteId}/attachments/${attachmentId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delAttachment.statusCode).toBe(403);
    }
  });

  it('成员边界：同租户非成员 403；跨租户 404（防探测）', async () => {
    expect((await listMinutes(outsiderToken)).status).toBe(403);
    const crossList = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(crossList.statusCode).toBe(404);
    const crossGet = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/minutes/${minuteId}`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(crossGet.statusCode).toBe(404);
  });

  it('审计：minute.create/update/delete、attachment.upload/delete 落 audit_logs', async () => {
    const owner = connectOwner();
    try {
      const creates = await owner`select metadata from audit_logs where action = 'minute.create'`;
      expect(creates.length).toBeGreaterThanOrEqual(2); // 两条纪要
      const updates = await owner`select metadata from audit_logs where action = 'minute.update'`;
      expect(updates.length).toBeGreaterThanOrEqual(1);
      const deletes = await owner`select metadata from audit_logs where action = 'minute.delete'`;
      expect(deletes.length).toBeGreaterThanOrEqual(1);
      const uploads = await owner`select metadata from audit_logs where action = 'attachment.upload'`;
      expect(uploads.length).toBeGreaterThanOrEqual(1);
      const uploadMeta = JSON.parse(uploads[0].metadata as string) as { name: string; size: number };
      expect(uploadMeta.name).toBe('会议材料.pdf');
      expect(uploadMeta.size).toBeGreaterThan(0);
      const attachmentDeletes = await owner`select metadata from audit_logs where action = 'attachment.delete'`;
      expect(attachmentDeletes.length).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }
  });
});
