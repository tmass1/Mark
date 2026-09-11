import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/build/**'] } },
  // Relative asset paths, so the built pages work from any folder -- the app
  // loads them from its own root, the web demo from wherever it is hosted.
  base: './',
  build: {
    target: 'safari15', sourcemap: true,
    // The editor, the selection overlay and settings are separate windows, so
    // separate pages. The demo page hosts copies of each in frames.
    rollupOptions: { input: {
      main: 'index.html', selector: 'selector.html', settings: 'settings.html',
      demo: 'demo.html', demoEditor: 'demo/editor.html', demoSelector: 'demo/selector.html', demoSettings: 'demo/settings.html',
    } },
  },
  // Unit tests live beside the source. tests/ belongs to Playwright.
  test: { include: ['src/**/*.test.ts'] },
});
