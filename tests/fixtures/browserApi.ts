import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';

import {
    MEMORY_WRITE_AHEAD_VFS,
    MemoryWriteAheadVFS,
    createMemoryWriteAheadSharedRuntime,
    getMemoryWriteAheadRuntimeDiagnostics,
    normalizeMemoryWriteAheadPathname,
    resolveMemoryWriteAheadRuntimeOptions,
    type MemoryWriteAheadRuntimeOptions,
    type MemoryWriteAheadSharedRuntime,
} from '../../src/index.js';
import {
    acquireMemoryWriteAheadFileLock,
    recoverAbandonedMemoryWriteAheadFileLock,
    releaseMemoryWriteAheadFileLock,
} from '../../src/MemoryWriteAheadVFS.js';
import {
    MEMORY_WRITE_AHEAD_FILE_META,
    MEMORY_WRITE_AHEAD_OWNER_LEASE_META,
    MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT,
    MEMORY_WRITE_AHEAD_RUNTIME_META,
    getMemoryWriteAheadFile,
    getMemoryWriteAheadLockClockMs,
    getMemoryWriteAheadRuntimeOwnerSlotOffset,
    releaseMemoryWriteAheadRuntimeHandle,
    retainMemoryWriteAheadRuntimeHandle,
    truncateMemoryWriteAheadFile,
    writeMemoryWriteAheadFile,
} from '../../src/memoryWriteAheadSharedRuntime.js';
import {
    type BrowserSqliteConnection,
    openMemoryWriteAheadDatabase,
    withMemoryWriteAheadDatabase,
} from './sqliteHarness.js';
export { runReadmeQuickstart } from './readmeQuickstart.js';

const nextDbFilename = (label: string) => `/memory-write-ahead-${label}-${crypto.randomUUID()}.sqlite`;

const resetRuntime = (dbFilename: string) => MemoryWriteAheadVFS.resetRuntime(dbFilename);

const ensureCrossOriginIsolated = () => {
    if (!crossOriginIsolated) {
        throw new Error('MemoryWriteAheadVFS browser tests require a cross-origin isolated test page');
    }
};

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const waitForRowsLength = async (readRows: () => Promise<unknown[]>, expectedLength: number) => {
    const deadline = performance.now() + 5_000;
    let rows = await readRows();

    while (rows.length !== expectedLength && performance.now() < deadline) {
        await wait(10);
        rows = await readRows();
    }

    if (rows.length !== expectedLength) {
        throw new Error(`Expected ${expectedLength} rows, received ${rows.length}: ${JSON.stringify(rows)}`);
    }

    return rows;
};

const waitForOpenHandleCount = async (dbFilename: string, expectedCount: number) => {
    const deadline = performance.now() + 5_000;
    let diagnostics = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);

    while (diagnostics?.openHandleCount !== expectedCount && performance.now() < deadline) {
        await wait(10);
        diagnostics = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);
    }

    if (diagnostics?.openHandleCount !== expectedCount) {
        throw new Error(
            `Expected ${expectedCount} open MemoryWriteAhead handles for ${dbFilename}; diagnostics=${JSON.stringify(
                diagnostics
            )}`
        );
    }

    return diagnostics;
};

const captureErrorMessage = async (operation: () => Promise<unknown> | unknown) => {
    try {
        await operation();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }

    throw new Error('Expected operation to throw');
};

const serializeLogArgument = (value: unknown): string => {
    if (value instanceof Error) {
        return value.message;
    }

    if (typeof value === 'object' && value !== null && 'error' in value) {
        const record = value as Record<string, unknown>;
        const error = record.error;
        return JSON.stringify({
            ...record,
            error: error instanceof Error ? error.message : error,
        });
    }

    return typeof value === 'string' ? value : JSON.stringify(value);
};

const firstCell = (rows: unknown[][]) => rows[0]?.[0];

const firstNumber = (rows: unknown[][]) => Number(firstCell(rows));

const diagnosticsFor = (dbFilename: string) => {
    const diagnostics = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);
    if (!diagnostics) {
        throw new Error(`Missing MemoryWriteAhead diagnostics for ${dbFilename}`);
    }

    return diagnostics;
};

const fileDiagnosticsFor = (dbFilename: string, pathname: string) => {
    const file = diagnosticsFor(dbFilename).files.find((entry) => entry.pathname === pathname);
    if (!file) {
        throw new Error(`Missing MemoryWriteAhead diagnostics for ${pathname}`);
    }

    return file;
};

const createFileMetaView = () =>
    new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * Object.keys(MEMORY_WRITE_AHEAD_FILE_META).length)
    );

