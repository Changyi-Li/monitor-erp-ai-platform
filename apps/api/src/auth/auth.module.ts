import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { UsersController } from './users.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_ACCESS_TTL') ?? '15m') as StringValue,
        },
      }),
    }),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, TokenService, PasswordService],
  // PasswordService 供成员邀请（占位密码）等场景复用
  exports: [PasswordService],
})
export class AuthModule {}
