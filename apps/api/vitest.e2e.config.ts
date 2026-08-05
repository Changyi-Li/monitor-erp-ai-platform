import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