export const runRuntimeOptionValidation = () => {
    ensureCrossOriginIsolated();

    const validOptions = resolveMemoryWriteAheadRuntimeOptions({
        initialDatabaseCapacityBytes: 4096,
        maxDatabaseCapacityBytes: 8192,
        initialWriteAheadCapacityBytes: 4096,
        maxWriteAheadCapacityBytes: 8192,
        fileLockStaleMs: 250,
    });
    const errors = [
        () => resolveMemoryWriteAheadRuntimeOptions({ initialDatabaseCapacityBytes: 0 }),
        () => resolveMemoryWriteAheadRuntimeOptions({ maxDatabaseCapacityBytes: 1.5 }),
        () =>
            resolveMemoryWriteAheadRuntimeOptions({
                initialDatabaseCapacityBytes: 8192,
                maxDatabaseCapacityBytes: 4096,
            }),
        () => resolveMemoryWriteAheadRuntimeOptions({ maxWriteAheadCapacityBytes: 2_147_483_648 }),
    ].map((operation) => {
        try {
            operation();
            return 'missing error';
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    });

    return {
        errors,
        normalizedAbsolute: normalizeMemoryWriteAheadPathname('/tmp/app.sqlite'),
        normalizedRelative: normalizeMemoryWriteAheadPathname('relative.sqlite'),
        validOptions,
    };
};

export const runRuntimeLifecycle = async () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('lifecycle');
    const runtimeOptions = {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 512 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 512 * 1024,
        fileLockStaleMs: 250,
    } satisfies MemoryWriteAheadRuntimeOptions;
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, runtimeOptions);

    try {
        const reusedRuntime = createMemoryWriteAheadSharedRuntime(dbFilename, runtimeOptions);
        const incompatibleReuseMessage = await captureErrorMessage(() =>
            createMemoryWriteAheadSharedRuntime(dbFilename, {
                ...runtimeOptions,
                maxDatabaseCapacityBytes: 1024 * 1024,
            })
        );
        const initialDiagnostics = diagnosticsFor(dbFilename);
        const connection = await openMemoryWriteAheadDatabase(dbFilename, runtime);

        try {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('CREATE TABLE lifecycle_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
            await connection.exec("INSERT INTO lifecycle_rows (value) VALUES ('open')");
            const openDiagnostics = diagnosticsFor(dbFilename);
            const resetWhileOpenMessage = await captureErrorMessage(() => resetRuntime(dbFilename));

            return {
                fileCount: initialDiagnostics.files.length,
                initialOpenHandleCount: initialDiagnostics.openHandleCount,
                openActiveOwnerLeaseCount: openDiagnostics.activeOwnerLeaseCount,
                openHandleCount: openDiagnostics.openHandleCount,
                incompatibleReuseMessage,
                resetWhileOpenMessage,
                reusedSameRuntime: reusedRuntime === runtime,
            };
        } finally {
            await connection.close();
            await waitForOpenHandleCount(dbFilename, 0);
            resetRuntime(dbFilename);
        }
    } catch (error) {
        await waitForOpenHandleCount(dbFilename, 0).catch(() => undefined);
        resetRuntime(dbFilename);
        throw error;
    }
};

