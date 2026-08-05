'use client';

import {
  MeResponseSchema,
  type User,
} from '@monitor/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '../lib/api';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
} from '../lib/token-store';

interface AuthContextValue {
  user: User | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  /** 重新拉取当前用户（登录后调用） */
  refresh: () => Promise<void>;
  /** 登出：调 API 清会话 + 清本地 token */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'authenticated' | 'unauthenticated'
  >('loading');

  const refresh = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    try {
      const data = await apiFetch('/api/auth/me', {
        schema: MeResponseSchema,
      });
      setUser(data.user);
      setStatus('authenticated');
    } catch {
      clearTokens();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
        body: { refreshToken: getRefreshToken() },
        schema: MeResponseSchema.optional(),
        auth: true,
      });
    } catch {
      // 登出失败不阻塞：本地 token 一律清除
    }
    clearTokens();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, status, refresh, logout }),
    [user, status, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return ctx;
}
