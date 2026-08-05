import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export interface GeneratedRefreshToken {
  /** 返回给客户端的一次性明文 token */
  token: string;
  /** 落库的 sha256 hex，库被拖走也拿不到可用 token */
  tokenHash: string;
  expiresAt: Date;
}

const TTL_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function ttlToMs(ttl: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(ttl.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (!amount || !unit) {
    throw new Error(`无法解析 TTL 格式: ${ttl}（支持 s/m/h/d）`);
  }
  return Number(amount) * (TTL_UNIT_MS[unit] ?? 0);
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  signAccessToken(payload: AccessTokenPayload): { token: string; expiresIn: number } {
    const token = this.jwt.sign(payload);
    const expiresIn = ttlToMs(
      this.config.get<string>('JWT_ACCESS_TTL') ?? '15m',
    );
    return { token, expiresIn: Math.floor(expiresIn / 1000) };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token);
  }

  generateRefreshToken(): GeneratedRefreshToken {
    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() +
        ttlToMs(this.config.get<string>('JWT_REFRESH_TTL') ?? '30d'),
    );
    return { token, tokenHash: sha256(token), expiresAt };
  }

  hashRefreshToken(token: string): string {
    return sha256(token);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
