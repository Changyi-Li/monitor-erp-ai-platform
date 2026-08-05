import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 同源代理：/api/* → NestJS API（浏览器侧零 CORS）
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
