import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';
import type { z } from 'zod';

export const ZOD_RESPONSE_SCHEMA = 'zod_response_schema';

/** 声明响应契约：返回体经 schema safeParse，不匹配 → 500 */
export const ZodResponse = (schema: z.ZodType) =>
  SetMetadata(ZOD_RESPONSE_SCHEMA, schema);

@Injectable()
export class ZodResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<z.ZodType | undefined>(
      ZOD_RESPONSE_SCHEMA,
      context.getHandler(),
    );
    if (!schema) {
      return next.handle();
    }
    return next.handle().pipe(
      map((data) => {
        const result = schema.safeParse(data);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          throw new InternalServerErrorException(`响应不符合契约: ${issues}`);
        }
        return result.data;
      }),
    );
  }
}
