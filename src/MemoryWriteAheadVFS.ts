import { FacadeVFS } from '@journeyapps/wa-sqlite/src/FacadeVFS.js';
import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';
import { LazyLock } from '@journeyapps/wa-sqlite/src/examples/LazyLock.js';
import { WriteAhead } from '@journeyapps/wa-sqlite/src/examples/WriteAhead.js';
import { type MemoryWriteAheadLogger, resolveMemoryWriteAheadLogger } from './logger.js';

import {
    MEMORY_WRITE_AHEAD_FILE_META,
    type MemoryWriteAheadSharedFile,
    type MemoryWriteAheadSharedRuntime,
    clearMemoryWriteAheadFile,
    getMemoryWriteAheadFile,
    getMemoryWriteAheadFileSizeBytes,
    getMemoryWriteAheadLockAgeMs,
    getMemoryWriteAheadLockClockMs,
    normalizeMemoryWriteAheadPathname,
    readMemoryWriteAheadFile,
    registerMemoryWriteAheadRuntime,
    releaseMemoryWriteAheadRuntimeHandle,
    resetMemoryWriteAheadSharedRuntime,
    retainMemoryWriteAheadRuntimeHandle,
    truncateMemoryWriteAheadFile,
    writeMemoryWriteAheadFile,
} from './memoryWriteAheadSharedRuntime.js';

type MemoryWriteAheadLocalFile = {
    data: ArrayBuffer;
    pathname: string;
    size: number;
};

type MemoryWriteAheadAccessHandle = {
    close(): void;
    flush(): void;
    getSize(): number;
    read(buffer: Uint8Array | DataView, options?: { at?: number }): number;
    truncate(size: number): void;
    write(buffer: Uint8Array | DataView, options?: { at?: number }): number;
};

type MemoryWriteAheadOpenFile = {
    accessHandle?: MemoryWriteAheadAccessHandle;
    flags: number;
    lockingMode?: 'exclusive' | 'normal';
    lockState?: number;
    opened?: boolean;
    overwrite?: boolean;
    pageSize?: number | null;
    readLock?: LazyLock;
    retryResult?: Error | Record<string, never> | null;
    synchronous?: 0 | 1 | 2 | 3;
    timeout?: number;
    useLazyLock?: 'none' | 'read' | 'readwrite' | 'write';
    waHandles?: [MemoryWriteAheadAccessHandle, MemoryWriteAheadAccessHandle];
    writeAhead?: WriteAhead;
    writeHint?: 'exclusive' | 'reserved' | null;
    writeLock?: LazyLock;
    zName: string;
};

export const MEMORY_WRITE_AHEAD_VFS = 'MemoryWriteAheadVFS';

export type MemoryWriteAheadVFSOptions = {
    logger?: Partial<MemoryWriteAheadLogger>;
};

const FILE_LOCK_WAIT_TIMEOUT_MS = 50;
const FILE_LOCK_UNLOCKED = 0;

const sanitizeTraceValue = (value: unknown): unknown => {
    if (typeof value !== 'string') {
        return value;
    }

    // wa-sqlite trace output may include browser-console CSS markers; logs should not expose those placeholders.
    return value.split('%c').join('').trim();
};

const growBuffer = (buffer: ArrayBuffer, requiredSize: number) => {
    if (buffer.byteLength >= requiredSize) {
        return buffer;
    }

    const nextSize = Math.max(requiredSize, Math.max(buffer.byteLength * 2, 1));
    const nextBuffer = new ArrayBuffer(nextSize);
    new Uint8Array(nextBuffer).set(new Uint8Array(buffer));
    return nextBuffer;
};

const toUint8Array = (buffer: Uint8Array | DataView) =>
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const requireWriteAhead = (file: MemoryWriteAheadOpenFile) => {
    if (!file.writeAhead) {
        throw new Error(`MemoryWriteAhead state is not initialized for ${file.zName}`);
    }

    return file.writeAhead;
};

const workerGlobalScope = (
    globalThis as typeof globalThis & {
        WorkerGlobalScope?: {
            new (...args: never[]): object;
        };
    }
).WorkerGlobalScope;

const isWorkerBlockingContext =
    typeof self !== 'undefined' && typeof workerGlobalScope !== 'undefined' && self instanceof workerGlobalScope;

const createFileLockOwnerId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const values = crypto.getRandomValues(new Uint32Array(1));
        const value = values[0] ?? 0;
        return value & 0x3fffffff || 1;
    }

    return Math.floor(Math.random() * 0x3fffffff) + 1;
};

