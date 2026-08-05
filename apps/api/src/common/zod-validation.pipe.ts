import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

/**
 * 请求体契约校验：zod safeParse 失败 → 400 并携带 issue 摘要；
 * 成功注入 parsed 数据（zod 默认 strip 未知字段，防多传字段）。
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message),
      );
      throw new BadRequestException(issues);
    }
    return result.data;
  }
}
