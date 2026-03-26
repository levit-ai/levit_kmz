import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [path.resolve(__dirname, 'test/setup.ts')],
    include: ['test/unit/**/*.test.ts'],
  },
});
