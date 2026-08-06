import { z } from 'zod';
import { ProjectViewerRoleSchema } from '../projects/schemas';

/**
 * 会议纪要（spec §3.4，issue #18）：项目内会议记录。
 * 结构化字段（主题/日期/参会人）+ 富文本正文（HTML）+ 附件（对象存储，
 * DB 只存 key + 元信息，同蓝图 drawio 模式）。内部（实施）维护；客户用户只读
 * （spec §2.4：查看全员 = meeting:view；维护仅内部 = meeting:manage）。
 */

/** 附件元数据（文件本体在对象存储，经 StoragePort 存取） */
export const AttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(128),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.output<typeof AttachmentSchema>;

/** 会议纪要（详情/列表统一形状；attachments 内联） */
export const MeetingMinuteSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(128),
  meetingDate: z.iso.date(), // 'YYYY-MM-DD'（DB date 列）
  participants: z.string().trim().max(2000).nullable(), // 参会人（纯文本名单）
  body: z.string().max(20000).nullable(), // 富文本正文（HTML）
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(), // 创建人（join users）
  attachments: z.array(AttachmentSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MeetingMinute = z.output<typeof MeetingMinuteSchema>;

/** 创建纪要（结构化字段必填；正文/参会人可选） */
export const MinuteCreateRequestSchema = z.object({
  title: z.string().trim().min(1, { error: '主题不能为空' }).max(128),
  meetingDate: z.iso.date({ error: '日期格式须为 YYYY-MM-DD' }),
  participants: z.string().trim().max(2000).optional(),
  body: z.string().max(20000).optional(),
});
export type MinuteCreateRequest = z.output<typeof MinuteCreateRequestSchema>;

/** 编辑纪要（部分更新：undefined 不动、null 清空 participants/body） */
export const MinuteUpdateRequestSchema = z.object({
  title: z.string().trim().min(1, { error: '主题不能为空' }).max(128).optional(),
  meetingDate: z.iso.date({ error: '日期格式须为 YYYY-MM-DD' }).optional(),
  participants: z.string().trim().max(2000).nullable().optional(),
  body: z.string().max(20000).nullable().optional(),
});
export type MinuteUpdateRequest = z.output<typeof MinuteUpdateRequestSchema>;

/** 上传的附件（base64 编码；JSON 通道，同 drawio——不引入 multipart） */
export const AttachmentUploadSchema = z.object({
  name: z.string().trim().min(1, { error: '文件名不能为空' }).max(255),
  contentType: z.string().trim().min(1, { error: '文件类型不能为空' }).max(128),
  base64: z.string().min(1, { error: '文件内容不能为空' }).max(8_000_000, {
    error: '附件过大（解码后 ≤ 6MB）',
  }),
});
export type AttachmentUpload = z.output<typeof AttachmentUploadSchema>;

export const MinutesListResponseSchema = z.object({
  minutes: z.array(MeetingMinuteSchema),
  viewerRole: ProjectViewerRoleSchema,
});
export type MinutesListResponse = z.output<typeof MinutesListResponseSchema>;

export const MinuteGetResponseSchema = z.object({
  minute: MeetingMinuteSchema,
  viewerRole: ProjectViewerRoleSchema,
});
export type MinuteGetResponse = z.output<typeof MinuteGetResponseSchema>;

/** 创建/编辑响应 */
export const MinuteResponseSchema = z.object({ minute: MeetingMinuteSchema });
export type MinuteResponse = z.output<typeof MinuteResponseSchema>;

/** 附件上传响应 */
export const AttachmentResponseSchema = z.object({ attachment: AttachmentSchema });
export type AttachmentResponse = z.output<typeof AttachmentResponseSchema>;