export const runWalRoundTrip = async () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('wal');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 32 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });

    try {
        await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
            await connection.exec("INSERT INTO rows (value) VALUES ('alpha'), ('beta')");
        });

        return await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            const result = await connection.exec('SELECT value FROM rows ORDER BY id');
            const diagnostics = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);

            return {
                rows: result.rows.map(([value]) => value),
                fileCount: diagnostics?.files.length ?? 0,
                vfs: 'MemoryWriteAheadVFS',
            };
        });
    } finally {
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

export const runSegmentGrowthAndCheckpointReclaim = async () => {
    const dbFilename = nextDbFilename('segments');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 32 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 8 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });

    try {
        return await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('PRAGMA wal_autocheckpoint=0');
            await connection.exec('PRAGMA journal_size_limit=4096');
            await connection.exec('CREATE TABLE segment_rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
            await connection.exec('BEGIN IMMEDIATE');
            try {
                await Array.from({ length: 40 }, (_, index) => index + 1).reduce(
                    (previous, id) =>
                        previous.then(async () => {
                            await connection.exec(
                                `INSERT INTO segment_rows (id, payload) VALUES (${id}, randomblob(2048))`
                            );
                        }),
                    Promise.resolve()
                );
                await connection.exec('COMMIT');
            } catch (error) {
                await connection.exec('ROLLBACK').catch(() => undefined);
                throw error;
            }

            const beforeCheckpoint = diagnosticsFor(dbFilename);
            await connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            const afterCheckpoint = diagnosticsFor(dbFilename);
            const summary = await connection.exec(
                'SELECT COUNT(*) AS count, SUM(LENGTH(payload)) AS payload_bytes FROM segment_rows'
            );
            const [count = 0, payloadBytes = 0] = summary.rows[0] ?? [];
            const writeAheadFilesBefore = beforeCheckpoint.files.filter(
                (file) => file.pathname.endsWith('-wa0') || file.pathname.endsWith('-wa1')
            );
            const writeAheadFilesAfter = afterCheckpoint.files.filter(
                (file) => file.pathname.endsWith('-wa0') || file.pathname.endsWith('-wa1')
            );
            const databaseFileAfter = afterCheckpoint.files.find((file) => file.pathname === dbFilename);

            return {
                count,
                databaseSegmentCountAfterCheckpoint: databaseFileAfter?.segmentCount ?? 0,
                payloadBytes,
                writeAheadLogicalSizeBeforeCheckpoint: writeAheadFilesBefore.reduce(
                    (sum, file) => sum + file.logicalSizeBytes,
                    0
                ),
                writeAheadSegmentCountAfterCheckpoint: writeAheadFilesAfter.reduce(
                    (sum, file) => sum + file.segmentCount,
                    0
                ),
                writeAheadExpandedBeforeCheckpoint: writeAheadFilesBefore.some((file) => file.segmentCount > 1),
            };
        });
    } finally {
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

export const runSegmentReclaimAccounting = () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('reclaim-accounting');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 96 * 1024,
        initialWriteAheadCapacityBytes: 64 * 1024,
        maxWriteAheadCapacityBytes: 96 * 1024,
    });
    const file = getMemoryWriteAheadFile(runtime, dbFilename);
    if (!file) {
        throw new Error(`Missing MemoryWriteAhead file for ${dbFilename}`);
    }

    try {
        writeMemoryWriteAheadFile(file, new Uint8Array(96 * 1024), 0);
        const before = fileDiagnosticsFor(dbFilename, dbFilename);
        truncateMemoryWriteAheadFile(file, 1);
        const after = fileDiagnosticsFor(dbFilename, dbFilename);

        return {
            activeSegmentsAfterTruncate: after.segmentCount,
            allocatedBytesBeforeTruncate: before.allocatedCapacityBytes,
            reclaimedBytes: after.reclaimedBytes,
            reclaimedSegmentCount: after.reclaimedSegmentCount,
            secondSegmentBytes: before.allocatedCapacityBytes - before.segmentCapacityBytes,
        };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runSegmentReclaimAccountingSaturation = () => {
    ensureCrossOriginIsolated();

    const maxInt32Counter = 0x7fffffff;
    const dbFilename = nextDbFilename('reclaim-accounting-saturation');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 96 * 1024,
        initialWriteAheadCapacityBytes: 64 * 1024,
        maxWriteAheadCapacityBytes: 96 * 1024,
    });
    const file = getMemoryWriteAheadFile(runtime, dbFilename);
    if (!file) {
        throw new Error(`Missing MemoryWriteAhead file for ${dbFilename}`);
    }

    try {
        writeMemoryWriteAheadFile(file, new Uint8Array(96 * 1024), 0);
        const meta = new Int32Array(file.meta);
        Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedBytes, maxInt32Counter - 1);
        Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedSegmentCount, maxInt32Counter - 1);
        truncateMemoryWriteAheadFile(file, 1);
        const after = fileDiagnosticsFor(dbFilename, dbFilename);

        return {
            reclaimedBytes: after.reclaimedBytes,
            reclaimedSegmentCount: after.reclaimedSegmentCount,
        };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runOwnerLeaseClaimRecovery = () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('lease-claim');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const runtimeMeta = new Int32Array(runtime.registryMeta);
    const leaseIndex = (slotIndex: number, field: number) =>
        getMemoryWriteAheadRuntimeOwnerSlotOffset(slotIndex) + field;

    try {
        // A fresh leftover heartbeat (racing clear or a zombie owner's late heartbeat write) must be skipped.
        Atomics.store(
            runtimeMeta,
            leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs),
            getMemoryWriteAheadLockClockMs()
        );
        retainMemoryWriteAheadRuntimeHandle(runtime);
        const freshSlotZeroOwnerId = Atomics.load(
            runtimeMeta,
            leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)
        );
        const freshSlotOneOwnerId = Atomics.load(
            runtimeMeta,
            leaseIndex(1, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)
        );
        releaseMemoryWriteAheadRuntimeHandle(runtime);
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs), 0);

        // A release interrupted mid-clear strands ownerId 0 with stale leftovers; claiming must reclaim it.
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount), 2);
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs), 1);
        retainMemoryWriteAheadRuntimeHandle(runtime);
        const staleSlotZeroOwnerId = Atomics.load(
            runtimeMeta,
            leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)
        );
        const staleSlotZeroHandleCount = Atomics.load(
            runtimeMeta,
            leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount)
        );
        releaseMemoryWriteAheadRuntimeHandle(runtime);

        return {
            freshSlotOneOwnerId,
            freshSlotZeroOwnerId,
            slotZeroHeartbeatAfterRelease: Atomics.load(
                runtimeMeta,
                leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs)
            ),
            slotZeroOwnerIdAfterRelease: Atomics.load(
                runtimeMeta,
                leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)
            ),
            staleSlotZeroHandleCount,
            staleSlotZeroOwnerId,
        };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runStaleOwnedLeaseSlotPreservation = () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('lease-stale-owned');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const runtimeMeta = new Int32Array(runtime.registryMeta);
    const leaseIndex = (slotIndex: number, field: number) =>
        getMemoryWriteAheadRuntimeOwnerSlotOffset(slotIndex) + field;
    const deadOwnerId = 424242;
    const staleHeartbeatMs = 1;

    try {
        // A dead owner's slot: ownerId still set, handles outstanding, heartbeat stale enough for recovery.
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId), deadOwnerId);
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount), 2);
        Atomics.store(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs), staleHeartbeatMs);

        retainMemoryWriteAheadRuntimeHandle(runtime);
        const slotZeroOwnerId = Atomics.load(runtimeMeta, leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId));
        const slotZeroHeartbeatMs = Atomics.load(
            runtimeMeta,
            leaseIndex(0, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs)
        );
        const slotOneOwnerId = Atomics.load(runtimeMeta, leaseIndex(1, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId));
        releaseMemoryWriteAheadRuntimeHandle(runtime);

        return { deadOwnerId, slotOneOwnerId, slotZeroHeartbeatMs, slotZeroOwnerId, staleHeartbeatMs };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runOwnerLeaseExhaustionRecovery = () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('lease-exhaustion');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const runtimeMeta = new Int32Array(runtime.registryMeta);
    const leaseIndex = (slotIndex: number, field: number) =>
        getMemoryWriteAheadRuntimeOwnerSlotOffset(slotIndex) + field;
    const staleHeartbeatMs = 1;

    try {
        // Every slot held by a distinct dead owner with one outstanding handle and a stale heartbeat.
        for (let slotIndex = 0; slotIndex < MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT; slotIndex += 1) {
            Atomics.store(
                runtimeMeta,
                leaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId),
                1000 + slotIndex
            );
            Atomics.store(runtimeMeta, leaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount), 1);
            Atomics.store(
                runtimeMeta,
                leaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs),
                staleHeartbeatMs
            );
        }
        Atomics.store(
            runtimeMeta,
            MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount,
            MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT
        );

        const claimedOwnerId = retainMemoryWriteAheadRuntimeHandle(runtime);
        const diagnostics = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);
        releaseMemoryWriteAheadRuntimeHandle(runtime);

        return {
            activeOwnerLeaseCount: diagnostics?.activeOwnerLeaseCount ?? null,
            claimedOwnerId,
            openHandleCount: diagnostics?.openHandleCount ?? null,
            recoveredAbandonedHandleCount: diagnostics?.recoveredAbandonedHandleCount ?? null,
            slotCount: MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT,
        };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runFileLockRegression = () => {
    ensureCrossOriginIsolated();

    const staleMs = 1;
    const staleHeartbeatMs = 1;
    const firstOwnerId = 101;
    const secondOwnerId = 202;
    const recoveredOwnerId = 303;
    const view = createFileMetaView();

    acquireMemoryWriteAheadFileLock(view, firstOwnerId, staleMs);
    const acquiredLockState = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    const acquiredLockOwner = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner);
    releaseMemoryWriteAheadFileLock(view, firstOwnerId);
    const releasedLockState = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);

    acquireMemoryWriteAheadFileLock(view, secondOwnerId, staleMs);
    releaseMemoryWriteAheadFileLock(view, firstOwnerId);
    const lockStateAfterStaleOwnerRelease = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    releaseMemoryWriteAheadFileLock(view, secondOwnerId);

    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lock, recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner, recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs, staleHeartbeatMs);
    const recoveredHeldLock = recoverAbandonedMemoryWriteAheadFileLock(view, staleMs);
    const lockStateAfterHeldRecovery = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    const secondRecoveryAttempt = recoverAbandonedMemoryWriteAheadFileLock(view, staleMs);
    const lockStateAfterSecondRecoveryAttempt = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);

    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lock, -recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner, recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs, 0);
    const recoveredInterruptedRecovery = recoverAbandonedMemoryWriteAheadFileLock(view, staleMs);
    const lockStateAfterInterruptedRecovery = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);

    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lock, -recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner, recoveredOwnerId);
    Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs, 0);
    acquireMemoryWriteAheadFileLock(view, secondOwnerId, staleMs);
    const lockStateAfterAcquireRecoveredNegative = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    releaseMemoryWriteAheadFileLock(view, secondOwnerId);

    return {
        acquiredLockOwner,
        acquiredLockState,
        lockStateAfterAcquireRecoveredNegative,
        lockStateAfterHeldRecovery,
        lockStateAfterInterruptedRecovery,
        lockStateAfterSecondRecoveryAttempt,
        lockStateAfterStaleOwnerRelease,
        recoveredHeldLock,
        recoveredInterruptedRecovery,
        releasedLockState,
        secondRecoveryAttempt,
    };
};

