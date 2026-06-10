import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';

import {
    MEMORY_WRITE_AHEAD_VFS,
    MemoryWriteAheadVFS,
    type MemoryWriteAheadVFSOptions,
    type MemoryWriteAheadSharedRuntime,
} from '../../src/index.js';

type WaSqliteModule = object;
type SqlValue = bigint | number | string | Uint8Array | number[] | null;

type QueryResult = {
    columns: string[];
    rows: SqlValue[][];
};

export type BrowserSqliteConnection = {
    close(): Promise<void>;
    exec(sql: string): Promise<QueryResult>;
};

export const openMemoryWriteAheadDatabase = async (
    dbFilename: string,
    runtime: MemoryWriteAheadSharedRuntime,
    options: MemoryWriteAheadVFSOptions = {}
): Promise<BrowserSqliteConnection> => {
    const module = (await waSqliteModuleFactory()) as WaSqliteModule;
    const sqlite3 = SQLite.Factory(module);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime, options);
    sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
    const db = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
    let closed = false;

    return {
        async close() {
            if (closed) {
                return;
            }

            closed = true;
            await sqlite3.close(db);
        },
        async exec(sql: string) {
            const rows: SqlValue[][] = [];
            let columns: string[] = [];
            await sqlite3.exec(db, sql, (row: SqlValue[], columnNames: string[]) => {
                if (columnNames.length > 0) {
                    columns = columnNames;
                    rows.push(row);
                }
            });

            return { columns, rows };
        },
    };
};

export const withMemoryWriteAheadDatabase = async <TResult>(
    dbFilename: string,
    runtime: MemoryWriteAheadSharedRuntime,
    operation: (connection: BrowserSqliteConnection) => Promise<TResult>,
    options: MemoryWriteAheadVFSOptions = {}
) => {
    const connection = await openMemoryWriteAheadDatabase(dbFilename, runtime, options);

    try {
        return await operation(connection);
    } finally {
        await connection.close();
    }
};
