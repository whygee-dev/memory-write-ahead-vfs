import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform, arch } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import memoryWriteAheadPackage from '../../package.json' with { type: 'json' };

import { DATASET, WORKLOAD } from './dataset.js';
import type { WasmBuildRunRequest, WasmBuildRunResult, WorkloadName } from './worker.js';

type ArmName = 'stock' | 'rebuilt';

type Arm = {
    directory: string;
    name: ArmName;
    source: string;
};

type Summary = {
    max: number;
    median: number;
    min: number;
    runs: number;
};

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const readPositiveEvenInteger = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 2 || value % 2 !== 0) {
        throw new Error(`${name} must be a positive even integer; received ${process.env[name]}`);
    }
    return value;
};

const readPackageVersion = (packageName: string) => {
    const packageJson = JSON.parse(
        readFileSync(join(REPOSITORY_ROOT, 'node_modules', packageName, 'package.json'), 'utf8')
    ) as { version: string };
    return packageJson.version;
};

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const round = (value: number) => Math.round(value * 100) / 100;

const median = (values: readonly number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle] ?? Number.NaN;
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? Number.NaN) + upper) / 2 : upper;
};

const summarize = (values: readonly number[]): Summary => ({
    max: round(Math.max(...values)),
    median: round(median(values)),
    min: round(Math.min(...values)),
    runs: values.length,
});

const resolveCandidateDirectory = () => {
    const directory = resolve(REPOSITORY_ROOT, process.env.WASM_BENCHMARK_CANDIDATE_DIR ?? 'wasm/dist');
    const relativeDirectory = relative(REPOSITORY_ROOT, directory);
    if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) {
        throw new Error('WASM_BENCHMARK_CANDIDATE_DIR must be inside the repository so Vite can serve it');
    }
    if (!existsSync(join(directory, 'wa-sqlite.mjs')) || !existsSync(join(directory, 'wa-sqlite.wasm'))) {
        throw new Error(`${relativeDirectory} has no wa-sqlite.mjs and wa-sqlite.wasm; run pnpm build:wasm first`);
    }
    return relativeDirectory.split('\\').join('/');
};

const createSchedule = (runsPerArm: number): ArmName[] =>
    Array.from({ length: runsPerArm / 2 }, (_, block): ArmName[] =>
        block % 2 === 0 ? ['stock', 'rebuilt', 'rebuilt', 'stock'] : ['rebuilt', 'stock', 'stock', 'rebuilt']
    ).flat();

