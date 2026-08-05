/**
 * 浏览器端 Token 存储（localStorage）。
 * 骨架期方案：未来换 httpOnly cookie / Redis 会话时，改这个模块即可（接缝）。
 */

const ACCESS_TOKEN_KEY = 'monitor.accessToken';
const REFRESH_TOKEN_KEY = 'monitor.refreshToken';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function saveTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}
