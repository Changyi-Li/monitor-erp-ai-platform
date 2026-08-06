import { describe, expect, it } from 'vitest';
import {
  AttachmentResponseSchema,
  AttachmentSchema,
  AttachmentUploadSchema,
  MeetingMinuteSchema,
  MinuteCreateRequestSchema,
  MinuteGetResponseSchema,
  MinuteResponseSchema,
  MinuteUpdateRequestSchema,
  MinutesListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';
const validDate = '2026-08-06';

const validAttachment = {
  id: validUuid,
  name: '会议纪要附件.pdf',
  contentType: 'application/pdf',
  size: 1024,
  createdAt: validIsoDate,
};

const validMinute = {
  id: validUuid,
  projectId: validUuid,
  title: '项目启动会',
  meetingDate: validDate,
  participants: '张三、李四（客户）',
  body: '<p>决议：下周开始蓝图设计</p>',
  createdBy: { id: validUuid, displayName: '实施顾问' },
  attachments: [validAttachment],
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('minutes 契约：MeetingMinuteSchema', () => {
  it('接受合法纪要（无参会人/正文/创建人时字段为 null，无附件空数组）', () => {
    expect(MeetingMinuteSchema.safeParse(validMinute).success).toBe(true);
    expect(
      MeetingMinuteSchema.safeParse({
        ...validMinute,
        participants: null,
        body: null,
        createdBy: null,
        attachments: [],
      }).success,
    ).toBe(true);
  });

  it('拒绝非法日期格式 / 空主题 / 超长正文 / 非法附件', () => {
    expect(MeetingMinuteSchema.safeParse({ ...validMinute, meetingDate: '2026/08/06' }).success).toBe(
      false,
    );
    expect(MeetingMinuteSchema.safeParse({ ...validMinute, title: '  ' }).success).toBe(false);
    expect(MeetingMinuteSchema.safeParse({ ...validMinute, body: 'a'.repeat(20001) }).success).toBe(
      false,
    );
    expect(
      MeetingMinuteSchema.safeParse({ ...validMinute, attachments: [{ ...validAttachment, size: -1 }] })
        .success,
    ).toBe(false);
  });
});

describe('minutes 契约：AttachmentSchema', () => {
  it('接受合法附件；拒绝空文件名/负大小', () => {
    expect(AttachmentSchema.safeParse(validAttachment).success).toBe(true);
    expect(AttachmentSchema.safeParse({ ...validAttachment, name: '  ' }).success).toBe(false);
    expect(AttachmentSchema.safeParse({ ...validAttachment, size: -5 }).success).toBe(false);
  });
});

describe('minutes 契约：请求', () => {
  it('创建纪要：title/meetingDate 必填；participants/body 可选', () => {
    expect(MinuteCreateRequestSchema.safeParse({ title: '周会', meetingDate: validDate }).success).toBe(
      true,
    );
    expect(
      MinuteCreateRequestSchema.safeParse({
        title: '周会',
        meetingDate: validDate,
        participants: '团队',
        body: '<p>x</p>',
      }).success,
    ).toBe(true);
    expect(MinuteCreateRequestSchema.safeParse({ meetingDate: validDate }).success).toBe(false);
    expect(MinuteCreateRequestSchema.safeParse({ title: '周会' }).success).toBe(false);
    expect(MinuteCreateRequestSchema.safeParse({ title: '  ', meetingDate: validDate }).success).toBe(
      false,
    );
    expect(MinuteCreateRequestSchema.safeParse({ title: '周会', meetingDate: '08/06/2026' }).success).toBe(
      false,
    );
  });

  it('更新纪要：全 optional；participants/body 可 null 清空', () => {
    expect(MinuteUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(MinuteUpdateRequestSchema.safeParse({ participants: null, body: null }).success).toBe(true);
    expect(
      MinuteUpdateRequestSchema.safeParse({ title: '新主题', meetingDate: validDate }).success,
    ).toBe(true);
    expect(MinuteUpdateRequestSchema.safeParse({ title: '  ' }).success).toBe(false);
  });

  it('附件上传：name/contentType/base64 必填；base64 超上限拒绝', () => {
    expect(
      AttachmentUploadSchema.safeParse({
        name: 'a.pdf',
        contentType: 'application/pdf',
        base64: 'aGVsbG8=',
      }).success,
    ).toBe(true);
    expect(AttachmentUploadSchema.safeParse({ name: 'a.pdf', base64: 'aGVsbG8=' }).success).toBe(false);
    expect(
      AttachmentUploadSchema.safeParse({
        name: 'a.pdf',
        contentType: 'application/pdf',
        base64: '',
      }).success,
    ).toBe(false);
    expect(
      AttachmentUploadSchema.safeParse({
        name: 'a.pdf',
        contentType: 'application/pdf',
        base64: 'a'.repeat(8_000_001),
      }).success,
    ).toBe(false);
  });
});

describe('minutes 契约：响应', () => {
  it('列表为 { minutes, viewerRole }；详情为 { minute, viewerRole }；单条为 { minute } / { attachment }', () => {
    expect(MinutesListResponseSchema.safeParse({ minutes: [validMinute], viewerRole: 'internal' }).success).toBe(
      true,
    );
    expect(MinutesListResponseSchema.safeParse({ minutes: [validMinute], viewerRole: 'other' }).success).toBe(
      false,
    );
    expect(MinuteGetResponseSchema.safeParse({ minute: validMinute, viewerRole: 'project_manager' }).success).toBe(
      true,
    );
    expect(MinuteResponseSchema.safeParse({ minute: validMinute }).success).toBe(true);
    expect(AttachmentResponseSchema.safeParse({ attachment: validAttachment }).success).toBe(true);
  });
});
