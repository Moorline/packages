import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': new URL('./tests/fixtures/pi-coding-agent-mock.ts', import.meta.url).pathname
    }
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['packages/**/*.ts']
    }
  }
});
