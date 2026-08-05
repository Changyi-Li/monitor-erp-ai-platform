import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ZodResponseInterceptor } from './common/zod-response.interceptor';
import { validateEnv } from './config/env.schema';
import { DrizzleModule } from './database/database.module';

@Module({
  imports: [
    // .env.test 优先（e2e），生产回退 .env
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env.test', '.env'],
    }),
    DrizzleModule.forRoot(),
    AuthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ZodResponseInterceptor },
  ],
})
export class AppModule {}
