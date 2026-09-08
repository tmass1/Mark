import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/build/**'] } },
  build: {
    target: 'safari15', sourcemap: true,
    // The editor and the selection overlay are separate windows, so separate pages.
    rollupOptions: { input: { main: 'index.html', selector: 'selector.html' } },
  },
  // Unit tests live beside the source. tests/ belongs to Playwright.
  test: { include: ['src/**/*.test.ts'] },
});
