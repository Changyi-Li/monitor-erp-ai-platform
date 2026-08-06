import {
  ErrorResponseSchema,
  RefreshResponseSchema,
  type ApiError as ApiErrorContract,
} from '@monitor/contracts';
import type { z } from 'zod';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  saveTokens,
} from './token-store';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiFetchOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 响应契约：返回体经 safeParse 校验；省略 = 不校验（204/无 body 的端点，如 DELETE） */
  schema?: z.ZodType<T>;
  /** 是否携带 Authorization 头（默认 true；refresh 场景传 false） */
  auth?: boolean;
}

/**
 * fetch 封装：Authorization 头 + 响应契约校验 + 401 时 refresh 一次重试。
 * 错误统一转为 ApiError（message 取契约错误文案）。
 */
export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions<T>,
  _retried = false,
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== false && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  // access token 过期 → refresh 一次重试
  if (res.status === 401 && opts.auth !== false && token && !_retried) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch(path, opts, true);
    }
    clearTokens();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new ApiError(401, '登录已过期');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(data);
    const message = err.success
      ? Array.isArray(err.data.message)
        ? err.data.message.join('；')
        : err.data.message
      : '请求失败';
    throw new ApiError(res.status, message);
  }

  // 204/无 body（DELETE 等）跳过契约校验
  const parsed = opts.schema?.safeParse(data);
  if (parsed && !parsed.success) {
    throw new ApiError(500, '响应不符合契约');
  }
  return (parsed?.data ?? undefined) as T;
}

/** 轮换式刷新：成功返回 true 并写入新令牌 */
async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return false;
  }
  try {
    const data = await apiFetch<z.output<typeof RefreshResponseSchema>>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: { refreshToken },
        schema: RefreshResponseSchema,
        auth: false,
      },
    );
    saveTokens(data.accessToken, data.refreshToken);
    return true;
  } catch (err) {
    if (err instanceof ApiError) {
      return false;
    }
    throw err;
  }
}

/** 错误对象形状（前端展示用） */
export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : '发生未知错误';
}

export type { ApiErrorContract };
