import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: '**/*.browser.mjs', workers: 1, fullyParallel: false, timeout: 30000, use: { timezoneId: 'Asia/Shanghai', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } });
