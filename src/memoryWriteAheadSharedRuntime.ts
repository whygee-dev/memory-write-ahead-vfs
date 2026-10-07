import { type MemoryWriteAheadLogger, noopMemoryWriteAheadLogger } from './logger.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const DEFAULT_INITIAL_DATABASE_CAPACITY_BYTES = 16 * MIB;
const DEFAULT_MAX_DATABASE_CAPACITY_BYTES = 1024 * MIB;
const DEFAULT_INITIAL_WRITE_AHEAD_CAPACITY_BYTES = 8 * MIB;
const DEFAULT_MAX_WRITE_AHEAD_CAPACITY_BYTES = 512 * MIB;
const DEFAULT_FILE_LOCK_STALE_MS = 30_000;
const LOCK_CLOCK_MODULO_MS = 0x7fffffff;
const MAX_INT32_ATOMIC_COUNTER = 0x7fffffff;
export const MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT = 32;
const MIN_SEGMENT_COUNT = 1;

const memoryWriteAheadRuntimeLogger = noopMemoryWriteAheadLogger;

export const MEMORY_WRITE_AHEAD_FILE_META = {
    lock: 0,
    size: 1,
    activeSegmentCount: 2,
    reclaimedSegmentCount: 3,
    reclaimedBytes: 4,
    lockOwner: 5,
    lockHeartbeatMs: 6,
    recoveredAbandonedLockCount: 7,
    peakLogicalSizeBytes: 8,
    peakCapacityBytes: 9,
    peakAllocatedCapacityBytes: 10,
    writeOperationCount: 11,
    writtenBytes: 12,
    truncateOperationCount: 13,
    lockWaitCount: 14,
    lockWaitMs: 15,
    checkpointCount: 16,
    checkpointMs: 17,
    checkpointWriteAheadPages: 18,
    lastCheckpointMs: 19,
    lastCheckpointWriteAheadPages: 20,
    transactionLock: 21,
    transactionLockRuntimeOwner: 22,
    abandonedTransaction: 23,
} as const;

export const MEMORY_WRITE_AHEAD_RUNTIME_META = {
    openHandleCount: 0,
    recoveredAbandonedHandleCount: 1,
} as const;

export const MEMORY_WRITE_AHEAD_OWNER_LEASE_META = {
    ownerId: 0,
    handleCount: 1,
    heartbeatMs: 2,
} as const;

const RUNTIME_META_HEADER_LENGTH = Object.keys(MEMORY_WRITE_AHEAD_RUNTIME_META).length;
const OWNER_LEASE_META_WIDTH = Object.keys(MEMORY_WRITE_AHEAD_OWNER_LEASE_META).length;

export type MemoryWriteAheadRuntimeOptions = {
    allowFixedCapacityFallback?: boolean;
    initialDatabaseCapacityBytes?: number;
    maxDatabaseCapacityBytes?: number;
    initialWriteAheadCapacityBytes?: number;
    maxWriteAheadCapacityBytes?: number;
    fileLockStaleMs?: number;
};

export type MemoryWriteAheadResolvedRuntimeOptions = {
    allowFixedCapacityFallback: boolean;
    initialDatabaseCapacityBytes: number;
    maxDatabaseCapacityBytes: number;
    initialWriteAheadCapacityBytes: number;
    maxWriteAheadCapacityBytes: number;
    fileLockStaleMs: number;
};

type GrowableSharedArrayBuffer = SharedArrayBuffer & {
    readonly maxByteLength: number;
    grow(byteLength: number): void;
};

type GrowableSharedArrayBufferConstructor = {
    new (byteLength: number, options: { maxByteLength: number }): SharedArrayBuffer;
};

export type MemoryWriteAheadSharedSegment =
    | {
          capacityMode: 'growable';
          data: GrowableSharedArrayBuffer;
          maxCapacityBytes: number;
      }
    | {
          capacityMode: 'fixed';
          data: SharedArrayBuffer;
          maxCapacityBytes: number;
      };

type MemoryWriteAheadSharedSegmentData =
    | {
          capacityMode: 'growable';
          data: GrowableSharedArrayBuffer;
      }
    | {
          capacityMode: 'fixed';
          data: SharedArrayBuffer;
      };

export type MemoryWriteAheadSharedFile = {
    dbFilename: string;
    maxCapacityBytes: number;
    meta: SharedArrayBuffer;
    pathname: string;
    segmentCapacityBytes: number;
    segments: MemoryWriteAheadSharedSegment[];
};

export type MemoryWriteAheadSharedRuntime = {
    capacities: MemoryWriteAheadResolvedRuntimeOptions;
    dbFilename: string;
    files: Record<string, MemoryWriteAheadSharedFile>;
    registryMeta: SharedArrayBuffer;
};

export type MemoryWriteAheadDatabaseFiles = {
    database: MemoryWriteAheadSharedFile;
    writeAhead: MemoryWriteAheadSharedFile[];
};

export type MemoryWriteAheadSharedFilesRegistration = {
    files: MemoryWriteAheadSharedFile[];
    runtimeDbFilename: string;
};

export type MemoryWriteAheadRuntimeDiagnostics = {
    activeOwnerLeaseCount: number;
    capacities: MemoryWriteAheadResolvedRuntimeOptions;
    dbFilename: string;
    files: {
        allocatedCapacityBytes: number;
        capacityBytes: number;
        currentCapacityBytes: number;
        logicalSizeBytes: number;
        maxCapacityBytes: number;
        pathname: string;
        reclaimedBytes: number;
        reclaimedSegmentCount: number;
        segmentCapacityBytes: number;
        segmentCount: number;
        totalSegmentCount: number;
        peakLogicalSizeBytes: number;
        peakCapacityBytes: number;
        peakAllocatedCapacityBytes: number;
        writeOperationCount: number;
        writtenBytes: number;
        truncateOperationCount: number;
        lockWaitCount: number;
        lockWaitMs: number;
        checkpointCount: number;
        checkpointMs: number;
        checkpointWriteAheadPages: number;
        lastCheckpointMs: number;
        lastCheckpointWriteAheadPages: number;
        lockState: number;
        lockOwner: number;
        lockHeartbeatAgeMs: number | null;
        recoveredAbandonedLockCount: number;
        abandonedTransaction: boolean;
        transactionLockRuntimeOwner: number;
        transactionLockState: number;
    }[];
    openHandleCount: number;
    recoveredAbandonedHandleCount: number;
    segmentedSharedArrayBuffers: boolean;
};

type MemoryWriteAheadGlobalScope = typeof globalThis & {
    __MEMORY_WRITE_AHEAD_VFS_RUNTIMES__?: Map<string, MemoryWriteAheadSharedRuntime>;
};

type LocalRuntimeLease = {
    handleCount: number;
    heartbeatIntervalId: ReturnType<typeof setInterval>;
    ownerId: number;
    runtimeDbFilename: string;
    slotIndex: number;
};

const localRuntimeLeases = new Map<string, LocalRuntimeLease>();

const assertPositiveInteger = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer; received ${value}`);
    }

    return value;
};

// File sizes and reclaim counters live in atomic Int32Array slots, so capacities above 2^31 - 1 would wrap.
const assertPositiveCapacityBytes = (value: number, label: string) => {
    const capacityBytes = assertPositiveInteger(value, label);

    if (capacityBytes > MAX_INT32_ATOMIC_COUNTER) {
        throw new Error(`${label} cannot exceed ${MAX_INT32_ATOMIC_COUNTER} bytes`);
    }

    return capacityBytes;
};

const createMemoryWriteAheadOwnerId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const values = crypto.getRandomValues(new Uint32Array(1));
        const value = values[0] ?? 0;
        return value & 0x3fffffff || 1;
    }

    return Math.floor(Math.random() * 0x3fffffff) + 1;
};

const formatRuntimeOptions = (options: MemoryWriteAheadResolvedRuntimeOptions) => JSON.stringify(options);

export const normalizeMemoryWriteAheadPathname = (filename: string | null | undefined) => {
    const url = new URL(filename ?? Math.random().toString(36).slice(2), 'file://');
    return url.pathname;
};

export const getMemoryWriteAheadLockClockMs = () => {
    const now = typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now();
    return Math.max(1, Math.trunc(now % LOCK_CLOCK_MODULO_MS));
};

export const getMemoryWriteAheadLockAgeMs = (heartbeatMs: number, nowMs = getMemoryWriteAheadLockClockMs()) => {
    if (heartbeatMs <= 0) {
        return null;
    }

    return nowMs >= heartbeatMs ? nowMs - heartbeatMs : nowMs + (LOCK_CLOCK_MODULO_MS - heartbeatMs);
};

export const resolveMemoryWriteAheadRuntimeOptions = (
    options: MemoryWriteAheadRuntimeOptions = {}
): MemoryWriteAheadResolvedRuntimeOptions => {
    const resolved = {
        allowFixedCapacityFallback: options.allowFixedCapacityFallback ?? false,
        initialDatabaseCapacityBytes: assertPositiveCapacityBytes(
            options.initialDatabaseCapacityBytes ?? DEFAULT_INITIAL_DATABASE_CAPACITY_BYTES,
            'initialDatabaseCapacityBytes'
        ),
        maxDatabaseCapacityBytes: assertPositiveCapacityBytes(
            options.maxDatabaseCapacityBytes ?? DEFAULT_MAX_DATABASE_CAPACITY_BYTES,
            'maxDatabaseCapacityBytes'
        ),
        initialWriteAheadCapacityBytes: assertPositiveCapacityBytes(
            options.initialWriteAheadCapacityBytes ?? DEFAULT_INITIAL_WRITE_AHEAD_CAPACITY_BYTES,
            'initialWriteAheadCapacityBytes'
        ),
        maxWriteAheadCapacityBytes: assertPositiveCapacityBytes(
            options.maxWriteAheadCapacityBytes ?? DEFAULT_MAX_WRITE_AHEAD_CAPACITY_BYTES,
            'maxWriteAheadCapacityBytes'
        ),
        fileLockStaleMs: assertPositiveInteger(
            options.fileLockStaleMs ?? DEFAULT_FILE_LOCK_STALE_MS,
            'fileLockStaleMs'
        ),
    } satisfies MemoryWriteAheadResolvedRuntimeOptions;

    if (resolved.initialDatabaseCapacityBytes > resolved.maxDatabaseCapacityBytes) {
        throw new Error('initialDatabaseCapacityBytes cannot exceed maxDatabaseCapacityBytes');
    }

    if (resolved.initialWriteAheadCapacityBytes > resolved.maxWriteAheadCapacityBytes) {
        throw new Error('initialWriteAheadCapacityBytes cannot exceed maxWriteAheadCapacityBytes');
    }

    return resolved;
};

const getRuntimeRegistry = () => {
    const scope = globalThis as MemoryWriteAheadGlobalScope;
    scope.__MEMORY_WRITE_AHEAD_VFS_RUNTIMES__ ??= new Map<string, MemoryWriteAheadSharedRuntime>();
    return scope.__MEMORY_WRITE_AHEAD_VFS_RUNTIMES__;
};

const getRuntimeMeta = (runtime: MemoryWriteAheadSharedRuntime) => new Int32Array(runtime.registryMeta);

export const getMemoryWriteAheadRuntimeOwnerSlotOffset = (slotIndex: number) =>
    RUNTIME_META_HEADER_LENGTH + slotIndex * OWNER_LEASE_META_WIDTH;

const getRuntimeOwnerLeaseIndex = (slotIndex: number, field: number) =>
    getMemoryWriteAheadRuntimeOwnerSlotOffset(slotIndex) + field;

const addSaturatingAtomicCounter = (view: Int32Array, index: number, delta: number) => {
    let current = Atomics.load(view, index);

    while (current < MAX_INT32_ATOMIC_COUNTER) {
        const next = current < 0 ? MAX_INT32_ATOMIC_COUNTER : Math.min(MAX_INT32_ATOMIC_COUNTER, current + delta);
        const previous = Atomics.compareExchange(view, index, current, next);

        if (previous === current) {
            return next;
        }

        current = previous;
    }

    return current;
};

const updateAtomicMaxCounter = (view: Int32Array, index: number, value: number) => {
    const nextValue = Math.max(0, Math.min(MAX_INT32_ATOMIC_COUNTER, Math.trunc(value)));
    let current = Atomics.load(view, index);

    while (current < nextValue) {
        const previous = Atomics.compareExchange(view, index, current, nextValue);

        if (previous === current) {
            return nextValue;
        }

        current = previous;
    }

    return current;
};

const getOwnerLeaseHeartbeatIntervalMs = (runtime: MemoryWriteAheadSharedRuntime) =>
    Math.max(50, Math.min(1_000, Math.trunc(runtime.capacities.fileLockStaleMs / 3)));

const getOpenHandleCount = (runtime: MemoryWriteAheadSharedRuntime) =>
    Atomics.load(getRuntimeMeta(runtime), MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount);

const getRecoveredAbandonedHandleCount = (runtime: MemoryWriteAheadSharedRuntime) =>
    Atomics.load(getRuntimeMeta(runtime), MEMORY_WRITE_AHEAD_RUNTIME_META.recoveredAbandonedHandleCount);

const countActiveOwnerLeases = (runtime: MemoryWriteAheadSharedRuntime) => {
    const runtimeMeta = getRuntimeMeta(runtime);

    return Array.from({ length: MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT }, (_, slotIndex) => slotIndex).reduce(
        (count, slotIndex) =>
            count +
            (Atomics.load(
                runtimeMeta,
                getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)
            ) > 0
                ? 1
                : 0),
        0
    );
};

// ownerId is cleared first so a clear interrupted by worker death strands the slot with ownerId 0 and a stale
// heartbeat — the one orphaned shape claimOwnerLeaseSlot knows how to reclaim. Clearing heartbeat first would
// instead strand ownerId > 0 with no heartbeat, which neither recovery nor claiming can ever release.
const clearOwnerLeaseSlot = (runtimeMeta: Int32Array, slotIndex: number) => {
    Atomics.store(runtimeMeta, getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId), 0);
    Atomics.store(
        runtimeMeta,
        getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount),
        0
    );
    Atomics.store(
        runtimeMeta,
        getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs),
        0
    );
};

const updateOwnerLeaseHeartbeat = (runtime: MemoryWriteAheadSharedRuntime, lease: LocalRuntimeLease) => {
    const runtimeMeta = getRuntimeMeta(runtime);
    const ownerIdIndex = getRuntimeOwnerLeaseIndex(lease.slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId);
    const heartbeatIndex = getRuntimeOwnerLeaseIndex(lease.slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs);

    if (Atomics.load(runtimeMeta, ownerIdIndex) !== lease.ownerId || lease.handleCount <= 0) {
        return false;
    }

    Atomics.store(runtimeMeta, heartbeatIndex, getMemoryWriteAheadLockClockMs());
    return true;
};

const reduceOpenHandleCount = (runtime: MemoryWriteAheadSharedRuntime, releasedHandleCount: number) => {
    if (releasedHandleCount <= 0) {
        return 0;
    }

    const runtimeMeta = getRuntimeMeta(runtime);
    let current = Atomics.load(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount);

    while (current > 0) {
        const next = Math.max(0, current - releasedHandleCount);
        const previous = Atomics.compareExchange(
            runtimeMeta,
            MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount,
            current,
            next
        );

        if (previous === current) {
            return current - next;
        }

        current = previous;
    }

    return 0;
};

const quarantineTransactionLocksForRuntimeOwner = (runtime: MemoryWriteAheadSharedRuntime, ownerId: number) => {
    let quarantinedTransactionCount = 0;

    Object.values(runtime.files).forEach((file) => {
        const meta = new Int32Array(file.meta);
        if (Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.transactionLockRuntimeOwner) !== ownerId) {
            return;
        }

        const lockState = Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.transactionLock);
        if (lockState !== 0) {
            // Attached databases use rollback journals stored inside the owning VFS context. If that context
            // terminates mid-transaction, releasing its shared lock would expose pages whose rollback journal
            // disappeared with the context. Keep the file fail-closed until the application resets the runtime.
            Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.abandonedTransaction, 1);
            quarantinedTransactionCount += 1;
        }
    });

    return quarantinedTransactionCount;
};

const recoverAbandonedRuntimeOwnerLeases = (
    runtime: MemoryWriteAheadSharedRuntime,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const runtimeMeta = getRuntimeMeta(runtime);
    let recoveredHandleCount = 0;

    for (let slotIndex = 0; slotIndex < MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT; slotIndex += 1) {
        const ownerIdIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId);
        const handleCountIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount);
        const heartbeatIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs);
        const ownerId = Atomics.load(runtimeMeta, ownerIdIndex);

        if (ownerId <= 0) {
            continue;
        }

        const staleHeartbeat = Atomics.load(runtimeMeta, heartbeatIndex);
        const staleAgeMs = getMemoryWriteAheadLockAgeMs(staleHeartbeat);

        if (staleAgeMs === null || staleAgeMs <= runtime.capacities.fileLockStaleMs) {
            continue;
        }

        if (Atomics.compareExchange(runtimeMeta, ownerIdIndex, ownerId, -ownerId) !== ownerId) {
            continue;
        }

        const currentHeartbeat = Atomics.load(runtimeMeta, heartbeatIndex);
        if (currentHeartbeat !== staleHeartbeat) {
            Atomics.store(runtimeMeta, ownerIdIndex, ownerId);
            continue;
        }

        const releasedHandleCount = reduceOpenHandleCount(runtime, Atomics.load(runtimeMeta, handleCountIndex));
        const quarantinedTransactionCount = quarantineTransactionLocksForRuntimeOwner(runtime, ownerId);
        clearOwnerLeaseSlot(runtimeMeta, slotIndex);
        Atomics.add(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.recoveredAbandonedHandleCount, releasedHandleCount);
        recoveredHandleCount += releasedHandleCount;
        logger.warn('Recovered abandoned MemoryWriteAhead runtime owner lease', {
            dbFilename: runtime.dbFilename,
            ownerId,
            recoveredHandleCount: releasedHandleCount,
            quarantinedTransactionCount,
            slotIndex,
            staleAgeMs,
        });
    }

    return recoveredHandleCount;
};

const claimOwnerLeaseSlot = (runtimeMeta: Int32Array, ownerId: number, staleMs: number) =>
    Array.from({ length: MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT }, (_, slotIndex) => slotIndex).find((slotIndex) => {
        const ownerIdIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId);
        const handleCountIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount);
        const heartbeatIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.heartbeatMs);

        // Owned slots are never touched here, live or dead: a dead owner's heartbeat must keep aging so
        // recoverAbandonedRuntimeOwnerLeases can reclaim it. Publishing a fresh heartbeat on a slot whose
        // CAS would lose anyway used to push that recovery back by a full stale window on every scan.
        if (Atomics.load(runtimeMeta, ownerIdIndex) !== 0) {
            return false;
        }

        // A release interrupted mid-clear (clearOwnerLeaseSlot zeroes ownerId first) can strand a slot with
        // ownerId 0 but leftover handleCount/heartbeat; recovery ignores ownerless slots, so reclaim it here.
        // A stale heartbeat is the orphan marker: fresh leftovers (a racing clear or a zombie owner's late
        // heartbeat write) are skipped rather than disturbed, and with 32 slots a transient skip is cheap.
        const leftoverHeartbeatAgeMs = getMemoryWriteAheadLockAgeMs(Atomics.load(runtimeMeta, heartbeatIndex));
        const isStaleLeftover = leftoverHeartbeatAgeMs !== null && leftoverHeartbeatAgeMs > staleMs;

        if (
            (Atomics.load(runtimeMeta, handleCountIndex) !== 0 || Atomics.load(runtimeMeta, heartbeatIndex) !== 0) &&
            !isStaleLeftover
        ) {
            return false;
        }

        // The heartbeat is published before the CAS so the slot is never visible as "owned with a stale
        // heartbeat": recovery cannot steal a slot mid-claim, and death right after the CAS leaves a fresh
        // heartbeat that ages into normal recovery instead of an unrecoverable shape. If the CAS loses,
        // another claimer won the slot and the leftover write is a harmless refresh of its fresh heartbeat.
        Atomics.store(runtimeMeta, heartbeatIndex, getMemoryWriteAheadLockClockMs());
        if (Atomics.compareExchange(runtimeMeta, ownerIdIndex, 0, ownerId) !== 0) {
            return false;
        }

        Atomics.store(runtimeMeta, handleCountIndex, 0);
        return true;
    });

const ensureLocalRuntimeLease = (
    runtime: MemoryWriteAheadSharedRuntime,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const existingLease = localRuntimeLeases.get(runtime.dbFilename);
    if (existingLease) {
        return existingLease;
    }

    const runtimeMeta = getRuntimeMeta(runtime);
    const ownerId = createMemoryWriteAheadOwnerId();
    let freeSlotIndex = claimOwnerLeaseSlot(runtimeMeta, ownerId, runtime.capacities.fileLockStaleMs);

    // Exhaustion can mean every slot is held by a dead owner whose heartbeat has gone stale; claiming never
    // touches owned slots, so reclaim abandoned leases here and retry once before giving up.
    if (freeSlotIndex === undefined) {
        recoverAbandonedRuntimeOwnerLeases(runtime, logger);
        freeSlotIndex = claimOwnerLeaseSlot(runtimeMeta, ownerId, runtime.capacities.fileLockStaleMs);
    }

    if (freeSlotIndex === undefined) {
        throw new Error(`MemoryWriteAheadVFS owner lease capacity exhausted for ${runtime.dbFilename}`);
    }

    const lease: LocalRuntimeLease = {
        handleCount: 0,
        heartbeatIntervalId: setInterval(() => {
            if (!updateOwnerLeaseHeartbeat(runtime, lease)) {
                clearInterval(lease.heartbeatIntervalId);
            }
        }, getOwnerLeaseHeartbeatIntervalMs(runtime)),
        ownerId,
        runtimeDbFilename: runtime.dbFilename,
        slotIndex: freeSlotIndex,
    };

    localRuntimeLeases.set(runtime.dbFilename, lease);
    logger.debug('Registered MemoryWriteAhead runtime owner lease', {
        dbFilename: runtime.dbFilename,
        ownerId,
        slotIndex: freeSlotIndex,
    });
    return lease;
};

// Without COOP/COEP response headers a browser context is not cross-origin isolated and exposes
// no SharedArrayBuffer at all; the generic capability error would hide that deployment mistake.
const createGrowableSharedArrayBufferSupportError = (reservationError?: unknown) => {
    if (globalThis.crossOriginIsolated === false) {
        const error = new Error(
            'MemoryWriteAheadVFS requires growable SharedArrayBuffer support: this page is not cross-origin isolated. Serve it with the Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp response headers.'
        );
        memoryWriteAheadRuntimeLogger.error('MemoryWriteAheadVFS unavailable without cross-origin isolation', {
            crossOriginIsolated: false,
            error: error.message,
        });
        return error;
    }

    if (reservationError !== undefined) {
        return new Error(
            `MemoryWriteAheadVFS could not reserve a growable SharedArrayBuffer: ${
                reservationError instanceof Error ? reservationError.message : String(reservationError)
            }`,
            { cause: reservationError }
        );
    }

    return new Error('MemoryWriteAheadVFS requires growable SharedArrayBuffer support');
};

const createPotentiallyGrowableSharedArrayBuffer = (initialBytes: number, maxBytes: number) => {
    const Constructor = SharedArrayBuffer as unknown as GrowableSharedArrayBufferConstructor;

    return new Constructor(initialBytes, { maxByteLength: maxBytes });
};

const isGrowableSharedArrayBuffer = (
    buffer: SharedArrayBuffer,
    maxBytes: number
): buffer is GrowableSharedArrayBuffer => {
    const candidate = buffer as Partial<GrowableSharedArrayBuffer>;

    return candidate.maxByteLength === maxBytes && typeof candidate.grow === 'function';
};

const createSharedSegmentData = (
    initialBytes: number,
    maxBytes: number,
    allowFixedCapacityFallback: boolean
): MemoryWriteAheadSharedSegmentData => {
    try {
        const buffer = createPotentiallyGrowableSharedArrayBuffer(initialBytes, maxBytes);
        if (isGrowableSharedArrayBuffer(buffer, maxBytes)) {
            return {
                capacityMode: 'growable',
                data: buffer,
            };
        }
    } catch (reservationError) {
        if (!allowFixedCapacityFallback) {
            throw createGrowableSharedArrayBufferSupportError(reservationError);
        }
    }

    if (!allowFixedCapacityFallback) {
        throw createGrowableSharedArrayBufferSupportError();
    }

    return {
        capacityMode: 'fixed',
        data: new SharedArrayBuffer(maxBytes),
    };
};

const createSharedSegment = (
    initialBytes: number,
    maxBytes: number,
    allowFixedCapacityFallback: boolean
): MemoryWriteAheadSharedSegment => ({
    ...createSharedSegmentData(initialBytes, maxBytes, allowFixedCapacityFallback),
    maxCapacityBytes: maxBytes,
});

const createSharedFile = (
    dbFilename: string,
    pathname: string,
    initialCapacityBytes: number,
    maxCapacityBytes: number,
    allowFixedCapacityFallback: boolean
): MemoryWriteAheadSharedFile => {
    const segmentCapacityBytes = initialCapacityBytes;
    const segmentCount = Math.max(MIN_SEGMENT_COUNT, Math.ceil(maxCapacityBytes / segmentCapacityBytes));
    const segments = Array.from({ length: segmentCount }, (_, index) => {
        const segmentMaxBytes = Math.min(segmentCapacityBytes, maxCapacityBytes - index * segmentCapacityBytes);
        const initialBytes = index === 0 ? Math.min(initialCapacityBytes, segmentMaxBytes) : 0;
        return createSharedSegment(initialBytes, segmentMaxBytes, allowFixedCapacityFallback);
    });
    const meta = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * Object.keys(MEMORY_WRITE_AHEAD_FILE_META).length);
    Atomics.store(new Int32Array(meta), MEMORY_WRITE_AHEAD_FILE_META.activeSegmentCount, MIN_SEGMENT_COUNT);

    return {
        dbFilename: normalizeMemoryWriteAheadPathname(dbFilename),
        maxCapacityBytes,
        meta,
        pathname,
        segmentCapacityBytes,
        segments,
    };
};

const ensureSharedFile = (
    runtime: MemoryWriteAheadSharedRuntime,
    pathname: string,
    initialCapacityBytes: number,
    maxCapacityBytes: number
) => {
    const normalizedPathname = normalizeMemoryWriteAheadPathname(pathname);
    runtime.files[normalizedPathname] ??= createSharedFile(
        runtime.dbFilename,
        normalizedPathname,
        initialCapacityBytes,
        maxCapacityBytes,
        runtime.capacities.allowFixedCapacityFallback
    );

    return runtime.files[normalizedPathname];
};

const fileMetaViews = new WeakMap<MemoryWriteAheadSharedFile, Int32Array>();
const segmentByteViews = new WeakMap<MemoryWriteAheadSharedSegment, Uint8Array>();

const getFileMeta = (file: MemoryWriteAheadSharedFile) => {
    const existingView = fileMetaViews.get(file);
    if (existingView) {
        return existingView;
    }

    const view = new Int32Array(file.meta);
    fileMetaViews.set(file, view);
    return view;
};

const getSegmentBytes = (segment: MemoryWriteAheadSharedSegment) => {
    const existingView = segmentByteViews.get(segment);

    if (existingView?.byteLength === segment.data.byteLength) {
        return existingView;
    }

    const view = new Uint8Array(segment.data);
    segmentByteViews.set(segment, view);
    return view;
};

const getActiveSegmentCount = (file: MemoryWriteAheadSharedFile) =>
    Math.max(MIN_SEGMENT_COUNT, Atomics.load(getFileMeta(file), MEMORY_WRITE_AHEAD_FILE_META.activeSegmentCount));

const getAllocatedCapacityBytes = (file: MemoryWriteAheadSharedFile) =>
    file.segments.reduce((sum, segment) => sum + segment.data.byteLength, 0);

const getFileCapacityBytes = (file: MemoryWriteAheadSharedFile) =>
    file.segments.slice(0, getActiveSegmentCount(file)).reduce((sum, segment) => sum + segment.data.byteLength, 0);

const getActiveFileCapacityBytes = (file: MemoryWriteAheadSharedFile, activeSegmentCount: number) => {
    const activeSegment = file.segments[activeSegmentCount - 1];

    if (!activeSegment) {
        return 0;
    }

    return (activeSegmentCount - 1) * file.segmentCapacityBytes + activeSegment.data.byteLength;
};

const getFileSizeBytes = (file: MemoryWriteAheadSharedFile) =>
    Atomics.load(getFileMeta(file), MEMORY_WRITE_AHEAD_FILE_META.size);

const recordMemoryWriteAheadFileHighWater = (file: MemoryWriteAheadSharedFile) => {
    const meta = getFileMeta(file);
    updateAtomicMaxCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.peakLogicalSizeBytes, getFileSizeBytes(file));
    updateAtomicMaxCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.peakCapacityBytes, getFileCapacityBytes(file));
    updateAtomicMaxCounter(
        meta,
        MEMORY_WRITE_AHEAD_FILE_META.peakAllocatedCapacityBytes,
        getAllocatedCapacityBytes(file)
    );
};

const setFileSizeBytes = (file: MemoryWriteAheadSharedFile, sizeBytes: number) => {
    const meta = getFileMeta(file);
    Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.size, sizeBytes);
    updateAtomicMaxCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.peakLogicalSizeBytes, sizeBytes);
};

const setActiveSegmentCount = (file: MemoryWriteAheadSharedFile, segmentCount: number) => {
    const meta = getFileMeta(file);
    const previous = getActiveSegmentCount(file);
    const next = Math.max(MIN_SEGMENT_COUNT, Math.min(segmentCount, file.segments.length));

    if (next < previous) {
        const reclaimedSegments = previous - next;
        const reclaimedBytes = file.segments
            .slice(next, previous)
            .reduce((sum, segment) => sum + segment.data.byteLength, 0);
        addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedSegmentCount, reclaimedSegments);
        addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedBytes, reclaimedBytes);
    }

    Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.activeSegmentCount, next);
    Atomics.notify(meta, MEMORY_WRITE_AHEAD_FILE_META.activeSegmentCount);
    updateAtomicMaxCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.peakCapacityBytes, getFileCapacityBytes(file));
    updateAtomicMaxCounter(
        meta,
        MEMORY_WRITE_AHEAD_FILE_META.peakAllocatedCapacityBytes,
        getAllocatedCapacityBytes(file)
    );
};

const growSegment = (segment: MemoryWriteAheadSharedSegment, requiredBytes: number) => {
    if (requiredBytes <= segment.data.byteLength) {
        return false;
    }

    if (requiredBytes > segment.maxCapacityBytes) {
        throw new Error(`MemoryWriteAheadVFS segment capacity exceeded; required ${requiredBytes} bytes`);
    }

    if (segment.capacityMode === 'growable') {
        segment.data.grow(requiredBytes);
        return true;
    }

    throw new Error('MemoryWriteAheadVFS fixed SharedArrayBuffer segment cannot grow');
};

const findSegmentAtOffset = (file: MemoryWriteAheadSharedFile, logicalOffset: number) => {
    const segmentIndex = Math.floor(logicalOffset / file.segmentCapacityBytes);
    const segment = file.segments[segmentIndex];

    if (!segment) {
        return null;
    }

    return {
        segment,
        segmentIndex,
        segmentOffset: logicalOffset - segmentIndex * file.segmentCapacityBytes,
        segmentStartOffset: segmentIndex * file.segmentCapacityBytes,
    };
};

const ensureFileCapacity = (
    file: MemoryWriteAheadSharedFile,
    requiredCapacityBytes: number,
    onProgress?: () => void
) => {
    if (requiredCapacityBytes > file.maxCapacityBytes) {
        throw new Error(
            `MemoryWriteAheadVFS capacity exceeded for ${file.pathname}; required ${requiredCapacityBytes} bytes, max ${file.maxCapacityBytes} bytes`
        );
    }

    const activeSegmentCount = getActiveSegmentCount(file);
    if (requiredCapacityBytes <= getActiveFileCapacityBytes(file, activeSegmentCount)) {
        return;
    }

    const desiredSegmentCount =
        requiredCapacityBytes === 0
            ? MIN_SEGMENT_COUNT
            : Math.max(MIN_SEGMENT_COUNT, Math.ceil(requiredCapacityBytes / file.segmentCapacityBytes));

    let didGrowSegment = false;

    for (let index = Math.max(0, activeSegmentCount - 1); index < desiredSegmentCount; index += 1) {
        const segment = file.segments[index];
        if (!segment) {
            throw new Error(`MemoryWriteAheadVFS segment catalog exhausted for ${file.pathname}`);
        }

        const requiredSegmentBytes = Math.min(
            segment.maxCapacityBytes,
            Math.max(0, requiredCapacityBytes - index * file.segmentCapacityBytes)
        );
        didGrowSegment = growSegment(segment, requiredSegmentBytes) || didGrowSegment;
        onProgress?.();
    }

    if (desiredSegmentCount > activeSegmentCount) {
        setActiveSegmentCount(file, desiredSegmentCount);
    } else if (didGrowSegment) {
        const meta = getFileMeta(file);
        updateAtomicMaxCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.peakCapacityBytes, getFileCapacityBytes(file));
        updateAtomicMaxCounter(
            meta,
            MEMORY_WRITE_AHEAD_FILE_META.peakAllocatedCapacityBytes,
            getAllocatedCapacityBytes(file)
        );
    }
};

export const createMemoryWriteAheadSharedRuntime = (
    dbFilename: string,
    options: MemoryWriteAheadRuntimeOptions = {}
) => {
    const normalizedDbFilename = normalizeMemoryWriteAheadPathname(dbFilename);
    const capacities = resolveMemoryWriteAheadRuntimeOptions(options);
    if (capacities.allowFixedCapacityFallback === false && globalThis.crossOriginIsolated === false) {
        throw createGrowableSharedArrayBufferSupportError();
    }
    const registry = getRuntimeRegistry();
    const existing = registry.get(normalizedDbFilename);

    if (existing) {
        const compatibilityError =
            formatRuntimeOptions(existing.capacities) === formatRuntimeOptions(capacities)
                ? null
                : `MemoryWriteAheadVFS runtime for ${
                      existing.dbFilename
                  } already exists with different options. existing=${formatRuntimeOptions(
                      existing.capacities
                  )} requested=${formatRuntimeOptions(capacities)}`;

        if (compatibilityError) {
            throw new Error(compatibilityError);
        }

        memoryWriteAheadRuntimeLogger.debug('Reusing existing MemoryWriteAhead runtime', {
            dbFilename: existing.dbFilename,
            options: existing.capacities,
        });
        return existing;
    }

    const runtime: MemoryWriteAheadSharedRuntime = {
        capacities,
        dbFilename: normalizedDbFilename,
        files: {
            [normalizedDbFilename]: createSharedFile(
                normalizedDbFilename,
                normalizedDbFilename,
                capacities.initialDatabaseCapacityBytes,
                capacities.maxDatabaseCapacityBytes,
                capacities.allowFixedCapacityFallback
            ),
            [`${normalizedDbFilename}-wa0`]: createSharedFile(
                normalizedDbFilename,
                `${normalizedDbFilename}-wa0`,
                capacities.initialWriteAheadCapacityBytes,
                capacities.maxWriteAheadCapacityBytes,
                capacities.allowFixedCapacityFallback
            ),
            [`${normalizedDbFilename}-wa1`]: createSharedFile(
                normalizedDbFilename,
                `${normalizedDbFilename}-wa1`,
                capacities.initialWriteAheadCapacityBytes,
                capacities.maxWriteAheadCapacityBytes,
                capacities.allowFixedCapacityFallback
            ),
        },
        registryMeta: new SharedArrayBuffer(
            Int32Array.BYTES_PER_ELEMENT *
                (RUNTIME_META_HEADER_LENGTH + MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT * OWNER_LEASE_META_WIDTH)
        ),
    };

    registry.set(normalizedDbFilename, runtime);
    memoryWriteAheadRuntimeLogger.info('Created MemoryWriteAhead shared runtime', {
        dbFilename: runtime.dbFilename,
        options: runtime.capacities,
    });
    return runtime;
};

export const ensureMemoryWriteAheadDatabaseFiles = (
    runtime: MemoryWriteAheadSharedRuntime,
    dbFilename: string
): MemoryWriteAheadDatabaseFiles => {
    const normalizedDbFilename = normalizeMemoryWriteAheadPathname(dbFilename);
    const database = ensureSharedFile(
        runtime,
        normalizedDbFilename,
        runtime.capacities.initialDatabaseCapacityBytes,
        runtime.capacities.maxDatabaseCapacityBytes
    );

    // Only the runtime's primary database is opened with a WriteAhead. Attached databases use SQLite's rollback
    // journal, so a -wa0/-wa1 pair for them would only consume growable SharedArrayBuffer reservation.
    if (normalizedDbFilename !== runtime.dbFilename) {
        return { database, writeAhead: [] };
    }

    return {
        database,
        writeAhead: [
            ensureSharedFile(
                runtime,
                `${normalizedDbFilename}-wa0`,
                runtime.capacities.initialWriteAheadCapacityBytes,
                runtime.capacities.maxWriteAheadCapacityBytes
            ),
            ensureSharedFile(
                runtime,
                `${normalizedDbFilename}-wa1`,
                runtime.capacities.initialWriteAheadCapacityBytes,
                runtime.capacities.maxWriteAheadCapacityBytes
            ),
        ],
    };
};

export const registerMemoryWriteAheadRuntime = (runtime: MemoryWriteAheadSharedRuntime) => {
    getRuntimeRegistry().set(normalizeMemoryWriteAheadPathname(runtime.dbFilename), runtime);
    return runtime;
};

export const registerMemoryWriteAheadSharedFiles = ({
    files,
    runtimeDbFilename,
}: MemoryWriteAheadSharedFilesRegistration) => {
    const normalizedDbFilename = normalizeMemoryWriteAheadPathname(runtimeDbFilename);
    const runtime = getRuntimeRegistry().get(normalizedDbFilename);

    if (!runtime) {
        throw new Error(`MemoryWriteAheadVFS runtime is not registered for ${normalizedDbFilename}`);
    }

    files.forEach((file) => {
        if (normalizeMemoryWriteAheadPathname(file.dbFilename) !== normalizedDbFilename) {
            throw new Error(
                `MemoryWriteAheadVFS file ${file.pathname} belongs to ${file.dbFilename}, not ${normalizedDbFilename}`
            );
        }

        runtime.files[normalizeMemoryWriteAheadPathname(file.pathname)] = file;
    });

    return runtime;
};

export const retainMemoryWriteAheadRuntimeHandle = (
    runtime: MemoryWriteAheadSharedRuntime,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const lease = ensureLocalRuntimeLease(runtime, logger);
    const runtimeMeta = getRuntimeMeta(runtime);
    lease.handleCount += 1;
    Atomics.add(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount, 1);
    Atomics.add(
        runtimeMeta,
        getRuntimeOwnerLeaseIndex(lease.slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount),
        1
    );
    updateOwnerLeaseHeartbeat(runtime, lease);
    logger.debug('Retained MemoryWriteAhead runtime handle', {
        dbFilename: runtime.dbFilename,
        localHandleCount: lease.handleCount,
        openHandleCount: getOpenHandleCount(runtime),
        ownerId: lease.ownerId,
        slotIndex: lease.slotIndex,
    });
    return lease.ownerId;
};

export const releaseMemoryWriteAheadRuntimeHandle = (
    runtime: MemoryWriteAheadSharedRuntime,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const lease = localRuntimeLeases.get(runtime.dbFilename);
    if (!lease) {
        return;
    }

    lease.handleCount = Math.max(0, lease.handleCount - 1);
    const runtimeMeta = getRuntimeMeta(runtime);
    const ownerIdIndex = getRuntimeOwnerLeaseIndex(lease.slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId);
    const handleCountIndex = getRuntimeOwnerLeaseIndex(
        lease.slotIndex,
        MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount
    );
    const slotOwnerId = Atomics.load(runtimeMeta, ownerIdIndex);

    if (slotOwnerId === lease.ownerId) {
        const slotHandleCount = Atomics.load(runtimeMeta, handleCountIndex);

        if (slotHandleCount > 0) {
            Atomics.sub(runtimeMeta, handleCountIndex, 1);
            reduceOpenHandleCount(runtime, 1);
        }

        if (slotHandleCount <= 1 && lease.handleCount === 0) {
            clearOwnerLeaseSlot(runtimeMeta, lease.slotIndex);
        } else {
            updateOwnerLeaseHeartbeat(runtime, lease);
        }
    }

    if (lease.handleCount === 0) {
        clearInterval(lease.heartbeatIntervalId);
        localRuntimeLeases.delete(runtime.dbFilename);
    }

    logger.debug('Released MemoryWriteAhead runtime handle', {
        dbFilename: runtime.dbFilename,
        localHandleCount: lease.handleCount,
        openHandleCount: getOpenHandleCount(runtime),
        ownerId: lease.ownerId,
        slotIndex: lease.slotIndex,
    });
};

export const getMemoryWriteAheadRuntimeOwnerId = (runtime: MemoryWriteAheadSharedRuntime) =>
    localRuntimeLeases.get(runtime.dbFilename)?.ownerId ?? null;

export const recoverTerminatedMemoryWriteAheadRuntimeOwner = (
    runtime: MemoryWriteAheadSharedRuntime,
    ownerId: number,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    if (ownerId <= 0) {
        return 0;
    }

    const runtimeMeta = getRuntimeMeta(runtime);
    const slotIndex = Array.from({ length: MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT }, (_, index) => index).find(
        (index) =>
            Atomics.load(runtimeMeta, getRuntimeOwnerLeaseIndex(index, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId)) ===
            ownerId
    );
    if (slotIndex === undefined) {
        return 0;
    }

    const ownerIdIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.ownerId);
    if (Atomics.compareExchange(runtimeMeta, ownerIdIndex, ownerId, -ownerId) !== ownerId) {
        return 0;
    }

    const handleCountIndex = getRuntimeOwnerLeaseIndex(slotIndex, MEMORY_WRITE_AHEAD_OWNER_LEASE_META.handleCount);
    const recoveredHandleCount = reduceOpenHandleCount(runtime, Atomics.load(runtimeMeta, handleCountIndex));
    const quarantinedTransactionCount = quarantineTransactionLocksForRuntimeOwner(runtime, ownerId);
    clearOwnerLeaseSlot(runtimeMeta, slotIndex);
    Atomics.add(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.recoveredAbandonedHandleCount, recoveredHandleCount);
    logger.warn('Recovered terminated MemoryWriteAhead runtime owner', {
        dbFilename: runtime.dbFilename,
        ownerId,
        recoveredHandleCount,
        quarantinedTransactionCount,
        slotIndex,
    });
    return recoveredHandleCount;
};

const resetMemoryWriteAheadRuntimeState = (runtime: MemoryWriteAheadSharedRuntime) => {
    recoverAbandonedRuntimeOwnerLeases(runtime);
    const runtimeMeta = getRuntimeMeta(runtime);
    const openHandleCount = getOpenHandleCount(runtime);

    if (openHandleCount > 0) {
        throw new Error(`Cannot reset MemoryWriteAheadVFS while ${openHandleCount} open handles remain`);
    }

    Object.values(runtime.files).forEach((file) => {
        const meta = getFileMeta(file);
        Object.values(MEMORY_WRITE_AHEAD_FILE_META).forEach((slot) => {
            Atomics.store(meta, slot, 0);
        });
        Atomics.store(meta, MEMORY_WRITE_AHEAD_FILE_META.activeSegmentCount, MIN_SEGMENT_COUNT);
        recordMemoryWriteAheadFileHighWater(file);
    });

    Atomics.store(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.openHandleCount, 0);
    Atomics.store(runtimeMeta, MEMORY_WRITE_AHEAD_RUNTIME_META.recoveredAbandonedHandleCount, 0);

    for (let slotIndex = 0; slotIndex < MEMORY_WRITE_AHEAD_OWNER_LEASE_SLOT_COUNT; slotIndex += 1) {
        clearOwnerLeaseSlot(runtimeMeta, slotIndex);
    }

    const localLease = localRuntimeLeases.get(runtime.dbFilename);
    if (localLease) {
        clearInterval(localLease.heartbeatIntervalId);
        localRuntimeLeases.delete(runtime.dbFilename);
    }
};

// With a dbFilename, resets only that runtime so concurrent clients (e.g. other databases) keep their
// runtimes; without one, resets every registered runtime (used by test teardown for a clean slate).
export const resetMemoryWriteAheadSharedRuntime = (dbFilename?: string) => {
    const registry = getRuntimeRegistry();

    if (dbFilename !== undefined) {
        const normalizedDbFilename = normalizeMemoryWriteAheadPathname(dbFilename);
        const runtime = registry.get(normalizedDbFilename);
        if (!runtime) {
            return;
        }

        resetMemoryWriteAheadRuntimeState(runtime);
        registry.delete(normalizedDbFilename);
        return;
    }

    for (const runtime of registry.values()) {
        resetMemoryWriteAheadRuntimeState(runtime);
    }

    registry.clear();
};

export const getMemoryWriteAheadFile = (runtime: MemoryWriteAheadSharedRuntime, pathname: string) => {
    return runtime.files[normalizeMemoryWriteAheadPathname(pathname)] ?? runtime.files[pathname];
};

export const getMemoryWriteAheadFileSizeBytes = (file: MemoryWriteAheadSharedFile) => getFileSizeBytes(file);

// Segment reads are lock-free; mutating helpers below assume the caller holds the file lock.
export const readMemoryWriteAheadFile = (
    file: MemoryWriteAheadSharedFile,
    target: Uint8Array | DataView,
    offset: number
) => {
    const destination =
        target instanceof Uint8Array ? target : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    const size = getFileSizeBytes(file);
    if (offset >= size) {
        return 0;
    }

    let bytesRead = 0;
    let logicalOffset = offset;

    while (bytesRead < destination.byteLength && logicalOffset < size) {
        const segmentEntry = findSegmentAtOffset(file, logicalOffset);
        if (!segmentEntry || segmentEntry.segmentOffset >= segmentEntry.segment.data.byteLength) {
            break;
        }

        const bytesAvailableInSegment = segmentEntry.segment.data.byteLength - segmentEntry.segmentOffset;
        const bytesRemainingInFile = size - logicalOffset;
        const bytesRemainingInTarget = destination.byteLength - bytesRead;
        const bytesToCopy = Math.min(bytesAvailableInSegment, bytesRemainingInFile, bytesRemainingInTarget);
        destination.set(new Uint8Array(segmentEntry.segment.data, segmentEntry.segmentOffset, bytesToCopy), bytesRead);

        bytesRead += bytesToCopy;
        logicalOffset += bytesToCopy;
    }

    return bytesRead;
};

export const ensureMemoryWriteAheadFileCapacity = (
    file: MemoryWriteAheadSharedFile,
    requiredCapacityBytes: number,
    onProgress?: () => void,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const previousSegmentCount = getActiveSegmentCount(file);
    ensureFileCapacity(file, requiredCapacityBytes, onProgress);
    const nextSegmentCount = getActiveSegmentCount(file);

    if (nextSegmentCount > previousSegmentCount) {
        logger.debug('Expanded MemoryWriteAhead segmented file capacity', {
            nextSegmentCount,
            pathname: file.pathname,
            previousSegmentCount,
            requiredCapacityBytes,
        });
    }
};

// Caller must hold this file's lock before writing shared bytes or metadata.
export const writeMemoryWriteAheadFile = (
    file: MemoryWriteAheadSharedFile,
    source: Uint8Array | DataView,
    offset: number,
    onProgress?: () => void,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const input =
        source instanceof Uint8Array ? source : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const requiredCapacityBytes = offset + input.byteLength;
    ensureMemoryWriteAheadFileCapacity(file, requiredCapacityBytes, onProgress, logger);

    let bytesWritten = 0;
    if (input.byteLength === 0) {
        setFileSizeBytes(file, Math.max(getFileSizeBytes(file), requiredCapacityBytes));
        addSaturatingAtomicCounter(getFileMeta(file), MEMORY_WRITE_AHEAD_FILE_META.writeOperationCount, 1);
        return bytesWritten;
    }

    const firstSegmentEntry = findSegmentAtOffset(file, offset);

    if (!firstSegmentEntry) {
        throw new Error(`Unable to locate segmented storage for ${file.pathname} at ${offset}`);
    }

    const firstSegmentBytes = Math.min(
        firstSegmentEntry.segment.data.byteLength - firstSegmentEntry.segmentOffset,
        input.byteLength
    );

    if (firstSegmentBytes === input.byteLength) {
        getSegmentBytes(firstSegmentEntry.segment).set(input, firstSegmentEntry.segmentOffset);
        bytesWritten = firstSegmentBytes;
        onProgress?.();
    } else {
        getSegmentBytes(firstSegmentEntry.segment).set(
            input.subarray(0, firstSegmentBytes),
            firstSegmentEntry.segmentOffset
        );
        bytesWritten = firstSegmentBytes;
        let logicalOffset = offset + firstSegmentBytes;
        onProgress?.();

        while (bytesWritten < input.byteLength) {
            const segmentEntry = findSegmentAtOffset(file, logicalOffset);
            if (!segmentEntry) {
                throw new Error(`Unable to locate segmented storage for ${file.pathname} at ${logicalOffset}`);
            }

            const bytesAvailableInSegment = segmentEntry.segment.data.byteLength - segmentEntry.segmentOffset;
            const bytesRemainingInTarget = input.byteLength - bytesWritten;
            const bytesToCopy = Math.min(bytesAvailableInSegment, bytesRemainingInTarget);
            getSegmentBytes(segmentEntry.segment).set(
                input.subarray(bytesWritten, bytesWritten + bytesToCopy),
                segmentEntry.segmentOffset
            );

            bytesWritten += bytesToCopy;
            logicalOffset += bytesToCopy;
            onProgress?.();
        }
    }

    setFileSizeBytes(file, Math.max(getFileSizeBytes(file), requiredCapacityBytes));
    const meta = getFileMeta(file);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.writeOperationCount, 1);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.writtenBytes, bytesWritten);
    return bytesWritten;
};

// Caller must hold this file's lock before truncating shared bytes or metadata.
export const truncateMemoryWriteAheadFile = (
    file: MemoryWriteAheadSharedFile,
    sizeBytes: number,
    onProgress?: () => void,
    logger: MemoryWriteAheadLogger = memoryWriteAheadRuntimeLogger
) => {
    const previousSegmentCount = getActiveSegmentCount(file);
    ensureMemoryWriteAheadFileCapacity(file, sizeBytes, onProgress, logger);
    setFileSizeBytes(file, sizeBytes);
    onProgress?.();

    const desiredSegmentCount =
        sizeBytes === 0
            ? MIN_SEGMENT_COUNT
            : Math.max(MIN_SEGMENT_COUNT, Math.ceil(sizeBytes / file.segmentCapacityBytes));
    setActiveSegmentCount(file, desiredSegmentCount);
    const meta = getFileMeta(file);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.truncateOperationCount, 1);
    recordMemoryWriteAheadFileHighWater(file);

    if (desiredSegmentCount < previousSegmentCount) {
        logger.debug('Reclaimed MemoryWriteAhead segmented file capacity', {
            nextSegmentCount: desiredSegmentCount,
            pathname: file.pathname,
            previousSegmentCount,
            sizeBytes,
        });
    }
};

export const recordMemoryWriteAheadFileLockWait = (
    file: MemoryWriteAheadSharedFile,
    waitCount: number,
    waitMs: number
) => {
    if (waitCount <= 0) {
        return;
    }

    const meta = getFileMeta(file);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.lockWaitCount, waitCount);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.lockWaitMs, Math.max(0, Math.round(waitMs)));
};

export const recordMemoryWriteAheadCheckpoint = (
    file: MemoryWriteAheadSharedFile,
    durationMs: number,
    writeAheadPages: number
) => {
    const meta = getFileMeta(file);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.checkpointCount, 1);
    addSaturatingAtomicCounter(meta, MEMORY_WRITE_AHEAD_FILE_META.checkpointMs, Math.max(0, Math.round(durationMs)));
    addSaturatingAtomicCounter(
        meta,
        MEMORY_WRITE_AHEAD_FILE_META.checkpointWriteAheadPages,
        Math.max(0, Math.round(writeAheadPages))
    );
    Atomics.store(
        meta,
        MEMORY_WRITE_AHEAD_FILE_META.lastCheckpointMs,
        Math.max(0, Math.min(MAX_INT32_ATOMIC_COUNTER, Math.round(durationMs)))
    );
    Atomics.store(
        meta,
        MEMORY_WRITE_AHEAD_FILE_META.lastCheckpointWriteAheadPages,
        Math.max(0, Math.min(MAX_INT32_ATOMIC_COUNTER, Math.round(writeAheadPages)))
    );
};

export const clearMemoryWriteAheadFile = (file: MemoryWriteAheadSharedFile) => {
    const meta = getFileMeta(file);
    Object.values(MEMORY_WRITE_AHEAD_FILE_META).forEach((slot) => {
        Atomics.store(meta, slot, 0);
    });
    setFileSizeBytes(file, 0);
    setActiveSegmentCount(file, MIN_SEGMENT_COUNT);
};

export const getMemoryWriteAheadRuntimeDiagnostics = (
    dbFilename: string
): MemoryWriteAheadRuntimeDiagnostics | null => {
    const runtime = getRuntimeRegistry().get(normalizeMemoryWriteAheadPathname(dbFilename));

    if (!runtime) {
        return null;
    }

    return {
        activeOwnerLeaseCount: countActiveOwnerLeases(runtime),
        capacities: runtime.capacities,
        dbFilename: runtime.dbFilename,
        files: Object.values(runtime.files).map((file) => {
            const meta = getFileMeta(file);
            const lockState = Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lock);
            const allocatedCapacityBytes = getAllocatedCapacityBytes(file);
            const capacityBytes = getFileCapacityBytes(file);
            const logicalSizeBytes = getFileSizeBytes(file);
            return {
                allocatedCapacityBytes,
                capacityBytes,
                currentCapacityBytes: capacityBytes,
                logicalSizeBytes,
                maxCapacityBytes: file.maxCapacityBytes,
                pathname: file.pathname,
                reclaimedBytes: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedBytes),
                reclaimedSegmentCount: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.reclaimedSegmentCount),
                segmentCapacityBytes: file.segmentCapacityBytes,
                segmentCount: getActiveSegmentCount(file),
                totalSegmentCount: file.segments.length,
                peakLogicalSizeBytes: Math.max(
                    logicalSizeBytes,
                    Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.peakLogicalSizeBytes)
                ),
                peakCapacityBytes: Math.max(
                    capacityBytes,
                    Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.peakCapacityBytes)
                ),
                peakAllocatedCapacityBytes: Math.max(
                    allocatedCapacityBytes,
                    Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.peakAllocatedCapacityBytes)
                ),
                writeOperationCount: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.writeOperationCount),
                writtenBytes: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.writtenBytes),
                truncateOperationCount: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.truncateOperationCount),
                lockWaitCount: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lockWaitCount),
                lockWaitMs: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lockWaitMs),
                checkpointCount: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.checkpointCount),
                checkpointMs: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.checkpointMs),
                checkpointWriteAheadPages: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.checkpointWriteAheadPages),
                lastCheckpointMs: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lastCheckpointMs),
                lastCheckpointWriteAheadPages: Atomics.load(
                    meta,
                    MEMORY_WRITE_AHEAD_FILE_META.lastCheckpointWriteAheadPages
                ),
                lockState,
                lockOwner: lockState === 0 ? 0 : Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lockOwner),
                lockHeartbeatAgeMs:
                    lockState === 0
                        ? null
                        : getMemoryWriteAheadLockAgeMs(
                              Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs)
                          ),
                recoveredAbandonedLockCount: Atomics.load(
                    meta,
                    MEMORY_WRITE_AHEAD_FILE_META.recoveredAbandonedLockCount
                ),
                abandonedTransaction: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.abandonedTransaction) !== 0,
                transactionLockRuntimeOwner: Atomics.load(
                    meta,
                    MEMORY_WRITE_AHEAD_FILE_META.transactionLockRuntimeOwner
                ),
                transactionLockState: Atomics.load(meta, MEMORY_WRITE_AHEAD_FILE_META.transactionLock),
            };
        }),
        openHandleCount: getOpenHandleCount(runtime),
        recoveredAbandonedHandleCount: getRecoveredAbandonedHandleCount(runtime),
        segmentedSharedArrayBuffers: true,
    };
};
