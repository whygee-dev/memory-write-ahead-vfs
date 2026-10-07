import * as SQLite from '@journeyapps/wa-sqlite';

import { MEMORY_WRITE_AHEAD_VFS, MemoryWriteAheadVFS, createMemoryWriteAheadSharedRuntime } from '../../src/index.js';
import {
    DATASET,
    INDEXES,
    INSERT_CATEGORY_SQL,
    INSERT_ITEM_SQL,
    INSERT_WORKLOAD_SQL,
    READ_QUERIES,
    SCHEMA,
    WORKLOAD,
    generateCategories,
    generateItems,
    type ReadQueryName,
    type SqlValue,
} from './dataset.js';

export type WorkloadName = ReadQueryName | 'insert';

export type WasmBuildRunRequest = {
    glueUrl: string;
    wasmUrl: string;
};

export type WasmBuildRunResult = {
    build: {
        compiler: string | null;
        maxAttached: number | null;
        sqliteVersion: string;
        wasmBytes: number;
        wasmSha256: string;
    };
    crossOriginIsolated: boolean;
    fingerprints: Record<WorkloadName, string>;
    hardwareConcurrency: number;
    instantiateMs: number;
    measuredMs: Record<WorkloadName, number[]>;
    rowCounts: Record<ReadQueryName, number>;
    seedMs: number;
};

type WorkerResponse = { ok: true; result: WasmBuildRunResult } | { ok: false; message: string; stack?: string };

type WaSqliteModuleFactory = (moduleArg?: { wasmBinary?: ArrayBuffer }) => Promise<object>;

const toHex = (buffer: ArrayBuffer) =>
    Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256 = async (data: ArrayBuffer | string) =>
    toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));

const runWorkload = async ({ glueUrl, wasmUrl }: WasmBuildRunRequest): Promise<WasmBuildRunResult> => {
    const { default: factory } = (await import(/* @vite-ignore */ glueUrl)) as { default: WaSqliteModuleFactory };
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
    const wasmSha256 = await sha256(wasmBinary);

    const instantiateStartedAt = performance.now();
    const module = await factory({ wasmBinary });
    const instantiateMs = performance.now() - instantiateStartedAt;

    const sqlite3 = SQLite.Factory(module);
    const dbFilename = '/wasm-build-comparison.sqlite';
    const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);
    sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
    const db = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);

    const selectRows = async (sql: string) => {
        const rows: SqlValue[][] = [];
        for await (const stmt of sqlite3.statements(db, sql)) {
            while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                rows.push(sqlite3.row(stmt) as SqlValue[]);
            }
        }
        return rows;
    };

    const insertRows = async (sql: string, rows: readonly SqlValue[][]) => {
        for await (const stmt of sqlite3.statements(db, sql)) {
            for (const row of rows) {
                sqlite3.bind_collection(stmt, row);
                await sqlite3.step(stmt);
                await sqlite3.reset(stmt);
            }
        }
    };

    try {
        await sqlite3.exec(db, 'PRAGMA journal_mode = WAL');
        await sqlite3.exec(db, `PRAGMA cache_size = -${WORKLOAD.cacheSizeKiB}`);
        await sqlite3.exec(db, 'PRAGMA temp_store = memory');

        const compileOptions = (await selectRows('PRAGMA compile_options')).map((row) => String(row[0]));
        const readOption = (prefix: string) =>
            compileOptions.find((option) => option.startsWith(prefix))?.slice(prefix.length) ?? null;
        const maxAttached = readOption('MAX_ATTACHED=');
        const sqliteVersion = String((await selectRows('SELECT sqlite_version()'))[0]?.[0]);

        const categories = generateCategories();
        const items = generateItems(DATASET.items, DATASET.seed);
        const insertWorkloadRows = generateItems(DATASET.insertRows, DATASET.seed + 1);

        const seedStartedAt = performance.now();
        await sqlite3.exec(db, 'BEGIN');
        for (const statement of SCHEMA) {
            await sqlite3.exec(db, statement);
        }
        await insertRows(INSERT_CATEGORY_SQL, categories);
        await insertRows(INSERT_ITEM_SQL, items);
        for (const statement of INDEXES) {
            await sqlite3.exec(db, statement);
        }
        await sqlite3.exec(db, 'COMMIT');
        const seedMs = performance.now() - seedStartedAt;

        const readQueryNames = Object.keys(READ_QUERIES) as ReadQueryName[];
        const measuredMs = Object.fromEntries(
            [...readQueryNames, 'insert'].map((name) => [name, [] as number[]])
        ) as Record<WorkloadName, number[]>;
        const fingerprints = {} as Record<WorkloadName, string>;
        const rowCounts = {} as Record<ReadQueryName, number>;

        for (let round = 0; round < WORKLOAD.warmupRounds + WORKLOAD.measuredRounds; round += 1) {
            const measured = round >= WORKLOAD.warmupRounds;

            for (const name of readQueryNames) {
                const startedAt = performance.now();
                const rows = await selectRows(READ_QUERIES[name]);
                const elapsedMs = performance.now() - startedAt;
                if (measured) {
                    measuredMs[name].push(elapsedMs);
                }
                if (round === WORKLOAD.warmupRounds) {
                    fingerprints[name] = await sha256(JSON.stringify(rows));
                    rowCounts[name] = rows.length;
                }
            }

            await sqlite3.exec(db, 'DELETE FROM item_insert');
            const insertStartedAt = performance.now();
            await sqlite3.exec(db, 'BEGIN');
            await insertRows(INSERT_WORKLOAD_SQL, insertWorkloadRows);
            await sqlite3.exec(db, 'COMMIT');
            const insertMs = performance.now() - insertStartedAt;
            if (measured) {
                measuredMs.insert.push(insertMs);
            }
            if (round === WORKLOAD.warmupRounds) {
                fingerprints.insert = await sha256(
                    JSON.stringify(
                        await selectRows(
                            'SELECT COUNT(*), SUM(quantity), SUM(unit_price), COUNT(description) FROM item_insert'
                        )
                    )
                );
            }
        }

        return {
            build: {
                compiler: readOption('COMPILER='),
                maxAttached: maxAttached === null ? null : Number(maxAttached),
                sqliteVersion,
                wasmBytes: wasmBinary.byteLength,
                wasmSha256,
            },
            crossOriginIsolated,
            fingerprints,
            hardwareConcurrency: navigator.hardwareConcurrency,
            instantiateMs,
            measuredMs,
            rowCounts,
            seedMs,
        };
    } finally {
        await sqlite3.close(db);
        await vfs.close();
    }
};

self.onmessage = async (event: MessageEvent<WasmBuildRunRequest>) => {
    const response: WorkerResponse = await runWorkload(event.data).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            return { ok: false as const, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
        }
    );
    self.postMessage(response);
};
