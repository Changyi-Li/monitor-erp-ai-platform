import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { ZodResponseInterceptor } from './common/zod-response.interceptor';
import { validateEnv } from './config/env.schema';
import { MqModule } from './adapters/mq/mq.module';
import { StorageModule } from './adapters/storage/storage.module';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';
import { DrizzleModule } from './database/database.module';
import { TenantInterceptor } from './database/tenant.interceptor';
import { IssuesModule } from './issues/issues.module';
import { ProjectsModule } from './projects/projects.module';

@Module({
  imports: [
    // .env.test 优先（e2e），生产回退 .env
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env.test', '.env'],
    }),
    DrizzleModule.forRoot(),
    StorageModule.forRoot(),
    MqModule.forRoot(),
    AuditModule,
    AuthModule,
    CustomersModule,
    ProjectsModule,
    IssuesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 平台角色 Guard：@Roles 路由检查（纯 JWT，零 DB）；项目级权限在 service 层
    { provide: APP_GUARD, useClass: RolesGuard },
    // 租户拦截器必须在外层：先开事务设 GUC，再进 handler；
    // 契约不符时整个请求事务回滚（响应侧失败不污染数据库）
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ZodResponseInterceptor },
  ],
})
export class AppModule {}