// Exported from this module for browser regression tests; the package root does not expose these protocol internals.
// File lock word: 0 means unlocked, +ownerId means held, -ownerId means a recovery claim owns cleanup.
// The heartbeat belongs to the positive lock owner or the in-flight acquirer that just observed an unlocked word.
// Contenders must never refresh the heartbeat while another owner or recovery claim is visible.
// lockOwner is diagnostic and gates heartbeat refresh; mutual exclusion/release is enforced by CAS on the lock word.
export const refreshMemoryWriteAheadFileLockHeartbeat = (view: Int32Array, ownerId: number) => {
    if (
        Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock) === ownerId &&
        Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner) === ownerId
    ) {
        Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs, getMemoryWriteAheadLockClockMs());
    }
};

const waitForUnlock = (view: Int32Array) => {
    const lockState = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    if (lockState === FILE_LOCK_UNLOCKED) {
        return;
    }

    if (isWorkerBlockingContext) {
        Atomics.wait(view, MEMORY_WRITE_AHEAD_FILE_META.lock, lockState, FILE_LOCK_WAIT_TIMEOUT_MS);
        return;
    }

    throw new Error('MemoryWriteAheadVFS lock contention requires dedicated worker execution');
};

const getFileLockRecoveryClaim = (ownerId: number) => -ownerId;

const finishRecoveredFileLock = (
    view: Int32Array,
    claim: number,
    staleAgeMs: number | null,
    logger?: MemoryWriteAheadLogger
) => {
    if (Atomics.compareExchange(view, MEMORY_WRITE_AHEAD_FILE_META.lock, claim, FILE_LOCK_UNLOCKED) !== claim) {
        return false;
    }

    Atomics.add(view, MEMORY_WRITE_AHEAD_FILE_META.recoveredAbandonedLockCount, 1);
    Atomics.notify(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    logger?.warn('Recovered abandoned MemoryWriteAhead file lock', {
        staleAgeMs,
    });
    return true;
};

export const recoverAbandonedMemoryWriteAheadFileLock = (
    view: Int32Array,
    staleMs: number,
    logger?: MemoryWriteAheadLogger
) => {
    const lockState = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    if (lockState === FILE_LOCK_UNLOCKED) {
        return false;
    }

    const heartbeatMs = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs);
    const ageMs = getMemoryWriteAheadLockAgeMs(heartbeatMs);

    if (ageMs !== null && ageMs <= staleMs) {
        return false;
    }

    if (lockState < FILE_LOCK_UNLOCKED) {
        return finishRecoveredFileLock(view, lockState, ageMs, logger);
    }

    if (ageMs === null) {
        return false;
    }

    const recoveryClaim = getFileLockRecoveryClaim(lockState);
    if (Atomics.compareExchange(view, MEMORY_WRITE_AHEAD_FILE_META.lock, lockState, recoveryClaim) !== lockState) {
        return false;
    }

    if (Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs) !== heartbeatMs) {
        Atomics.compareExchange(view, MEMORY_WRITE_AHEAD_FILE_META.lock, recoveryClaim, lockState);
        Atomics.notify(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
        return false;
    }

    return finishRecoveredFileLock(view, recoveryClaim, ageMs, logger);
};

export const acquireMemoryWriteAheadFileLock = (
    view: Int32Array,
    ownerId: number,
    staleMs: number,
    logger?: MemoryWriteAheadLogger
) => {
    while (true) {
        if (Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock) === FILE_LOCK_UNLOCKED) {
            Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockHeartbeatMs, getMemoryWriteAheadLockClockMs());

            if (
                Atomics.compareExchange(view, MEMORY_WRITE_AHEAD_FILE_META.lock, FILE_LOCK_UNLOCKED, ownerId) ===
                FILE_LOCK_UNLOCKED
            ) {
                Atomics.store(view, MEMORY_WRITE_AHEAD_FILE_META.lockOwner, ownerId);
                return;
            }
        }

        recoverAbandonedMemoryWriteAheadFileLock(view, staleMs, logger);
        waitForUnlock(view);
    }
};

export const releaseMemoryWriteAheadFileLock = (view: Int32Array, ownerId: number) => {
    if (Atomics.compareExchange(view, MEMORY_WRITE_AHEAD_FILE_META.lock, ownerId, FILE_LOCK_UNLOCKED) === ownerId) {
        Atomics.notify(view, MEMORY_WRITE_AHEAD_FILE_META.lock);
    }
};

class SABMemoryAccessHandle implements MemoryWriteAheadAccessHandle {
    #closed = false;
    readonly #lockOwnerId = createFileLockOwnerId();
    readonly #logger: MemoryWriteAheadLogger;
    readonly #metaView: Int32Array;
    readonly #staleMs: number;

