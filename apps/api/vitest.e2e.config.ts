import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 20000,
    // resetTestDb（migrate + TRUNCATE 31 表）+ Nest 编译在重负载机器上可能超 30s
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
