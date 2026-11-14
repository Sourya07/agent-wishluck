import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { DB_PATH: ':memory:', LLM_PROVIDER: 'none', LOG_LEVEL: 'silent', REDIS_URL: '' },
    pool: 'forks',
    testTimeout: 20000,
  },
});