    constructor(
        private readonly file: MemoryWriteAheadSharedFile,
        private readonly runtime: MemoryWriteAheadSharedRuntime,
        logger: MemoryWriteAheadLogger
    ) {
        this.#logger = logger;
        this.#metaView = new Int32Array(file.meta);
        this.#staleMs = runtime.capacities.fileLockStaleMs;
        retainMemoryWriteAheadRuntimeHandle(runtime, logger);
    }

    close() {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        releaseMemoryWriteAheadRuntimeHandle(this.runtime, this.#logger);
    }

    flush() {
        return;
    }

    getSize() {
        return getMemoryWriteAheadFileSizeBytes(this.file);
    }

    read(buffer: Uint8Array | DataView, options: { at?: number } = {}) {
        return readMemoryWriteAheadFile(this.file, buffer, options.at ?? 0);
    }

    #withFileLock<T>(operation: (refreshHeartbeat: () => void) => T) {
        acquireMemoryWriteAheadFileLock(this.#metaView, this.#lockOwnerId, this.#staleMs, this.#logger);
        try {
            return operation(() => refreshMemoryWriteAheadFileLockHeartbeat(this.#metaView, this.#lockOwnerId));
        } finally {
            releaseMemoryWriteAheadFileLock(this.#metaView, this.#lockOwnerId);
        }
    }

    truncate(size: number) {
        this.#withFileLock((refreshHeartbeat) =>
            truncateMemoryWriteAheadFile(this.file, size, refreshHeartbeat, this.#logger)
        );
    }

    write(buffer: Uint8Array | DataView, options: { at?: number } = {}) {
        const source = toUint8Array(buffer);
        const offset = options.at ?? 0;

        this.#withFileLock((refreshHeartbeat) =>
            writeMemoryWriteAheadFile(this.file, source, offset, refreshHeartbeat, this.#logger)
        );

        return source.byteLength;
    }
}

class LocalMemoryAccessHandle implements MemoryWriteAheadAccessHandle {
    constructor(private readonly file: MemoryWriteAheadLocalFile) {}

    close() {
        return;
    }

    flush() {
        return;
    }

    getSize() {
        return this.file.size;
    }

    read(buffer: Uint8Array | DataView, options: { at?: number } = {}) {
        const target = toUint8Array(buffer);
        const offset = options.at ?? 0;
        const begin = Math.min(offset, this.file.size);
        const end = Math.min(offset + target.byteLength, this.file.size);
        const bytesToRead = end - begin;

        if (bytesToRead > 0) {
            target.set(new Uint8Array(this.file.data, begin, bytesToRead));
        }

        return bytesToRead;
    }

    truncate(size: number) {
        this.file.data = growBuffer(this.file.data, size);
        this.file.size = size;
    }

    write(buffer: Uint8Array | DataView, options: { at?: number } = {}) {
        const source = toUint8Array(buffer);
        const offset = options.at ?? 0;
        this.file.data = growBuffer(this.file.data, offset + source.byteLength);
        new Uint8Array(this.file.data, offset, source.byteLength).set(source);
        this.file.size = Math.max(this.file.size, offset + source.byteLength);
        return source.byteLength;
    }
}

export class MemoryWriteAheadVFS extends FacadeVFS {
    /** Last VFS-layer error exposed through xGetLastError and useful when SQLite surfaces a generic I/O code. */
    lastError: Error | null = null;
    /** wa-sqlite trace sink toggled by VFS pragmas; prefer the logger option for application diagnostics. */
    log: typeof console.debug | null = null;
    private readonly mapIdToFile = new Map<number, MemoryWriteAheadOpenFile>();
    private readonly mapPathToFile = new Map<string, MemoryWriteAheadOpenFile>();
    readonly #localFiles = new Map<string, MemoryWriteAheadLocalFile>();
    readonly #logger: MemoryWriteAheadLogger;
    readonly #traceLog: (...args: unknown[]) => void;

    constructor(
        name: string,
        module: object,
        private readonly sharedRuntime: MemoryWriteAheadSharedRuntime,
        options: MemoryWriteAheadVFSOptions = {}
    ) {
        super(name, module);
        this.#logger = resolveMemoryWriteAheadLogger(options.logger);
        this.#traceLog = (...args: unknown[]) => {
            this.#logger.debug('MemoryWriteAheadVFS trace', {
                trace: args.map(sanitizeTraceValue),
            });
        };
        this.mxPathname = 512;
        registerMemoryWriteAheadRuntime(sharedRuntime);
    }

    static async create(
        name: string,
        module: object,
        sharedRuntime: MemoryWriteAheadSharedRuntime,
        options: MemoryWriteAheadVFSOptions = {}
    ) {
        const vfs = new MemoryWriteAheadVFS(name, module, sharedRuntime, options);
        await vfs.isReady();
        return vfs;
    }

    static resetRuntime(dbFilename?: string) {
        resetMemoryWriteAheadSharedRuntime(dbFilename);
    }

    #getModule() {
        return (
            this as unknown as {
                _module: {
                    UTF8ToString(pointer: number): string;
                    _sqlite3_malloc64(size: number): number;
                    pendingOps: Promise<unknown>[];
                    retryOps: Promise<unknown>[];
                    stringToUTF8(value: string, pointer: number, length: number): void;
                };
            }
        )._module;
    }