type FileLockWorkerResponse =
    | { ok: true; lockState: number; mode: 'acquire' | 'hold'; ownerId: number }
    | { ok: false; message: string; stack?: string };

const waitForFileLockWorker = (worker: Worker, timeoutMs: number) =>
    new Promise<FileLockWorkerResponse>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('file lock worker timed out')), timeoutMs);
        worker.onmessage = (event: MessageEvent<FileLockWorkerResponse>) => {
            window.clearTimeout(timeout);
            resolve(event.data);
        };
        worker.onerror = (event) => {
            window.clearTimeout(timeout);
            reject(new Error(event.message));
        };
    });

export const runAbandonedFileLockWorkerRecovery = async () => {
    ensureCrossOriginIsolated();

    const view = createFileMetaView();
    const staleMs = 100;
    const holderOwnerId = 707;
    const waiterOwnerId = 808;
    const holder = new Worker(new URL('./fileLockWorker.ts', import.meta.url), { type: 'module' });
    const waiter = new Worker(new URL('./fileLockWorker.ts', import.meta.url), { type: 'module' });

    try {
        const holderReady = waitForFileLockWorker(holder, 2_000);
        holder.postMessage({
            meta: view.buffer,
            mode: 'hold',
            ownerId: holderOwnerId,
            staleMs,
        });
        const held = await holderReady;
        if (!held.ok) {
            throw new Error(`${held.message}\n${held.stack ?? ''}`);
        }

        holder.terminate();

        const waiterReady = waitForFileLockWorker(waiter, 2_000);
        waiter.postMessage({
            meta: view.buffer,
            mode: 'acquire',
            ownerId: waiterOwnerId,
            staleMs,
        });
        const acquired = await waiterReady;
        if (!acquired.ok) {
            throw new Error(`${acquired.message}\n${acquired.stack ?? ''}`);
        }

        return {
            acquiredLockState: acquired.lockState,
            finalLockState: Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock),
            heldLockState: held.lockState,
            recoveredAbandonedLockCount: Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.recoveredAbandonedLockCount),
        };
    } finally {
        holder.terminate();
        waiter.terminate();
    }
};

