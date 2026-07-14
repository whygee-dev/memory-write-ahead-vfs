type WriteAheadDurability = 'relaxed' | 'strict';

export class WriteAhead {
    readonly isolationState: 'read' | 'write' | null;
    log: ((...args: unknown[]) => void) | null;
    options: {
        autoCheckpoint: number;
        backstopInterval: number;
        journalSizeLimit: number;
    };
    constructor(dbName: string, dbHandle: object, writeAheadHandles: [object, object]);
    checkpoint(options?: { isPassive?: boolean }): Promise<void>;
    close(): void;
    commit(): void;
    getFileSize(): number;
    getWriteAheadSize(): number;
    isolateForRead(): void;
    isolateForWrite(): void;
    isTransactionPending(): boolean;
    read(offset: number): Uint8Array | undefined;
    ready(): Promise<void>;
    rejoin(): void;
    rollback(): void;
    setBackstopInterval(value: number): void;
    sync(options?: { durability?: WriteAheadDurability }): void;
    truncate(size: number): void;
    tryUpgradeReadIsolationToWrite(): boolean;
    write(offset: number, data: Uint8Array, options?: { dstPageSize?: number | null }): void;
}
