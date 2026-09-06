import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3001';
// NOTE: 5173 is commonly taken by another dev server; e2e uses 5174.
const WEB_URL = process.env.PLAYWRIGHT_WEB_URL ?? 'http://localhost:5174';
const WEB_PORT = new URL(WEB_URL).port || '5174';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : [
        {
          command: 'npm run dev -w @nexus/api',
          url: `${API_URL}/v1/health`,
          reuseExistingServer: true,
          timeout: 180_000,
          env: {
            ...(process.env as Record<string, string>),
            PORT: '3001',
            WEB_ORIGIN: WEB_URL,
          },
        },
        {
          command: `npm run preview -w @nexus/web -- --port ${WEB_PORT} --strictPort`,
          url: WEB_URL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