export const runSameVfsConnectionExpectation = async () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('same-vfs');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });
    const module = await waSqliteModuleFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);
    sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
    const firstDb = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
    let secondDb: number | null = null;

    try {
        await sqlite3.exec(firstDb, 'PRAGMA journal_mode=WAL');
        await sqlite3.exec(firstDb, 'CREATE TABLE same_vfs_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        await sqlite3.exec(firstDb, "INSERT INTO same_vfs_rows (value) VALUES ('first')");

        const secondOpenMessage = await captureErrorMessage(async () => {
            secondDb = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
        });

        await sqlite3.exec(firstDb, "INSERT INTO same_vfs_rows (value) VALUES ('after-rejected-second-open')");
        const rows: unknown[] = [];
        await sqlite3.exec(firstDb, 'SELECT value FROM same_vfs_rows ORDER BY id', (row: unknown[]) => {
            rows.push(row[0]);
        });

        return {
            lastVfsError: vfs.lastError?.message ?? null,
            rows,
            secondOpenMessage,
        };
    } finally {
        if (secondDb !== null) {
            await sqlite3.close(secondDb).catch(() => undefined);
        }
        await sqlite3.close(firstDb).catch(() => undefined);
        await waitForOpenHandleCount(dbFilename, 0).catch(() => undefined);
        resetRuntime(dbFilename);
    }
};

export const runSameVfsSequentialReopen = async () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('same-vfs-reopen');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });
    const module = await waSqliteModuleFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);
    sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);

    try {
        const firstDb = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
        await sqlite3.exec(firstDb, 'PRAGMA journal_mode=WAL');
        await sqlite3.exec(firstDb, 'CREATE TABLE sequential_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        await sqlite3.exec(firstDb, "INSERT INTO sequential_rows (value) VALUES ('first-open')");
        await sqlite3.close(firstDb);

        const secondDb = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
        try {
            await sqlite3.exec(secondDb, "INSERT INTO sequential_rows (value) VALUES ('second-open')");
            const rows: unknown[] = [];
            await sqlite3.exec(secondDb, 'SELECT value FROM sequential_rows ORDER BY id', (row: unknown[]) => {
                rows.push(row[0]);
            });

            return {
                rows,
            };
        } finally {
            await sqlite3.close(secondDb);
        }
    } finally {
        await waitForOpenHandleCount(dbFilename, 0).catch(() => undefined);
        resetRuntime(dbFilename);
    }
};

