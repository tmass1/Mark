import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 800, height: 580 } },
  reporter: 'list',
  // Start Vite for the run, or reuse the one already serving pnpm dev.
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:1420', reuseExistingServer: true, timeout: 60_000 },
});
