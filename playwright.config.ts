import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/browser',
    timeout: 45_000,
    expect: {
        timeout: 5_000,
    },
    fullyParallel: false,
    use: {
        baseURL: 'http://127.0.0.1:5173',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'pnpm exec vite --host 127.0.0.1 --port 5173',
        url: 'http://127.0.0.1:5173/test-host.html',
        reuseExistingServer: !process.env.CI,
        timeout: 20_000,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
