import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const ROOT_PACKAGE = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
const CORRECTNESS_VALIDATION = [
    'dataset-row-counts',
    'cross-arm-full-result-sha256',
    'per-trial-checksum',
    'write-row-count',
    'final-write-values',
    'additional-reader-query-only',
];
const DATASET = {
    collections: 30,
    runs: 12,
    recordsPerCollection: 1_000,
    labelsPerCollection: 100,
    groups: 6,
};
const EXPECTED_ARMS = [
    {
        additionalReaderCount: 0,
        connectionCount: 1,
        name: 'powersync-memory-vfs-1',
        vfs: 'InMemoryVFS',
    },
    {
        additionalReaderCount: 0,
        connectionCount: 1,
        name: 'memory-write-ahead-1',
        vfs: 'MemoryWriteAheadVFS',
    },
    {
        additionalReaderCount: 1,
        connectionCount: 2,
        name: 'memory-write-ahead-2',
        vfs: 'MemoryWriteAheadVFS',
    },
    {
        additionalReaderCount: 2,
        connectionCount: 3,
        name: 'memory-write-ahead-3',
        vfs: 'MemoryWriteAheadVFS',
    },
    {
        additionalReaderCount: 3,
        connectionCount: 4,
        name: 'memory-write-ahead-4',
        vfs: 'MemoryWriteAheadVFS',
    },
];
const EXPECTED_CONFIGURATION = {
    burstTrials: 12,
    cacheSizeKiB: 32 * 1_024,
    correctnessValidation: CORRECTNESS_VALIDATION,
    dataset: DATASET,
    mixedTrials: 8,
    openPasses: 30,
    queriesPerTrial: 8,
    sequentialTrials: 10,
    warmupTrials: 2,
    workloadPasses: 10,
};
const SUMMARY_SAMPLES = {
    burst: 120,
    firstRead: 30,
    firstWrite: 30,
    mixedRead: 80,
    mixedWrite: 80,
    poolReady: 30,
    seed: 10,
    sequential: 100,
};

const assertCondition = (condition, message) => {
    if (!condition) {
        throw new Error(`Invalid benchmark result: ${message}`);
    }
};

