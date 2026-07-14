declare module '@journeyapps/wa-sqlite/src/FacadeVFS.js' {
    export class FacadeVFS {
        name: string;
        mxPathname: number;
        constructor(name: string, module: object);
        close(): void | Promise<void>;
        isReady(): boolean | Promise<boolean>;
        hasAsyncMethod(methodName: string): boolean;
        xSectorSize(fileId: number): number | Promise<number>;
    }
}

declare module '@journeyapps/wa-sqlite/src/VFS.js' {
    export const SQLITE_ACCESS_EXISTS: number;
    export const SQLITE_BUSY: number;
    export const SQLITE_CANTOPEN: number;
    export const SQLITE_FCNTL_BEGIN_ATOMIC_WRITE: number;
    export const SQLITE_FCNTL_COMMIT_ATOMIC_WRITE: number;
    export const SQLITE_FCNTL_OVERWRITE: number;
    export const SQLITE_FCNTL_PRAGMA: number;
    export const SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE: number;
    export const SQLITE_FCNTL_SYNC: number;
    export const SQLITE_IOCAP_BATCH_ATOMIC: number;
    export const SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN: number;
    export const SQLITE_IOERR: number;
    export const SQLITE_IOERR_ACCESS: number;
    export const SQLITE_IOERR_CLOSE: number;
    export const SQLITE_IOERR_DELETE: number;
    export const SQLITE_IOERR_FSTAT: number;
    export const SQLITE_IOERR_FSYNC: number;
    export const SQLITE_IOERR_LOCK: number;
    export const SQLITE_IOERR_READ: number;
    export const SQLITE_IOERR_SHORT_READ: number;
    export const SQLITE_IOERR_TRUNCATE: number;
    export const SQLITE_IOERR_UNLOCK: number;
    export const SQLITE_IOERR_WRITE: number;
    export const SQLITE_LOCK_NONE: number;
    export const SQLITE_LOCK_RESERVED: number;
    export const SQLITE_LOCK_SHARED: number;
    export const SQLITE_NOTFOUND: number;
    export const SQLITE_OK: number;
    export const SQLITE_OPEN_CREATE: number;
    export const SQLITE_OPEN_DELETEONCLOSE: number;
    export const SQLITE_OPEN_MAIN_DB: number;
    export const SQLITE_OPEN_SUPER_JOURNAL: number;
    export const SQLITE_OPEN_WAL: number;
}

declare module '@journeyapps/wa-sqlite/src/examples/LazyLock.js' {
    export class LazyLock {
        readonly mode: 'shared' | 'exclusive' | null;
        constructor(name: string);
        acquire(mode: 'shared' | 'exclusive', timeout?: number): Promise<boolean>;
        acquireIfHeld(mode: 'shared' | 'exclusive'): boolean;
        close(): void;
        release(): void;
        releaseLazy(): void;
    }
}

declare module '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs' {
    const factory: () => Promise<object>;
    export default factory;
}
