import { z } from 'zod';

/** 客户（租户注册表）。建客户为超管专属（customer:create），维护归内部（customer:manage） */
export const CustomerSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(128),
  industry: z.string().max(64).nullable().optional(),
  region: z.string().max(64).nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.output<typeof CustomerSchema>;

export const CustomerCreateRequestSchema = z.object({
  name: z.string().trim().min(1, { error: '客户名称不能为空' }).max(128),
  industry: z.string().trim().max(64).optional(),
  region: z.string().trim().max(64).optional(),
});
export type CustomerCreateRequest = z.output<typeof CustomerCreateRequestSchema>;

export const CustomerCreateResponseSchema = z.object({
  customer: CustomerSchema,
});
export type CustomerCreateResponse = z.output<typeof CustomerCreateResponseSchema>;

export const CustomersListResponseSchema = z.object({
  customers: z.array(CustomerSchema),
});
export type CustomersListResponse = z.output<typeof CustomersListResponseSchema>;

/** 编辑客户（内部+；industry/region 可显式传 null 清空，undefined 表示不动） */
export const CustomerUpdateRequestSchema = z.object({
  name: z.string().trim().min(1, { error: '客户名称不能为空' }).max(128).optional(),
  industry: z.string().trim().max(64).nullable().optional(),
  region: z.string().trim().max(64).nullable().optional(),
});
export type CustomerUpdateRequest = z.output<typeof CustomerUpdateRequestSchema>;

export const CustomerUpdateResponseSchema = z.object({
  customer: CustomerSchema,
});
export type CustomerUpdateResponse = z.output<typeof CustomerUpdateResponseSchema>;
