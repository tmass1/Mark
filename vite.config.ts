import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/build/**'] } },
  build: { target: 'safari15', sourcemap: true },
  // Unit tests live beside the source. tests/ belongs to Playwright.
  test: { include: ['src/**/*.test.ts'] },
});