    jOpen(zName: string | null, fileId: number, flags: number, pOutFlags: DataView) {
        let shouldDeletePathOnError = false;

        try {
            const module = this.#getModule();
            const normalizedName = normalizeMemoryWriteAheadPathname(zName);

            if (flags & VFS.SQLITE_OPEN_MAIN_DB) {
                const existingFile = this.mapPathToFile.get(normalizedName);
                // retryResult === null on an unopened existing file means the first open's #retryOpen is
                // still in flight; wa-sqlite only retries after that op settles, so another open arriving
                // now is a duplicate. Queueing a second #retryOpen on the same file would race the handle
                // assignment and leak whichever handle set loses.
                const isOpenedOrOpening = existingFile && (existingFile.opened || existingFile.retryResult === null);
                if (isOpenedOrOpening && this.mapIdToFile.get(fileId) !== existingFile) {
                    throw new Error(
                        `Open a separate MemoryWriteAheadVFS instance for each SQLite connection to ${normalizedName}`
                    );
                }

                const file = existingFile ?? {
                    zName: normalizedName,
                    flags,
                    retryResult: null,
                };
                this.mapPathToFile.set(normalizedName, file);
                shouldDeletePathOnError = !file.opened;

                if (file.retryResult === null) {
                    module.retryOps.push(this.#retryOpen(file));
                    return VFS.SQLITE_BUSY;
                }

                if (file.retryResult instanceof Error) {
                    const error = file.retryResult;
                    file.retryResult = null;
                    throw error;
                }

                file.retryResult = null;
                file.lockState = VFS.SQLITE_LOCK_NONE;
                file.lockingMode = 'normal';
                file.readLock ??= new LazyLock(`${normalizedName}#read`);
                file.writeLock ??= new LazyLock(`${normalizedName}#write`);
                file.useLazyLock = 'readwrite';
                file.timeout = -1;
                file.synchronous = 1;
                file.writeHint = null;
                file.pageSize = null;
                file.overwrite = false;
                file.opened = true;
                this.mapIdToFile.set(fileId, file);

                pOutFlags.setInt32(0, flags, true);
                return VFS.SQLITE_OK;
            }

            const file = this.mapPathToFile.get(normalizedName) ?? {
                zName: normalizedName,
                flags,
                retryResult: null,
            };
            this.mapPathToFile.set(normalizedName, file);
            shouldDeletePathOnError = true;

            if (flags & (VFS.SQLITE_OPEN_WAL | VFS.SQLITE_OPEN_SUPER_JOURNAL)) {
                throw new Error('WAL and super-journal files are managed internally');
            } else if (!file.accessHandle) {
                file.accessHandle = this.#openTemporaryHandle(normalizedName, !!(flags & VFS.SQLITE_OPEN_CREATE));
            }

            this.mapIdToFile.set(fileId, file);
            pOutFlags.setInt32(0, flags, true);
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            this.mapIdToFile.delete(fileId);
            if (shouldDeletePathOnError) {
                this.mapPathToFile.delete(normalizeMemoryWriteAheadPathname(zName));
            }
            return VFS.SQLITE_CANTOPEN;
        }
    }

    jDelete(zName: string) {
        try {
            const normalizedName = normalizeMemoryWriteAheadPathname(zName);
            const sharedFile = getMemoryWriteAheadFile(this.sharedRuntime, normalizedName);

            if (sharedFile) {
                clearMemoryWriteAheadFile(sharedFile);
                const metaView = new Int32Array(sharedFile.meta);
                Atomics.store(metaView, MEMORY_WRITE_AHEAD_FILE_META.lock, FILE_LOCK_UNLOCKED);
                [0, 1].forEach((index) => {
                    const writeAheadFile = getMemoryWriteAheadFile(this.sharedRuntime, `${normalizedName}-wa${index}`);
                    if (!writeAheadFile) {
                        return;
                    }

                    clearMemoryWriteAheadFile(writeAheadFile);
                    const writeAheadMeta = new Int32Array(writeAheadFile.meta);
                    Atomics.store(writeAheadMeta, MEMORY_WRITE_AHEAD_FILE_META.lock, FILE_LOCK_UNLOCKED);
                });
            } else {
                this.#localFiles.delete(normalizedName);
            }

            this.mapPathToFile.delete(normalizedName);
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_DELETE;
        }
    }

    jAccess(zName: string, _flags: number, pResOut: DataView) {
        try {
            const normalizedName = normalizeMemoryWriteAheadPathname(zName);
            pResOut.setInt32(
                0,
                getMemoryWriteAheadFile(this.sharedRuntime, normalizedName) || this.#localFiles.has(normalizedName)
                    ? 1
                    : 0,
                true
            );
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_ACCESS;
        }
    }

    jClose(fileId: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_OK;
            }

            if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                file.writeAhead?.close();
                file.accessHandle?.close();
                file.waHandles?.forEach((handle) => handle.close());
                file.readLock?.close();
                file.writeLock?.close();
                file.opened = false;
                if (this.mapPathToFile.get(file.zName) === file) {
                    this.mapPathToFile.delete(file.zName);
                }
            } else {
                file.accessHandle?.close();
                if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
                    this.#localFiles.delete(file.zName);
                    this.mapPathToFile.delete(file.zName);
                }
            }

            this.mapIdToFile.delete(fileId);
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_CLOSE;
        }
    }

    jRead(fileId: number, pData: Uint8Array, iOffset: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_READ;
            }

            let bytesRead: number | null = null;
            if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                const pageOffset = iOffset < 100 ? iOffset : 0;
                const page = file.writeAhead?.read(iOffset - pageOffset);
                if (page) {
                    const readData = page.subarray(pageOffset, pageOffset + pData.byteLength);
                    pData.set(readData);
                    bytesRead = readData.byteLength;
                }
            }

            if (bytesRead === null) {
                bytesRead = file.accessHandle?.read(pData.subarray(), { at: iOffset }) ?? 0;
            }

            if (bytesRead < pData.byteLength) {
                pData.fill(0, bytesRead);
                return VFS.SQLITE_IOERR_SHORT_READ;
            }
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            this.#logger.error('MemoryWriteAheadVFS jRead failed', {
                error,
                fileId,
                iOffset,
                zName: this.mapIdToFile.get(fileId)?.zName,
            });
            return VFS.SQLITE_IOERR_READ;
        }
    }

    jWrite(fileId: number, pData: Uint8Array, iOffset: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_WRITE;
            }

            if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                const isPageResize = file.overwrite && file.pageSize !== pData.byteLength;
                file.writeAhead?.write(iOffset, pData, {
                    dstPageSize: isPageResize ? (file.pageSize ?? null) : null,
                });
                return VFS.SQLITE_OK;
            }

            file.accessHandle?.write(pData.subarray(), { at: iOffset });
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            this.#logger.error('MemoryWriteAheadVFS jWrite failed', {
                error,
                fileId,
                iOffset,
                size: pData.byteLength,
                zName: this.mapIdToFile.get(fileId)?.zName,
            });
            return VFS.SQLITE_IOERR_WRITE;
        }
    }

    jTruncate(fileId: number, iSize: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_TRUNCATE;
            }

            if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                file.writeAhead?.truncate(iSize);
                return VFS.SQLITE_OK;
            }

            file.accessHandle?.truncate(iSize);
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            this.#logger.error('MemoryWriteAheadVFS jTruncate failed', {
                error,
                fileId,
                iSize,
                zName: this.mapIdToFile.get(fileId)?.zName,
            });
            return VFS.SQLITE_IOERR_TRUNCATE;
        }
    }

    jSync(fileId: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_FSYNC;
            }

            if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                const durability = (file.synchronous ?? 1) > 1 ? 'strict' : 'relaxed';
                file.writeAhead?.sync({ durability });
            }

            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_FSYNC;
        }
    }

    jFileSize(fileId: number, pSize64: DataView) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_FSTAT;
            }

            const size =
                file.flags & VFS.SQLITE_OPEN_MAIN_DB
                    ? (file.writeAhead?.getFileSize() ?? file.accessHandle?.getSize() ?? 0)
                    : (file.accessHandle?.getSize() ?? 0);
            pSize64.setBigInt64(0, BigInt(size), true);
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_FSTAT;
        }
    }

    jLock(fileId: number, lockType: number) {
        try {
            const module = this.#getModule();
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_LOCK;
            }

            if (file.lockState === VFS.SQLITE_LOCK_NONE && lockType === VFS.SQLITE_LOCK_SHARED) {
                if (file.retryResult === null) {
                    if (file.lockingMode === 'exclusive') {
                        file.retryResult = {};
                        module.retryOps.push(this.#retryLockWrite(file));
                        return VFS.SQLITE_BUSY;
                    }

                    if (file.writeHint) {
                        if (!file.writeLock?.acquireIfHeld('exclusive')) {
                            module.retryOps.push(this.#retryLockWrite(file));
                            return VFS.SQLITE_BUSY;
                        }
                        file.writeAhead?.isolateForWrite();
                    } else {
                        if (!file.readLock?.acquireIfHeld('shared')) {
                            module.retryOps.push(this.#retryLockRead(file));
                            return VFS.SQLITE_BUSY;
                        }
                        file.writeAhead?.isolateForRead();
                    }
                } else if (file.retryResult instanceof Error) {
                    const error = file.retryResult;
                    file.retryResult = null;
                    throw error;
                }

                file.retryResult = null;
            } else if (lockType >= VFS.SQLITE_LOCK_RESERVED && !file.writeLock?.mode) {
                throw new Error('Write transaction cannot use BEGIN DEFERRED');
            }

            file.lockState = lockType;
            return VFS.SQLITE_OK;
        } catch (error) {
            if ((error as Error).name === 'TimeoutError') {
                return VFS.SQLITE_BUSY;
            }

            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_LOCK;
        }
    }

    jUnlock(fileId: number, lockType: number) {
        try {
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR_UNLOCK;
            }

            if (!file.retryResult && lockType === VFS.SQLITE_LOCK_NONE) {
                file.writeAhead?.rejoin();

                switch (file.useLazyLock) {
                    case 'none':
                        file.writeLock?.release();
                        file.readLock?.release();
                        break;
                    case 'read':
                        file.writeLock?.release();
                        file.readLock?.releaseLazy();
                        break;
                    case 'write':
                        file.writeLock?.releaseLazy();
                        file.readLock?.release();
                        break;
                    case 'readwrite':
                    default:
                        file.writeLock?.releaseLazy();
                        file.readLock?.releaseLazy();
                        break;
                }

                file.writeHint = null;
            }
            file.lockState = lockType;
            return VFS.SQLITE_OK;
        } catch (error) {
            this.lastError = error as Error;
            return VFS.SQLITE_IOERR_UNLOCK;
        }
    }

    jCheckReservedLock(_fileId: number, pResOut: DataView) {
        pResOut.setInt32(0, 0, true);
        return VFS.SQLITE_OK;
    }

    jFileControl(fileId: number, op: number, pArg: DataView) {
        try {
            const module = this.#getModule();
            const file = this.mapIdToFile.get(fileId);
            if (!file) {
                return VFS.SQLITE_IOERR;
            }

            switch (op) {
                case VFS.SQLITE_FCNTL_PRAGMA: {
                    const key = module.UTF8ToString(pArg.getUint32(4, true));
                    const valueAddress = pArg.getUint32(8, true);
                    const value = valueAddress ? module.UTF8ToString(valueAddress) : null;
                    switch (key.toLowerCase()) {
                        // Name matches upstream wa-sqlite OPFSWriteAheadVFS for write-hint compatibility.
                        case 'experimental_pragma_20251114':
                            switch (value) {
                                case '1':
                                    file.writeHint = 'reserved';
                                    break;
                                case '2':
                                    file.writeHint = 'exclusive';
                                    break;
                                default:
                                    throw new Error(`unexpected write hint value: ${value}`);
                            }
                            break;
                        case 'backstop_interval':
                            if (value !== null) {
                                requireWriteAhead(file).setBackstopInterval(parseInt(value, 10));
                            } else {
                                const current = requireWriteAhead(file).options.backstopInterval.toString();
                                const ptr = module._sqlite3_malloc64(current.length + 1);
                                module.stringToUTF8(current, ptr, current.length + 1);
                                pArg.setUint32(0, ptr, true);
                            }
                            return VFS.SQLITE_OK;
                        case 'busy_timeout':
                            if (value !== null) {
                                file.timeout = parseInt(value, 10);
                            } else {
                                const current = (file.timeout ?? -1).toString();
                                const ptr = module._sqlite3_malloc64(current.length + 1);
                                module.stringToUTF8(current, ptr, current.length + 1);
                                pArg.setUint32(0, ptr, true);
                            }
                            return VFS.SQLITE_OK;
                        case 'journal_size_limit':
                            if (value !== null) {
                                requireWriteAhead(file).options.journalSizeLimit = parseInt(value, 10);
                            }
                            break;
                        case 'locking_mode':
                            if (value?.toLowerCase() === 'exclusive') {
                                file.lockingMode = 'exclusive';
                            }
                            if (value?.toLowerCase() === 'normal') {
                                file.lockingMode = 'normal';
                            }
                            break;
                        case 'page_size':
                            if (value !== null) {
                                const parsed = parseInt(value, 10);
                                if (
                                    parsed === 1 ||
                                    (parsed >= 512 && parsed <= 32768 && (parsed & (parsed - 1)) === 0)
                                ) {
                                    file.pageSize = parsed === 1 ? 65536 : parsed;
                                }
                            }
                            break;
                        case 'synchronous':
                            if (value !== null) {
                                const normalized = value.toLowerCase();
                                if (normalized === 'off' || normalized === '0') {
                                    file.synchronous = 0;
                                } else if (normalized === 'normal' || normalized === '1') {
                                    file.synchronous = 1;
                                } else if (normalized === 'full' || normalized === '2') {
                                    file.synchronous = 2;
                                } else if (normalized === 'extra' || normalized === '3') {
                                    file.synchronous = 3;
                                }
                            }
                            break;
                        case 'vfs_trace':
                            if (value !== null) {
                                this.log = parseInt(value, 10) !== 0 ? this.#traceLog : null;
                                if (file.writeAhead) {
                                    file.writeAhead.log = this.log;
                                }
                            }
                            return VFS.SQLITE_OK;
                        case 'wal_autocheckpoint':
                            if (value !== null) {
                                requireWriteAhead(file).options.autoCheckpoint = parseInt(value, 10);
                            }
                            break;
                        case 'wal_checkpoint': {
                            const checkpointMode = (value ?? 'passive').toLowerCase();
                            switch (checkpointMode) {
                                case 'passive':
                                    module.pendingOps.push(this.#pendingCheckpoint(file, checkpointMode));
                                    break;
                                case 'full':
                                case 'restart':
                                case 'truncate':
                                    if (file.writeAhead?.isTransactionPending()) {
                                        throw new Error('invalid while a transaction is in progress');
                                    }
                                    module.pendingOps.push(this.#pendingCheckpoint(file, checkpointMode));
                                    break;
                                case 'noop':
                                    break;
                                default:
                                    throw new Error(`unexpected wal_checkpoint mode: ${value}`);
                            }

                            const size = (file.writeAhead?.getWriteAheadSize() ?? 0).toString();
                            const ptr = module._sqlite3_malloc64(size.length + 1);
                            module.stringToUTF8(size, ptr, size.length + 1);
                            pArg.setUint32(0, ptr, true);
                            return VFS.SQLITE_OK;
                        }
                        case 'lazy_lock':
                            if (value !== null) {
                                const normalized = value.toLowerCase();
                                if (
                                    normalized === 'read' ||
                                    normalized === 'write' ||
                                    normalized === 'readwrite' ||
                                    normalized === 'none'
                                ) {
                                    file.useLazyLock = normalized;
                                }
                            }
                            {
                                const current = file.useLazyLock ?? 'none';
                                const ptr = module._sqlite3_malloc64(current.length + 1);
                                module.stringToUTF8(current, ptr, current.length + 1);
                                pArg.setUint32(0, ptr, true);
                            }
                            return VFS.SQLITE_OK;
                    }
                    break;
                }
                case VFS.SQLITE_FCNTL_BEGIN_ATOMIC_WRITE:
                case VFS.SQLITE_FCNTL_COMMIT_ATOMIC_WRITE:
                    if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                        return VFS.SQLITE_OK;
                    }
                    break;
                case VFS.SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE:
                    if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                        file.writeAhead?.rollback();
                        return VFS.SQLITE_OK;
                    }
                    break;
                case VFS.SQLITE_FCNTL_SYNC:
                    if (file.flags & VFS.SQLITE_OPEN_MAIN_DB) {
                        if (file.writeAhead?.isTransactionPending()) {
                            file.writeAhead.commit();
                        }
                        file.writeAhead?.sync({
                            durability: (file.synchronous ?? 1) > 1 ? 'strict' : 'relaxed',
                        });
                    }
                    break;
                case VFS.SQLITE_FCNTL_OVERWRITE:
                    file.overwrite = true;
                    break;
            }
        } catch (error) {
            this.lastError = error as Error;
            this.#logger.error('MemoryWriteAheadVFS jFileControl failed', {
                error,
                fileId,
                op,
                zName: this.mapIdToFile.get(fileId)?.zName,
            });
            return VFS.SQLITE_IOERR;
        }

        return VFS.SQLITE_NOTFOUND;
    }

    jDeviceCharacteristics() {
        return VFS.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN | VFS.SQLITE_IOCAP_BATCH_ATOMIC;
    }

    jGetLastError(zBuf: Uint8Array) {
        if (this.lastError) {
            const outputArray = zBuf.subarray(0, zBuf.byteLength - 1);
            const { written } = new TextEncoder().encodeInto(this.lastError.message, outputArray);
            zBuf[written] = 0;
        }

        return VFS.SQLITE_OK;
    }

    async #pendingCheckpoint(file: MemoryWriteAheadOpenFile, mode: 'full' | 'passive' | 'restart' | 'truncate') {
        const onFinally: Array<() => void> = [];
        try {
            if (mode !== 'passive') {
                await file.writeLock?.acquire('exclusive');
                onFinally.push(() => file.writeLock?.release());

                file.writeAhead?.isolateForWrite();
                onFinally.push(() => file.writeAhead?.rejoin());
            }

            await file.writeAhead?.checkpoint({ isPassive: mode === 'passive' });
        } finally {
            while (onFinally.length) {
                onFinally.pop()?.();
            }
        }
    }

    async #retryLockRead(file: MemoryWriteAheadOpenFile) {
        const onError: Array<() => void> = [];
        try {
            await file.readLock?.acquire('shared', file.timeout);
            onError.push(() => file.readLock?.release());

            file.writeAhead?.isolateForRead();
            file.retryResult = {};
        } catch (error) {
            while (onError.length) {
                onError.pop()?.();
            }
            file.retryResult = error as Error;
        }
    }

    async #retryLockWrite(file: MemoryWriteAheadOpenFile) {
        const onError: Array<() => void> = [];
        try {
            if (file.lockingMode === 'exclusive') {
                await file.readLock?.acquire('exclusive', file.timeout);
                onError.push(() => file.readLock?.release());
            }

            await file.writeLock?.acquire('exclusive', file.timeout);
            onError.push(() => file.writeLock?.release());

            file.writeAhead?.isolateForWrite();
            file.retryResult = {};
        } catch (error) {
            while (onError.length) {
                onError.pop()?.();
            }
            file.retryResult = error as Error;
        }
    }

    async #retryOpen(file: MemoryWriteAheadOpenFile) {
        let accessHandle: MemoryWriteAheadAccessHandle | undefined;
        let waHandles: [MemoryWriteAheadAccessHandle, MemoryWriteAheadAccessHandle] | undefined;
        let writeAhead: WriteAhead | undefined;

        try {
            accessHandle = this.#openSharedHandle(file.zName);
            waHandles = [
                this.#openSharedHandle(this.#getWriteAheadNameFromDbName(file.zName, 0)),
                this.#openSharedHandle(this.#getWriteAheadNameFromDbName(file.zName, 1)),
            ];
            writeAhead = new WriteAhead(file.zName, accessHandle, waHandles);
            await writeAhead.ready();

            file.accessHandle = accessHandle;
            file.waHandles = waHandles;
            file.writeAhead = writeAhead;
            file.retryResult = {};
        } catch (error) {
            writeAhead?.close();
            waHandles?.forEach((handle) => handle.close());
            accessHandle?.close();
            file.retryResult = error as Error;
        }
    }

    #openSharedHandle(pathname: string) {
        const sharedFile = getMemoryWriteAheadFile(this.sharedRuntime, pathname);
        if (!sharedFile) {
            throw new Error(`Missing shared runtime file for ${pathname}`);
        }

        return new SABMemoryAccessHandle(sharedFile, this.sharedRuntime, this.#logger);
    }

    #openTemporaryHandle(pathname: string, create: boolean) {
        const existing = this.#localFiles.get(pathname);
        if (existing) {
            return new LocalMemoryAccessHandle(existing);
        }

        if (!create) {
            throw new Error(`file not found: ${pathname}`);
        }

        const file: MemoryWriteAheadLocalFile = {
            pathname,
            size: 0,
            data: new ArrayBuffer(0),
        };
        this.#localFiles.set(pathname, file);
        return new LocalMemoryAccessHandle(file);
    }

    #getWriteAheadNameFromDbName(dbName: string, index: number) {
        return `${dbName}-wa${index}`;
    }
}
