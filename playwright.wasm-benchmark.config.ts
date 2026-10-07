import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './benchmarks/wasm-build-comparison',
    testMatch: 'benchmark.spec.ts',
    timeout: 60 * 60_000,
    expect: {
        timeout: 5_000,
    },
    fullyParallel: false,
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:5175',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'pnpm exec vite --host 127.0.0.1 --port 5175',
        url: 'http://127.0.0.1:5175/test-host.html',
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
