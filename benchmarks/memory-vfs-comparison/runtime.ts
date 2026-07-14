import { TemporaryStorageOption, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';

import { createMemoryWriteAheadSharedRuntime, resetMemoryWriteAheadSharedRuntime } from '../../src/index.js';
import { createMemoryWriteAheadBenchmarkDatabase } from './mwaConnection.js';
import { runMemoryDatabaseStackComparisonBenchmark, type MemoryDatabaseStackBenchmarkRuntime } from './runner.js';

const CACHE_SIZE_KIB = 32 * 1024;

type BenchmarkFlags = {
    memoryWriteAheadUseWebWorker: boolean;
    powerSyncUseWebWorker: boolean;
};

type BenchmarkVersions = MemoryDatabaseStackBenchmarkRuntime['versions'];

export const runPublicMemoryVfsBenchmark = (flags: BenchmarkFlags, versions: BenchmarkVersions) => {
    const workerUrl = new URL('./mwaWorker.ts', import.meta.url).toString();

    return runMemoryDatabaseStackComparisonBenchmark({
        cacheSizeKiB: CACHE_SIZE_KIB,
        createInMemoryDatabase: ({ dbFilename }) =>
            new WASQLiteOpenFactory({
                cacheSizeKb: CACHE_SIZE_KIB,
                dbFilename,
                debugMode: false,
                flags: {
                    enableMultiTabs: false,
                    useWebWorker: flags.powerSyncUseWebWorker,
                },
                temporaryStorage: TemporaryStorageOption.MEMORY,
                vfs: WASQLiteVFS.InMemoryVfs,
            }).openDB(),
        createMemoryWriteAheadDatabase: ({ additionalReaders, dbFilename }) =>
            createMemoryWriteAheadBenchmarkDatabase({
                additionalReaders,
                cacheSizeKiB: CACHE_SIZE_KIB,
                dbFilename,
                runtime: createMemoryWriteAheadSharedRuntime(dbFilename),
                useWebWorker: flags.memoryWriteAheadUseWebWorker,
                workerUrl,
            }),
        harness: {
            memoryWriteAheadUseWebWorker: flags.memoryWriteAheadUseWebWorker,
            powerSyncUseWebWorker: flags.powerSyncUseWebWorker,
            webServer: 'vite-development',
        },
        onProgress: (message) => console.info(`[memory-vfs-benchmark] ${message}`),
        resetMemoryWriteAheadRuntime: () => resetMemoryWriteAheadSharedRuntime(),
        versions,
        workerUrl,
    });
};