export const runDuplicatePendingOpenRejection = async () => {
    ensureCrossOriginIsolated();

    const dbFilename = nextDbFilename('duplicate-pending-open');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });

    try {
        // Drives jOpen directly: hitting the pending window through sqlite3_open would need two
        // connections racing into one VFS instance mid-#retryOpen, which wa-sqlite cannot schedule.
        const module = { retryOps: [] as Promise<unknown>[] };
        const vfs = new MemoryWriteAheadVFS(MEMORY_WRITE_AHEAD_VFS, module, runtime);
        const openFlags = VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_CREATE | VFS.SQLITE_OPEN_READWRITE;
        const pOutFlags = new DataView(new ArrayBuffer(4));

        const firstOpen = vfs.jOpen(dbFilename, 1, openFlags, pOutFlags);
        const duplicateOpen = vfs.jOpen(dbFilename, 2, openFlags, pOutFlags);
        const duplicateOpenError = vfs.lastError?.message ?? null;
        await Promise.all(module.retryOps);
        const retriedFirstOpen = vfs.jOpen(dbFilename, 1, openFlags, pOutFlags);
        const closedFirstOpen = vfs.jClose(1);

        return {
            firstOpen,
            duplicateOpen,
            duplicateOpenError,
            retriedFirstOpen,
            closedFirstOpen,
            openHandleCount: diagnosticsFor(dbFilename).openHandleCount,
        };
    } finally {
        resetRuntime(dbFilename);
    }
};

