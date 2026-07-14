import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getExpectedRuntimeVersions, sanitizeBenchmarkResult } from './publish-benchmark-result.mjs';

const createValidRawResult = async () => {
    const publicResult = JSON.parse(
        await readFile(
            new URL('../benchmarks/memory-vfs-comparison/results/both-workers.json', import.meta.url),
            'utf8'
        )
    );
    const { resultFormat: _resultFormat, runDate, ...rawResult } = publicResult;
    rawResult.generatedAt = `${runDate}T12:00:00.000Z`;
    rawResult.environment = {
        crossOriginIsolated: publicResult.environment.crossOriginIsolated,
        hardwareConcurrency: publicResult.environment.hardwareConcurrency,
        userAgent: `Mozilla/5.0 Chrome/${publicResult.environment.browser.replace('Chromium ', '')} Safari/537.36`,
    };
    rawResult.runtimeVersions = getExpectedRuntimeVersions();
    rawResult.configuration.correctnessValidation = [
        ...rawResult.configuration.correctnessValidation.filter((name) => name !== 'additional-reader-query-only'),
        'additional-reader-query-only',
    ];
    rawResult.arms.forEach((arm) => {
        arm.aggregateCacheSizeKiB = rawResult.configuration.cacheSizeKiB * arm.connectionCount;
    });
    return rawResult;
};

const WORKER_FLAGS = {
    memoryWriteAheadUseWebWorker: true,
    powerSyncUseWebWorker: true,
};

test('sanitizes a complete benchmark result', async () => {
    const result = sanitizeBenchmarkResult(await createValidRawResult(), WORKER_FLAGS);

    assert.equal(result.resultFormat, 'memory-vfs-implementation-stack-v1');
    assert.equal(result.environment.browser.startsWith('Chromium '), true);
    assert.equal('userAgent' in result.environment, false);
    assert.equal('generatedAt' in result, false);
});

test('rejects stale versions, malformed summaries, topology drift, and wrong flags', async (context) => {
    await context.test('stale dependency version', async () => {
        const input = await createValidRawResult();
        input.runtimeVersions.powerSyncWeb = '0.0.0';
        assert.throws(() => sanitizeBenchmarkResult(input, WORKER_FLAGS), /runtimeVersions/);
    });

    await context.test('wrong sample count', async () => {
        const input = await createValidRawResult();
        input.arms[0].burst.samples -= 1;
        assert.throws(() => sanitizeBenchmarkResult(input, WORKER_FLAGS), /samples must be 120/);
    });

    await context.test('non-finite latency', async () => {
        const input = await createValidRawResult();
        input.arms[0].sequential.p50 = Number.NaN;
        assert.throws(() => sanitizeBenchmarkResult(input, WORKER_FLAGS), /must be finite/);
    });

    await context.test('aggregate cache mismatch', async () => {
        const input = await createValidRawResult();
        input.arms[2].aggregateCacheSizeKiB = 32_768;
        assert.throws(() => sanitizeBenchmarkResult(input, WORKER_FLAGS), /aggregateCacheSizeKiB/);
    });

    await context.test('wrong worker flags', async () => {
        const input = await createValidRawResult();
        assert.throws(
            () =>
                sanitizeBenchmarkResult(input, {
                    memoryWriteAheadUseWebWorker: true,
                    powerSyncUseWebWorker: false,
                }),
            /harness flags/
        );
    });
});

test('published README tables match committed result artifacts', async () => {
    const readme = await readFile(new URL('../benchmarks/memory-vfs-comparison/README.md', import.meta.url), 'utf8');
    const labels = {
        'powersync-memory-vfs-1': 'PowerSync MemoryVFS — 1 connection',
        'memory-write-ahead-1': 'Memory Write-Ahead VFS — 1 connection',
        'memory-write-ahead-2': 'Memory Write-Ahead VFS — 2-connection pool',
        'memory-write-ahead-3': 'Memory Write-Ahead VFS — 3-connection pool',
        'memory-write-ahead-4': 'Memory Write-Ahead VFS — 4-connection pool',
    };

    for (const resultName of ['both-workers', 'application-workers', 'both-main-thread']) {
        const result = JSON.parse(
            await readFile(
                new URL(`../benchmarks/memory-vfs-comparison/results/${resultName}.json`, import.meta.url),
                'utf8'
            )
        );
        for (const arm of result.arms) {
            const cells = ['sequential', 'burst', 'mixedRead', 'mixedWrite', 'poolReady']
                .map((metric) => `${arm[metric].p50.toFixed(2)} / ${arm[metric].p95.toFixed(2)}`)
                .join('\\s*\\|\\s*');
            const label = labels[arm.name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            assert.match(readme, new RegExp(`\\|\\s*${label}\\s*\\|\\s*${cells}\\s*\\|`));
        }
    }
});