const assertExactKeys = (value, expectedKeys, label) => {
    assertCondition(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
    const actualKeys = Object.keys(value).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    assertCondition(
        isDeepStrictEqual(actualKeys, sortedExpectedKeys),
        `${label} keys must be ${sortedExpectedKeys.join(', ')}; received ${actualKeys.join(', ')}`
    );
};

const readInstalledPackageVersion = (packageName) => {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
    const root = parse(directory).root;

    while (directory !== root) {
        const packagePath = join(directory, 'package.json');
        if (existsSync(packagePath)) {
            const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
            if (packageJson.name === packageName && typeof packageJson.version === 'string') {
                return packageJson.version;
            }
        }
        directory = dirname(directory);
    }

    throw new Error(`Unable to resolve installed version for ${packageName}`);
};

export const getExpectedRuntimeVersions = () => ({
    memoryWriteAheadVfs: ROOT_PACKAGE.version,
    playwright: readInstalledPackageVersion('@playwright/test'),
    powerSyncCommon: readInstalledPackageVersion('@powersync/common'),
    powerSyncWeb: readInstalledPackageVersion('@powersync/web'),
    vite: readInstalledPackageVersion('vite'),
    waSqlite: readInstalledPackageVersion('@journeyapps/wa-sqlite'),
});

const validateSummary = (summary, expectedSamples, label) => {
    assertExactKeys(summary, ['max', 'mean', 'min', 'p50', 'p95', 'samples'], label);
    const values = ['max', 'mean', 'min', 'p50', 'p95'].map((key) => summary[key]);
    assertCondition(
        values.every((value) => Number.isFinite(value) && value >= 0),
        `${label} must be finite`
    );
    assertCondition(Number.isInteger(summary.samples), `${label}.samples must be an integer`);
    assertCondition(summary.samples === expectedSamples, `${label}.samples must be ${expectedSamples}`);
    assertCondition(
        summary.min <= summary.p50 && summary.p50 <= summary.p95 && summary.p95 <= summary.max,
        `${label} percentiles must satisfy min <= p50 <= p95 <= max`
    );
    assertCondition(
        summary.min <= summary.mean && summary.mean <= summary.max,
        `${label}.mean must be between min and max`
    );
};

export const sanitizeBenchmarkResult = (input, expectedFlags) => {
    assertExactKeys(
        input,
        [
            'arms',
            'comparisonScope',
            'configuration',
            'environment',
            'generatedAt',
            'harness',
            'runtimeVersions',
            'schemaVersion',
        ],
        'root'
    );
    assertCondition(input.schemaVersion === 1, 'schemaVersion must be 1');
    assertCondition(input.comparisonScope === 'implementation-stack', 'comparisonScope must be implementation-stack');
    assertCondition(
        typeof input.generatedAt === 'string' && new Date(input.generatedAt).toISOString() === input.generatedAt,
        'generatedAt must be an ISO timestamp'
    );

    assertExactKeys(input.environment, ['crossOriginIsolated', 'hardwareConcurrency', 'userAgent'], 'environment');
    const chromeVersion = /Chrome\/([^ ]+)/.exec(input.environment.userAgent)?.[1];
    assertCondition(Boolean(chromeVersion), 'userAgent must contain a recognizable Chromium version');
    assertCondition(input.environment.crossOriginIsolated === true, 'crossOriginIsolated must be true');
    assertCondition(
        Number.isInteger(input.environment.hardwareConcurrency) && input.environment.hardwareConcurrency > 0,
        'hardwareConcurrency must be a positive integer'
    );

    const expectedHarness = {
        memoryWriteAheadUseWebWorker: expectedFlags.memoryWriteAheadUseWebWorker,
        powerSyncUseWebWorker: expectedFlags.powerSyncUseWebWorker,
        webServer: 'vite-development',
    };
    assertCondition(isDeepStrictEqual(input.harness, expectedHarness), 'harness flags do not match the requested run');
    assertCondition(
        isDeepStrictEqual(input.runtimeVersions, getExpectedRuntimeVersions()),
        'runtimeVersions do not match installed dependencies'
    );
    assertCondition(
        isDeepStrictEqual(input.configuration, EXPECTED_CONFIGURATION),
        'configuration does not match the published harness contract'
    );

    assertCondition(
        Array.isArray(input.arms) && input.arms.length === EXPECTED_ARMS.length,
        'arms must contain 5 entries'
    );
    const armNames = input.arms.map((arm) => arm?.name);
    assertCondition(new Set(armNames).size === EXPECTED_ARMS.length, 'arm names must be unique');
    input.arms.forEach((arm, index) => {
        assertExactKeys(
            arm,
            [
                'additionalReaderCount',
                'aggregateCacheSizeKiB',
                'burst',
                'connectionCount',
                'firstRead',
                'firstWrite',
                'mixedRead',
                'mixedWrite',
                'name',
                'poolReady',
                'seed',
                'sequential',
                'vfs',
            ],
            `arms[${index}]`
        );
        const expectedArm = EXPECTED_ARMS[index];
        assertCondition(
            expectedArm &&
                arm.name === expectedArm.name &&
                arm.vfs === expectedArm.vfs &&
                arm.connectionCount === expectedArm.connectionCount &&
                arm.additionalReaderCount === expectedArm.additionalReaderCount,
            `arms[${index}] topology does not match the harness`
        );
        assertCondition(
            arm.aggregateCacheSizeKiB === EXPECTED_CONFIGURATION.cacheSizeKiB * arm.connectionCount,
            `arms[${index}].aggregateCacheSizeKiB does not match its connection count`
        );
        Object.entries(SUMMARY_SAMPLES).forEach(([name, samples]) => {
            validateSummary(arm[name], samples, `arms[${index}].${name}`);
        });
    });

    return {
        resultFormat: 'memory-vfs-implementation-stack-v1',
        schemaVersion: input.schemaVersion,
        runDate: input.generatedAt.slice(0, 10),
        comparisonScope: input.comparisonScope,
        environment: {
            browser: `Chromium ${chromeVersion}`,
            crossOriginIsolated: input.environment.crossOriginIsolated,
            hardwareConcurrency: input.environment.hardwareConcurrency,
        },
        harness: input.harness,
        runtimeVersions: input.runtimeVersions,
        configuration: input.configuration,
        arms: input.arms,
    };
};

const serializePublicResult = (result) => {
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const forbiddenPatterns = [/\/Users\//i, /\\Users\\/i, /\.codex/i, /beeldi/i, /generatedAt/i, /userAgent/i];

    for (const pattern of forbiddenPatterns) {
        if (pattern.test(serialized)) {
            throw new Error(`Refusing to publish benchmark result matching ${pattern}`);
        }
    }
    return serialized;
};

export const publishBenchmarkResultFile = async (inputPath, outputPath, expectedFlags) => {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
    const serialized = serializePublicResult(sanitizeBenchmarkResult(input, expectedFlags));
    const resolvedOutputPath = resolve(outputPath);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, serialized, 'utf8');
};

const parseBoolean = (value, label) => {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${label} must be true or false; received ${value}`);
};

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
    const [inputArgument, outputArgument, powerSyncWorkerArgument, memoryWriteAheadWorkerArgument] =
        process.argv.slice(2);
    if (!inputArgument || !outputArgument || !powerSyncWorkerArgument || !memoryWriteAheadWorkerArgument) {
        throw new Error(
            'Usage: pnpm benchmark:publish-result <raw-result.json> <public-result.json> <powersync-worker> <mwa-worker>'
        );
    }

    await publishBenchmarkResultFile(inputArgument, outputArgument, {
        memoryWriteAheadUseWebWorker: parseBoolean(memoryWriteAheadWorkerArgument, 'mwa-worker'),
        powerSyncUseWebWorker: parseBoolean(powerSyncWorkerArgument, 'powersync-worker'),
    });
}
