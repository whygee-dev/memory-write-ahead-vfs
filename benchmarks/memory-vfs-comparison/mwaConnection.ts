import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import {
    DBAdapterDefaultMixin,
    type DBAdapterListener,
    type DBLockOptions,
    type LockContext,
    type QueryResult,
} from '@powersync/common';
import * as Comlink from 'comlink';

import { MEMORY_WRITE_AHEAD_VFS, MemoryWriteAheadVFS, type MemoryWriteAheadSharedRuntime } from '../../src/index.js';

type SqlValue = bigint | number | string | Uint8Array | number[] | null;

export type BenchmarkSqlResult = {
    columns: string[];
    insertId: number;
    rows: SqlValue[][];
    rowsAffected: number;
};

export type BenchmarkWorkerApi = {
    close(): Promise<void>;
    execute(sql: string): Promise<BenchmarkSqlResult>;
    init(options: BenchmarkConnectionOptions): Promise<number>;
};

type BenchmarkConnectionOptions = {
    cacheSizeKiB: number;
    dbFilename: string;
    initializePragmas?: boolean;
    runtime: MemoryWriteAheadSharedRuntime;
};

type BenchmarkConnection = {
    close(): Promise<void>;
    execute(sql: string): Promise<BenchmarkSqlResult>;
};

type NamedConnection = {
    active: number;
    connection: BenchmarkConnection;
    label: string;
    tail: Promise<void>;
};

const rowsToObjects = (result: BenchmarkSqlResult) =>
    result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));

const createLockContext = (connection: BenchmarkConnection): LockContext => {
    const execute = async (query: string, params?: unknown[]): Promise<QueryResult> => {
        if (params && params.length > 0) {
            throw new Error('The public benchmark uses literal deterministic SQL and does not accept bindings');
        }

        const result = await connection.execute(query);
        const rows = rowsToObjects(result);
        return {
            insertId: result.insertId,
            rowsAffected: result.rowsAffected,
            ...(result.columns.length > 0
                ? {
                      rows: {
                          _array: rows,
                          length: rows.length,
                          item: (index: number) => rows[index],
                      },
                  }
                : {}),
        };
    };

    return {
        connectionType: 'writer',
        execute,
        executeBatch: async (query: string, params: unknown[][] = []) => {
            const results = await params.reduce<Promise<QueryResult[]>>(
                (previous, bindings) =>
                    previous.then(async (entries) => {
                        entries.push(await execute(query, bindings));
                        return entries;
                    }),
                Promise.resolve([])
            );
            const insertId = results.at(-1)?.insertId;
            return {
                rowsAffected: results.reduce((sum, result) => sum + result.rowsAffected, 0),
                ...(insertId === undefined ? {} : { insertId }),
            };
        },
        executeRaw: async (query: string, params?: unknown[]) => {
            if (params && params.length > 0) {
                throw new Error('The public benchmark uses literal deterministic SQL and does not accept bindings');
            }
            return (await connection.execute(query)).rows;
        },
        get: async <T>(query: string, params?: unknown[]) => {
            const rows = (await execute(query, params)).rows?._array ?? [];
            if (rows.length !== 1) {
                throw new Error(`Expected exactly one row, received ${rows.length}`);
            }
            return rows[0] as T;
        },
        getAll: async <T>(query: string, params?: unknown[]) =>
            ((await execute(query, params)).rows?._array ?? []) as T[],
        getOptional: async <T>(query: string, params?: unknown[]) =>
            (((await execute(query, params)).rows?._array ?? [])[0] as T | undefined) ?? null,
    };
};

export const createLocalBenchmarkConnection = async ({
    cacheSizeKiB,
    dbFilename,
    initializePragmas = true,
    runtime,
}: BenchmarkConnectionOptions): Promise<BenchmarkConnection & { ownerId: number }> => {
    const module = await waSqliteModuleFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);
    sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
    const db = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
    let closed = false;

    const execute = async (sql: string): Promise<BenchmarkSqlResult> => {
        const rows: SqlValue[][] = [];
        let columns: string[] = [];
        await sqlite3.exec(db, sql, (row: SqlValue[], columnNames: string[]) => {
            if (columnNames.length > 0) {
                columns = columnNames;
                rows.push(row);
            }
        });
        return {
            columns,
            insertId: Number(sqlite3.last_insert_id(db)),
            rows,
            rowsAffected: sqlite3.changes(db),
        };
    };

    if (initializePragmas) {
        await execute('PRAGMA temp_store = memory');
        await execute(`PRAGMA cache_size = -${cacheSizeKiB}`);
    }

    return {
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            await sqlite3.close(db);
            await vfs.close();
        },
        execute,
        ownerId: vfs.getRuntimeOwnerId() ?? 0,
    };
};