export const runCapacityExceededFailure = async () => {
    const dbFilename = nextDbFilename('capacity');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 32 * 1024,
        maxDatabaseCapacityBytes: 512 * 1024,
        initialWriteAheadCapacityBytes: 8 * 1024,
        maxWriteAheadCapacityBytes: 64 * 1024,
    });
    const errorLogs: string[] = [];

    try {
        return await withMemoryWriteAheadDatabase(
            dbFilename,
            runtime,
            async (connection) => {
                await connection.exec('PRAGMA journal_mode=WAL');
                await connection.exec('PRAGMA wal_autocheckpoint=0');
                await connection.exec('CREATE TABLE capacity_rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
                const overflowMessage = await captureErrorMessage(() =>
                    connection.exec('INSERT INTO capacity_rows (payload) VALUES (randomblob(256 * 1024))')
                );
                const diagnostics = diagnosticsFor(dbFilename);

                return {
                    errorLogs,
                    maxWriteAheadCapacityBytes: diagnostics.capacities.maxWriteAheadCapacityBytes,
                    overflowMessage,
                };
            },
            {
                logger: {
                    error: (...args: unknown[]) => {
                        errorLogs.push(args.map(serializeLogArgument).join(' '));
                    },
                },
            }
        );
    } finally {
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

export const runSnapshotIsolation = async () => {
    const dbFilename = nextDbFilename('snapshot');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const connections: BrowserSqliteConnection[] = [];

    try {
        const writer = await openMemoryWriteAheadDatabase(dbFilename, runtime);
        connections.push(writer);
        const reader = await openMemoryWriteAheadDatabase(dbFilename, runtime);
        connections.push(reader);

        await writer.exec('PRAGMA journal_mode=WAL');
        await writer.exec('CREATE TABLE snapshot_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        await writer.exec("INSERT INTO snapshot_rows (value) VALUES ('before')");
        await waitForRowsLength(async () => {
            const result = await reader.exec('SELECT value FROM snapshot_rows ORDER BY id');
            return result.rows.map(([value]) => value);
        }, 1);
        await reader.exec('BEGIN');
        const before = await reader.exec('SELECT value FROM snapshot_rows ORDER BY id');

        await writer.exec('BEGIN IMMEDIATE');
        await writer.exec("INSERT INTO snapshot_rows (value) VALUES ('during-1'), ('during-2')");
        const during = await reader.exec('SELECT value FROM snapshot_rows ORDER BY id');
        await writer.exec('COMMIT');
        await reader.exec('COMMIT');
        const after = await waitForRowsLength(async () => {
            const result = await reader.exec('SELECT value FROM snapshot_rows ORDER BY id');
            return result.rows.map(([value]) => value);
        }, 3);

        return {
            after,
            before: before.rows.map(([value]) => value),
            during: during.rows.map(([value]) => value),
        };
    } finally {
        await Promise.all(connections.map((connection) => connection.close()));
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

export const runRollbackAndPragmaBehavior = async () => {
    const dbFilename = nextDbFilename('rollback');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 2 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 2 * 1024 * 1024,
    });

    try {
        return await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            const journalMode = await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('PRAGMA busy_timeout=2500');
            const busyTimeout = await connection.exec('PRAGMA busy_timeout');
            await connection.exec('PRAGMA lazy_lock=none');
            const lazyLockNone = await connection.exec('PRAGMA lazy_lock');
            await connection.exec('PRAGMA lazy_lock=readwrite');
            const lazyLockReadWrite = await connection.exec('PRAGMA lazy_lock');
            await connection.exec('PRAGMA wal_autocheckpoint=0');
            await connection.exec('PRAGMA journal_size_limit=4096');
            const journalSizeLimit = await connection.exec('PRAGMA journal_size_limit');
            await connection.exec('PRAGMA backstop_interval=75');
            const backstopInterval = await connection.exec('PRAGMA backstop_interval');

            await connection.exec('CREATE TABLE rollback_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)');
            await connection.exec("INSERT INTO rollback_rows (value) VALUES ('committed')");
            await connection.exec('BEGIN IMMEDIATE');
            try {
                await connection.exec("INSERT INTO rollback_rows (value) VALUES ('rolled-back')");
                await connection.exec('ROLLBACK');
            } catch (error) {
                await connection.exec('ROLLBACK').catch(() => undefined);
                throw error;
            }
            await connection.exec("INSERT INTO rollback_rows (value) VALUES ('after-rollback')");
            const rows = await connection.exec('SELECT value FROM rollback_rows ORDER BY id');

            return {
                backstopInterval: firstNumber(backstopInterval.rows),
                busyTimeout: firstNumber(busyTimeout.rows),
                journalMode: firstCell(journalMode.rows),
                journalSizeLimit: firstNumber(journalSizeLimit.rows),
                lazyLockNone: firstCell(lazyLockNone.rows),
                lazyLockReadWrite: firstCell(lazyLockReadWrite.rows),
                rows: rows.rows.map(([value]) => value),
            };
        });
    } finally {
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

type WorkerResponse =
    | { id: number; ok: true; insertedRows: number }
    | { id: number; ok: false; message: string; stack?: string };

const runWriterWorker = ({
    dbFilename,
    id,
    rowsPerTransaction,
    runtime,
    transactions,
    writerId,
}: {
    dbFilename: string;
    id: number;
    rowsPerTransaction: number;
    runtime: MemoryWriteAheadSharedRuntime;
    transactions: number;
    writerId: number;
}) =>
    new Promise<WorkerResponse>((resolve, reject) => {
        const worker = new Worker(new URL('./sqliteWorker.ts', import.meta.url), { type: 'module' });
        let settled = false;
        const finish = (complete: () => void, terminateDelayMs = 0) => {
            if (settled) {
                return;
            }

            settled = true;
            window.clearTimeout(timeout);
            window.setTimeout(() => worker.terminate(), terminateDelayMs);
            complete();
        };
        const timeout = window.setTimeout(() => {
            finish(() => reject(new Error(`writer worker ${writerId} timed out`)));
        }, 20_000);

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            finish(() => resolve(event.data), 25);
        };
        worker.onerror = (event) => {
            finish(() => reject(new Error(event.message)));
        };
        worker.postMessage({ dbFilename, id, rowsPerTransaction, runtime, transactions, writerId });
    });

export const runWorkerConcurrency = async () => {
    const dbFilename = nextDbFilename('workers');
    const runtimeOptions = {
        initialDatabaseCapacityBytes: 128 * 1024,
        maxDatabaseCapacityBytes: 8 * 1024 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 8 * 1024 * 1024,
    } satisfies MemoryWriteAheadRuntimeOptions;
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, runtimeOptions);

    try {
        await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec(
                'CREATE TABLE worker_rows (id INTEGER PRIMARY KEY, writer_id INTEGER NOT NULL, sequence INTEGER NOT NULL, payload BLOB NOT NULL)'
            );
            await connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        });

        const writerCount = 3;
        const transactions = 4;
        const rowsPerTransaction = 5;
        const responses = await Promise.all(
            Array.from({ length: writerCount }, (_, writerId) =>
                runWriterWorker({
                    dbFilename,
                    id: writerId + 1,
                    rowsPerTransaction,
                    runtime,
                    transactions,
                    writerId,
                })
            )
        );
        const failed = responses.find((response) => !response.ok);
        if (failed && !failed.ok) {
            throw new Error(`${failed.message}\n${failed.stack ?? ''}`);
        }

        const result = await withMemoryWriteAheadDatabase(dbFilename, runtime, async (connection) => {
            const summary = await connection.exec(
                'SELECT COUNT(*) AS count, COUNT(DISTINCT writer_id) AS writer_count, SUM(LENGTH(payload)) AS payload_bytes FROM worker_rows'
            );
            const diagnosticsBeforeCheckpoint = getMemoryWriteAheadRuntimeDiagnostics(dbFilename);
            await connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            const [count = 0, writerCountResult = 0, payloadBytes = 0] = summary.rows[0] ?? [];

            return {
                count,
                payloadBytes,
                responses,
                segmentedWriteAheadBeforeCheckpoint:
                    diagnosticsBeforeCheckpoint?.files
                        .filter((file) => file.pathname.endsWith('-wa0') || file.pathname.endsWith('-wa1'))
                        .some((file) => file.segmentCount > 1) ?? false,
                writerCount: writerCountResult,
            };
        });
        const diagnosticsAfterClose = await waitForOpenHandleCount(dbFilename, 0);

        return {
            ...result,
            openHandleCountAfterClose: diagnosticsAfterClose.openHandleCount,
        };
    } finally {
        await waitForOpenHandleCount(dbFilename, 0);
        resetRuntime(dbFilename);
    }
};

