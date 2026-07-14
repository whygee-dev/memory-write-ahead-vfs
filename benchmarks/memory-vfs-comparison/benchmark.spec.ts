import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import memoryWriteAheadPackage from '../../package.json' with { type: 'json' };

type BrowserRuntime = typeof import('./runtime.js');

const readBoolean = (name: string, fallback: boolean) => {
    const value = process.env[name];
    if (value === undefined) {
        return fallback;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${name} must be true or false; received ${value}`);
};

const readInstalledPackageVersion = (packageName: string) => {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
    const root = parse(directory).root;

    while (directory !== root) {
        const packagePath = join(directory, 'package.json');
        if (existsSync(packagePath)) {
            const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
                name?: string;
                version?: string;
            };
            if (packageJson.name === packageName && packageJson.version) {
                return packageJson.version;
            }
        }
        directory = dirname(directory);
    }

    throw new Error(`Unable to resolve installed version for ${packageName}`);
};

test('compares PowerSync MemoryVFS with Memory Write-Ahead VFS connection pools', async ({ page, baseURL }) => {
    test.setTimeout(30 * 60_000);
    await page.goto(new URL('/test-host.html', baseURL ?? 'http://127.0.0.1:5174').toString());

    const flags = {
        memoryWriteAheadUseWebWorker: readBoolean('BENCHMARK_MWA_USE_WEB_WORKER', true),
        powerSyncUseWebWorker: readBoolean('BENCHMARK_POWERSYNC_USE_WEB_WORKER', true),
    };
    const versions = {
        memoryWriteAheadVfs: memoryWriteAheadPackage.version,
        playwright: readInstalledPackageVersion('@playwright/test'),
        powerSyncCommon: readInstalledPackageVersion('@powersync/common'),
        powerSyncWeb: readInstalledPackageVersion('@powersync/web'),
        vite: readInstalledPackageVersion('vite'),
        waSqlite: readInstalledPackageVersion('@journeyapps/wa-sqlite'),
    };
    const result = await page.evaluate(
        async ({ benchmarkFlags, benchmarkVersions }) => {
            const modulePath = '/benchmarks/memory-vfs-comparison/runtime.ts';
            const runtime = (await import(modulePath)) as BrowserRuntime;
            return runtime.runPublicMemoryVfsBenchmark(benchmarkFlags, benchmarkVersions);
        },
        { benchmarkFlags: flags, benchmarkVersions: versions }
    );

    expect(result.arms).toHaveLength(5);
    expect(result.environment.crossOriginIsolated).toBe(true);
    expect(result.arms.every((arm) => arm.sequential.samples === 100)).toBe(true);
    expect(result.arms.every((arm) => arm.burst.samples === 120)).toBe(true);
    expect(result.arms.every((arm) => arm.mixedRead.samples === 80)).toBe(true);
    expect(result.arms.every((arm) => arm.mixedWrite.samples === 80)).toBe(true);

    const outputPath = resolve(
        process.env.BENCHMARK_OUTPUT ??
            `benchmark-results/memory-vfs-${flags.powerSyncUseWebWorker ? 'worker' : 'main'}-${
                flags.memoryWriteAheadUseWebWorker ? 'worker' : 'main'
            }.json`
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
});