const createWorkerBenchmarkConnection = async (
    options: BenchmarkConnectionOptions,
    workerUrl: string,
    label: string
): Promise<BenchmarkConnection> => {
    const worker = new Worker(workerUrl, { name: `mwa-benchmark-${label}`, type: 'module' });
    const remote = Comlink.wrap<BenchmarkWorkerApi>(worker);

    try {
        await remote.init(options);
    } catch (error) {
        worker.terminate();
        remote[Comlink.releaseProxy]();
        throw error;
    }

    return {
        async close() {
            try {
                await remote.close();
            } finally {
                remote[Comlink.releaseProxy]();
                worker.terminate();
            }
        },
        execute: (sql) => remote.execute(sql),
    };
};

const runOnConnection = async <T>(connection: NamedConnection, operation: () => Promise<T>) => {
    connection.active += 1;
    const previous = connection.tail;
    let release: () => void = () => undefined;
    connection.tail = new Promise<void>((resolve) => {
        release = resolve;
    });

    try {
        await previous;
        return await operation();
    } finally {
        connection.active -= 1;
        release();
    }
};

type PoolOptions = BenchmarkConnectionOptions & {
    additionalReaders: number;
    useWebWorker: boolean;
    workerUrl: string;
};

class BenchmarkMemoryWriteAheadConnectionPool {
    readonly name: string;
    readonly #readers: NamedConnection[] = [];
    readonly #readersReady: Promise<void>;
    readonly #writer: Promise<NamedConnection>;

    constructor(private readonly options: PoolOptions) {
        this.name = options.dbFilename;
        this.#writer = this.#openConnection('writer');
        this.#readersReady = this.#writer.then(async () => {
            const readers = await Promise.all(
                Array.from({ length: options.additionalReaders }, (_, index) =>
                    this.#openConnection(`reader-${index + 1}`)
                )
            );
            this.#readers.push(...readers);
        });
    }

    async #openConnection(label: string): Promise<NamedConnection> {
        const connectionOptions = {
            ...this.options,
            initializePragmas: label === 'writer',
        };
        const connection = this.options.useWebWorker
            ? await createWorkerBenchmarkConnection(connectionOptions, this.options.workerUrl, label)
            : await createLocalBenchmarkConnection(connectionOptions);
        return { active: 0, connection, label, tail: Promise.resolve() };
    }

    async init() {
        await this.waitForAdditionalReaderPool();
    }

    async waitForAdditionalReaderPool() {
        await this.#readersReady;
    }

    async close() {
        await this.#readersReady.catch(() => undefined);
        const writer = await this.#writer;
        await Promise.all([writer.connection.close(), ...this.#readers.map((reader) => reader.connection.close())]);
    }

    async readLock<T>(fn: (tx: LockContext) => Promise<T>, _options?: DBLockOptions): Promise<T> {
        const writer = await this.#writer;
        const candidates = [...this.#readers, writer];
        const selected = candidates.reduce((current, candidate) =>
            candidate.active < current.active ? candidate : current
        );
        return runOnConnection(selected, () => fn(createLockContext(selected.connection)));
    }

    async writeLock<T>(fn: (tx: LockContext) => Promise<T>, _options?: DBLockOptions): Promise<T> {
        const writer = await this.#writer;
        return runOnConnection(writer, () => fn(createLockContext(writer.connection)));
    }

    async refreshSchema() {
        await this.#readersReady;
        const writer = await this.#writer;
        await Promise.all(
            [writer, ...this.#readers].map((connection) =>
                runOnConnection(connection, async () => {
                    await connection.connection.execute('PRAGMA schema_version');
                    await connection.connection.execute('PRAGMA temp_store = memory');
                    await connection.connection.execute(`PRAGMA cache_size = -${this.options.cacheSizeKiB}`);
                    if (connection.label !== 'writer') {
                        await connection.connection.execute('PRAGMA query_only = ON');
                    }
                })
            )
        );
    }

    registerListener(_listener: Partial<DBAdapterListener>) {
        return () => undefined;
    }
}

const BenchmarkMemoryWriteAheadAdapter = DBAdapterDefaultMixin(BenchmarkMemoryWriteAheadConnectionPool);

export const createMemoryWriteAheadBenchmarkDatabase = (options: PoolOptions) =>
    new BenchmarkMemoryWriteAheadAdapter(options);
