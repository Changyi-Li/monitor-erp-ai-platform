import { describe, expect, it } from 'vitest';
import {
  CustomerCreateRequestSchema,
  CustomerCreateResponseSchema,
  CustomerSchema,
  CustomerUpdateRequestSchema,
  CustomerUpdateResponseSchema,
  CustomersListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validCustomer = {
  id: validUuid,
  name: '客户A',
  industry: null,
  region: null,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('customers 契约：CustomerSchema', () => {
  it('接受合法客户对象（industry/region 可空）', () => {
    expect(CustomerSchema.safeParse(validCustomer).success).toBe(true);
  });

  it('接受带 industry/region 的客户对象', () => {
    expect(
      CustomerSchema.safeParse({ ...validCustomer, industry: '制造业', region: '华东' }).success,
    ).toBe(true);
  });

  it('拒绝空名称 / 非法 uuid', () => {
    expect(CustomerSchema.safeParse({ ...validCustomer, name: '  ' }).success).toBe(false);
    expect(CustomerSchema.safeParse({ ...validCustomer, id: 'x' }).success).toBe(false);
  });
});

describe('customers 契约：创建', () => {
  it('接受合法创建请求', () => {
    expect(CustomerCreateRequestSchema.safeParse({ name: '客户B' }).success).toBe(true);
    expect(
      CustomerCreateRequestSchema.safeParse({ name: '客户B', industry: '零售', region: '华南' }).success,
    ).toBe(true);
  });

  it('拒绝空名称与超长名称', () => {
    expect(CustomerCreateRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(CustomerCreateRequestSchema.safeParse({ name: 'x'.repeat(129) }).success).toBe(false);
  });

  it('创建响应为 { customer }', () => {
    expect(CustomerCreateResponseSchema.safeParse({ customer: validCustomer }).success).toBe(true);
  });
});

describe('customers 契约：列表', () => {
  it('列表响应为 { customers: Customer[] }', () => {
    expect(
      CustomersListResponseSchema.safeParse({ customers: [validCustomer] }).success,
    ).toBe(true);
    expect(CustomersListResponseSchema.safeParse({ customers: [] }).success).toBe(true);
    expect(CustomersListResponseSchema.safeParse({ customers: [{}] }).success).toBe(false);
  });
});

describe('customers 契约：编辑', () => {
  it('接受部分更新请求（可只改一个字段）', () => {
    expect(CustomerUpdateRequestSchema.safeParse({ name: '客户A改' }).success).toBe(true);
    expect(CustomerUpdateRequestSchema.safeParse({ industry: '零售' }).success).toBe(true);
  });

  it('industry/region 可显式传 null 清空', () => {
    expect(
      CustomerUpdateRequestSchema.safeParse({ industry: null, region: null }).success,
    ).toBe(true);
  });

  it('空对象合法（无操作）', () => {
    expect(CustomerUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it('拒绝空名称与超长名称', () => {
    expect(CustomerUpdateRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(CustomerUpdateRequestSchema.safeParse({ name: 'x'.repeat(129) }).success).toBe(false);
  });

  it('编辑响应为 { customer }', () => {
    expect(CustomerUpdateResponseSchema.safeParse({ customer: validCustomer }).success).toBe(true);
  });
});
