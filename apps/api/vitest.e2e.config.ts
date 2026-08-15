import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 20000,
    // resetTestDb（migrate + TRUNCATE 31 表）+ Nest 编译在重负载机器上可能超 30s
    hookTimeout: 60000,
    fileParallelism: false,
    // 关键提速：isolate=false 让单 worker 内所有 spec 文件共享模块注册表——
    // Nest 依赖图（fastify/drizzle/…）只 import 一次（默认 isolate=true 每文件
    // 重执行整棵 import，21 文件 ≈ 7-13 分钟纯 import 开销）。每文件 beforeAll
    // 各自 new Nest app + resetTestDb 清库，模块级无共享可变状态，隔离安全。
    poolOptions: {
      forks: {
        isolate: false,
      },
    },
  },
});
