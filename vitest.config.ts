import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'frontend', 'ml', 'dist'],
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    testTimeout: 15_000,
  },
});
