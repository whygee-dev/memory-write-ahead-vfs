import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';

import { MEMORY_WRITE_AHEAD_VFS, MemoryWriteAheadVFS, createMemoryWriteAheadSharedRuntime } from '../../src/index.js';

export const runReadmeQuickstart = async () => {
    const dbFilename = '/app.sqlite';
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const module = await waSqliteModuleFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);
    let db: number | null = null;

    try {
        sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
        db = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
        await sqlite3.exec(db, 'PRAGMA journal_mode=WAL');
        await sqlite3.exec(db, 'CREATE TABLE rows (value TEXT NOT NULL)');
        await sqlite3.exec(db, "INSERT INTO rows VALUES ('hello')");

        const rows: unknown[] = [];
        await sqlite3.exec(db, 'SELECT value FROM rows', (row: unknown[]) => {
            rows.push(row[0]);
        });
        return { rows };
    } finally {
        if (db !== null) {
            await sqlite3.close(db).catch(() => undefined);
        }
        MemoryWriteAheadVFS.resetRuntime(dbFilename);
    }
};