type LeaseWorkerMessage = { ok: true } | { ok: false; message: string; stack?: string };

const waitForLeaseWorkerReady = (worker: Worker) =>
    new Promise<LeaseWorkerMessage>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('lease worker timed out')), 10_000);
        worker.onmessage = (event: MessageEvent<LeaseWorkerMessage>) => {
            window.clearTimeout(timeout);
            resolve(event.data);
        };
        worker.onerror = (event) => {
            window.clearTimeout(timeout);
            reject(new Error(event.message));
        };
    });

export const runAbandonedWorkerLeaseRecovery = async () => {
    const dbFilename = nextDbFilename('lease');
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename, {
        initialDatabaseCapacityBytes: 64 * 1024,
        maxDatabaseCapacityBytes: 512 * 1024,
        initialWriteAheadCapacityBytes: 16 * 1024,
        maxWriteAheadCapacityBytes: 512 * 1024,
        fileLockStaleMs: 100,
    });
    const worker = new Worker(new URL('./leaseWorker.ts', import.meta.url), { type: 'module' });

    try {
        const readyPromise = waitForLeaseWorkerReady(worker);
        worker.postMessage({ dbFilename, runtime });
        const ready = await readyPromise;
        if (!ready.ok) {
            throw new Error(`${ready.message}\n${ready.stack ?? ''}`);
        }

        const beforeTerminate = await waitForOpenHandleCount(dbFilename, 3);
        worker.terminate();
        await wait(350);
        resetRuntime(dbFilename);

        return {
            activeOwnerLeaseCountBeforeTerminate: beforeTerminate.activeOwnerLeaseCount,
            diagnosticsAfterReset: getMemoryWriteAheadRuntimeDiagnostics(dbFilename),
            openHandleCountBeforeTerminate: beforeTerminate.openHandleCount,
        };
    } finally {
        worker.terminate();
        if (getMemoryWriteAheadRuntimeDiagnostics(dbFilename)) {
            await waitForOpenHandleCount(dbFilename, 0).catch(() => undefined);
            resetRuntime(dbFilename);
        }
    }
};

export const runMultipleRuntimeIsolation = async () => {
    const firstDbFilename = nextDbFilename('isolation-a');
    const secondDbFilename = nextDbFilename('isolation-b');
    const firstRuntime = createMemoryWriteAheadSharedRuntime(firstDbFilename);
    const secondRuntime = createMemoryWriteAheadSharedRuntime(secondDbFilename);

    try {
        await withMemoryWriteAheadDatabase(firstDbFilename, firstRuntime, async (connection) => {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('CREATE TABLE isolated_rows (value TEXT NOT NULL)');
            await connection.exec("INSERT INTO isolated_rows (value) VALUES ('first')");
        });
        await withMemoryWriteAheadDatabase(secondDbFilename, secondRuntime, async (connection) => {
            await connection.exec('PRAGMA journal_mode=WAL');
            await connection.exec('CREATE TABLE isolated_rows (value TEXT NOT NULL)');
            await connection.exec("INSERT INTO isolated_rows (value) VALUES ('second')");
        });
        await waitForOpenHandleCount(firstDbFilename, 0);
        await waitForOpenHandleCount(secondDbFilename, 0);
        resetRuntime(firstDbFilename);

        return await withMemoryWriteAheadDatabase(secondDbFilename, secondRuntime, async (connection) => {
            const rows = await connection.exec('SELECT value FROM isolated_rows');
            return {
                firstDiagnosticsAfterReset: getMemoryWriteAheadRuntimeDiagnostics(firstDbFilename),
                secondDiagnosticsFileCount: diagnosticsFor(secondDbFilename).files.length,
                secondRows: rows.rows.map(([value]) => value),
            };
        });
    } finally {
        await waitForOpenHandleCount(secondDbFilename, 0).catch(() => undefined);
        resetRuntime(firstDbFilename);
        resetRuntime(secondDbFilename);
    }
};
