import { defineConfig } from 'vitest/config';

/**
 * Perf suite: throughput budgets for pure hot-path helpers.
 * Thresholds are generous for shared GH runners but still catch major regressions.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.test.ts'],
    exclude: ['node_modules', 'frontend', 'ml', 'dist'],
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    testTimeout: 60_000,
    // Avoid parallel contention skewing timings on small runners
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