test('compares the stock and rebuilt wa-sqlite builds through Memory Write-Ahead VFS', async ({ browser, baseURL }) => {
    test.setTimeout(60 * 60_000);

    const runsPerArm = readPositiveEvenInteger('BENCHMARK_RUNS_PER_ARM', 16);
    const arms: readonly Arm[] = [
        {
            directory: 'node_modules/@journeyapps/wa-sqlite/dist',
            name: 'stock',
            source: `npm @journeyapps/wa-sqlite ${readPackageVersion('@journeyapps/wa-sqlite')}`,
        },
        { directory: resolveCandidateDirectory(), name: 'rebuilt', source: 'wasm/Dockerfile' },
    ];
    const armByName = new Map(arms.map((arm) => [arm.name, arm]));
    const artifacts = arms.map((arm) => ({
        directory: arm.directory,
        glueSha256: sha256File(join(REPOSITORY_ROOT, arm.directory, 'wa-sqlite.mjs')),
        name: arm.name,
        source: arm.source,
        wasmSha256: sha256File(join(REPOSITORY_ROOT, arm.directory, 'wa-sqlite.wasm')),
    }));

    const runArm = async (armName: ArmName) => {
        const arm = armByName.get(armName);
        if (!arm) {
            throw new Error(`Unknown arm ${armName}`);
        }
        const context = await browser.newContext({ baseURL: baseURL ?? 'http://127.0.0.1:5175' });
        try {
            const page = await context.newPage();
            await page.goto('/test-host.html');
            const request: WasmBuildRunRequest = {
                glueUrl: `/${arm.directory}/wa-sqlite.mjs`,
                wasmUrl: `/${arm.directory}/wa-sqlite.wasm`,
            };
            return await page.evaluate(
                (runRequest) =>
                    new Promise<WasmBuildRunResult>((resolveRun, rejectRun) => {
                        const worker = new Worker('/benchmarks/wasm-build-comparison/worker.ts', { type: 'module' });
                        worker.onmessage = (
                            event: MessageEvent<
                                { ok: true; result: WasmBuildRunResult } | { ok: false; message: string }
                            >
                        ) => {
                            worker.terminate();
                            if (event.data.ok) {
                                resolveRun(event.data.result);
                            } else {
                                rejectRun(new Error(event.data.message));
                            }
                        };
                        worker.onerror = (event) => {
                            worker.terminate();
                            rejectRun(new Error(event.message || 'Benchmark worker failed to load'));
                        };
                        worker.postMessage(runRequest);
                    }),
                request
            );
        } finally {
            await context.close();
        }
    };

    const loadAverageAtStart = loadavg().map(round);
    for (const arm of arms) {
        console.info(`[wasm-build-benchmark] priming ${arm.name}`);
        await runArm(arm.name);
    }

    const schedule = createSchedule(runsPerArm);
    const runs: Array<{ arm: ArmName; loadAverage1m: number; result: WasmBuildRunResult; run: number }> = [];
    for (const [index, armName] of schedule.entries()) {
        const loadAverage1m = round(loadavg()[0] ?? 0);
        console.info(`[wasm-build-benchmark] run ${index + 1}/${schedule.length} ${armName}`);
        runs.push({ arm: armName, loadAverage1m, result: await runArm(armName), run: index + 1 });
    }
    const loadAverageAtEnd = loadavg().map(round);

    const firstRun = runs[0];
    if (!firstRun) {
        throw new Error('The benchmark recorded no runs');
    }
    for (const run of runs) {
        expect(run.result.crossOriginIsolated).toBe(true);
        expect(run.result.fingerprints).toEqual(firstRun.result.fingerprints);
        expect(run.result.rowCounts).toEqual(firstRun.result.rowCounts);
        expect(run.result.build.wasmSha256).toBe(artifacts.find((artifact) => artifact.name === run.arm)?.wasmSha256);
    }

    const workloadNames = Object.keys(firstRun.result.measuredMs) as WorkloadName[];
    const summaries = Object.fromEntries(
        arms.map((arm) => {
            const armRuns = runs.filter((run) => run.arm === arm.name).map((run) => run.result);
            return [
                arm.name,
                {
                    ...Object.fromEntries(
                        workloadNames.map((name) => [
                            name,
                            summarize(armRuns.map((run) => median(run.measuredMs[name]))),
                        ])
                    ),
                    instantiate: summarize(armRuns.map((run) => run.instantiateMs)),
                    seed: summarize(armRuns.map((run) => run.seedMs)),
                },
            ];
        })
    );

    const result = {
        resultFormat: 'wasm-build-comparison-v1',
        runDate: new Date().toISOString().slice(0, 10),
        environment: {
            browser: `Chromium ${browser.version()}`,
            crossOriginIsolated: firstRun.result.crossOriginIsolated,
            hardwareConcurrency: firstRun.result.hardwareConcurrency,
            host: {
                arch: arch(),
                cpuModel: cpus()[0]?.model ?? 'unknown',
                logicalCpus: cpus().length,
                platform: platform(),
            },
            loadAverageAtEnd,
            loadAverageAtStart,
        },
        runtimeVersions: {
            memoryWriteAheadVfs: memoryWriteAheadPackage.version,
            playwright: readPackageVersion('@playwright/test'),
            vite: readPackageVersion('vite'),
            waSqlite: readPackageVersion('@journeyapps/wa-sqlite'),
        },
        configuration: {
            dataset: DATASET,
            primingRunsPerArm: 1,
            runsPerArm,
            schedule: 'ABBA/BAAB blocks, fresh browser context, page and worker per run',
            summaryUnit: 'per-run median of measured rounds; instantiate and seed are one sample per run',
            vfs: 'MemoryWriteAheadVFS in a dedicated worker',
            workload: WORKLOAD,
        },
        arms: artifacts.map((artifact) => {
            const build = runs.find((run) => run.arm === artifact.name)?.result.build;
            return { ...artifact, ...build };
        }),
        fingerprints: firstRun.result.fingerprints,
        rowCounts: firstRun.result.rowCounts,
        summaries,
        runs: runs.map(({ arm, loadAverage1m, result: { instantiateMs, measuredMs, seedMs }, run }) => ({
            arm,
            instantiateMs: round(instantiateMs),
            loadAverage1m,
            measuredMs: Object.fromEntries(
                Object.entries(measuredMs).map(([name, values]) => [name, values.map(round)])
            ),
            run,
            seedMs: round(seedMs),
        })),
    };

    const outputPath = resolve(
        REPOSITORY_ROOT,
        process.env.BENCHMARK_OUTPUT ?? 'benchmark-results/wasm-build-comparison.json'
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.info(`[wasm-build-benchmark] ${JSON.stringify(summaries)}`);
});
