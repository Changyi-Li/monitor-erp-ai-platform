import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 标记路由为公开（跳过全局 JWT Guard），用于 register/login/refresh */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
