import { type DBAdapter, type LockContext } from '@powersync/common';

type BenchmarkArmName =
    | 'powersync-memory-vfs-1'
    | 'memory-write-ahead-1'
    | 'memory-write-ahead-2'
    | 'memory-write-ahead-3'
    | 'memory-write-ahead-4';

type BenchmarkArm = {
    additionalReaders: number;
    connectionCount: number;
    name: BenchmarkArmName;
    vfs: 'InMemoryVFS' | 'MemoryWriteAheadVFS';
};

type DatabaseOptions = {
    additionalReaders: number;
    dbFilename: string;
    workerUrl: string;
};

export type MemoryDatabaseStackBenchmarkRuntime = {
    cacheSizeKiB: number;
    createInMemoryDatabase: (options: { dbFilename: string }) => DBAdapter;
    createMemoryWriteAheadDatabase: (options: DatabaseOptions) => DBAdapter;
    harness: {
        powerSyncUseWebWorker: boolean;
        memoryWriteAheadUseWebWorker: boolean;
        webServer: 'vite-development';
    };
    onProgress: (message: string) => void;
    resetMemoryWriteAheadRuntime: () => void;
    versions: {
        memoryWriteAheadVfs: string;
        playwright: string;
        powerSyncCommon: string;
        powerSyncWeb: string;
        vite: string;
        waSqlite: string;
    };
    workerUrl: string;
};

type BenchmarkSamples = {
    burstMs: number[];
    firstReadMs: number[];
    firstWriteMs: number[];
    mixedReadMs: number[];
    mixedWriteMs: number[];
    poolReadyMs: number[];
    seedMs: number[];
    sequentialMs: number[];
};

type BenchmarkSummary = {
    max: number;
    mean: number;
    min: number;
    p50: number;
    p95: number;
    samples: number;
};

type QueryResultBaseline = {
    armName: BenchmarkArmName;
    fingerprints: readonly string[];
};

type QueryResultBaselineState = {
    current?: QueryResultBaseline;
};

export type MemoryDatabaseStackBenchmarkArmResult = {
    additionalReaderCount: number;
    aggregateCacheSizeKiB: number;
    burst: BenchmarkSummary;
    firstRead: BenchmarkSummary;
    firstWrite: BenchmarkSummary;
    mixedRead: BenchmarkSummary;
    mixedWrite: BenchmarkSummary;
    name: BenchmarkArmName;
    connectionCount: number;
    poolReady: BenchmarkSummary;
    seed: BenchmarkSummary;
    sequential: BenchmarkSummary;
    vfs: BenchmarkArm['vfs'];
};

export type MemoryDatabaseStackComparisonBenchmarkResult = {
    arms: MemoryDatabaseStackBenchmarkArmResult[];
    comparisonScope: 'implementation-stack';
    configuration: {
        burstTrials: number;
        cacheSizeKiB: number;
        correctnessValidation: readonly [
            'dataset-row-counts',
            'cross-arm-full-result-sha256',
            'per-trial-checksum',
            'write-row-count',
            'final-write-values',
            'additional-reader-query-only',
        ];
        dataset: typeof DATASET;
        mixedTrials: number;
        openPasses: number;
        queriesPerTrial: number;
        sequentialTrials: number;
        warmupTrials: number;
        workloadPasses: number;
    };
    environment: {
        crossOriginIsolated: boolean;
        hardwareConcurrency: number;
        userAgent: string;
    };
    generatedAt: string;
    harness: MemoryDatabaseStackBenchmarkRuntime['harness'];
    runtimeVersions: MemoryDatabaseStackBenchmarkRuntime['versions'];
    schemaVersion: 1;
};

const DATASET = {
    collections: 30,
    runs: 12,
    recordsPerCollection: 1_000,
    labelsPerCollection: 100,
    groups: 6,
} as const;
const WARMUP_TRIALS = 2;
const SEQUENTIAL_TRIALS = 10;
const BURST_TRIALS = 12;
const MIXED_TRIALS = 8;
const WORKLOAD_PASSES = 10;
const OPEN_PASSES = 30;

const ARMS: readonly BenchmarkArm[] = [
    { additionalReaders: 0, connectionCount: 1, name: 'powersync-memory-vfs-1', vfs: 'InMemoryVFS' },
    { additionalReaders: 0, connectionCount: 1, name: 'memory-write-ahead-1', vfs: 'MemoryWriteAheadVFS' },
    { additionalReaders: 1, connectionCount: 2, name: 'memory-write-ahead-2', vfs: 'MemoryWriteAheadVFS' },
    { additionalReaders: 2, connectionCount: 3, name: 'memory-write-ahead-3', vfs: 'MemoryWriteAheadVFS' },
    { additionalReaders: 3, connectionCount: 4, name: 'memory-write-ahead-4', vfs: 'MemoryWriteAheadVFS' },
];

const TARGET_COLLECTION_IDS = Array.from(
    { length: 12 },
    (_, index) => `collection-${String(index + 1).padStart(3, '0')}`
);
const TARGET_RUN_IDS = Array.from({ length: 8 }, (_, index) => `run-${String(index + 1).padStart(3, '0')}`);
const inList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

const READ_QUERIES = [
    `
      SELECT l.id, l.collectionId, l."order", l.name
      FROM label l
      WHERE l.accountId = 'account-01'
        AND l.nodeLevel = 3
        AND l.collectionId IN (${inList(TARGET_COLLECTION_IDS)})
        AND l.deletedAt IS NULL
      ORDER BY l."order" ASC
      LIMIT 500
    `,
    `
      SELECT c.id, c.groupId
      FROM run c
      WHERE c.accountId = 'account-01'
        AND c.deletedAt IS NULL
        AND EXISTS (
          SELECT 1
          FROM collection_to_group bw
          WHERE bw.B = c.groupId
            AND bw.A IN (${inList(TARGET_COLLECTION_IDS)})
        )
      ORDER BY c.createdAt ASC
    `,
    `
      SELECT e.collectionId, COUNT(*) AS recordCount
      FROM record e
      WHERE e.collectionId IN (${inList(TARGET_COLLECTION_IDS)})
        AND e.deletedAt IS NULL
      GROUP BY e.collectionId
      ORDER BY e.collectionId
    `,
    `
      SELECT e.status, e.category, COUNT(*) AS recordCount
      FROM record e
      WHERE e.collectionId IN (${inList(TARGET_COLLECTION_IDS)})
        AND e.deletedAt IS NULL
        AND e.archivedAt IS NULL
      GROUP BY e.status, e.category
      ORDER BY e.status, e.category
    `,
    `
      WITH run_scoped_collections AS (
        SELECT c.id AS runId, bw.A AS collectionId
        FROM run c
        INNER JOIN collection_to_group bw ON bw.B = c.groupId
        WHERE c.id IN (${inList(TARGET_RUN_IDS)})
          AND bw.A IN (${inList(TARGET_COLLECTION_IDS)})
      )
      SELECT
        csb.runId,
        csb.collectionId,
        COUNT(DISTINCT e.id) AS totalRecords,
        COUNT(DISTINCT CASE WHEN ce.state = 'DONE' THEN ce.recordId END) AS doneRecords,
        COUNT(DISTINCT CASE WHEN ce.state IN ('DONE', 'ONGOING') THEN ce.recordId END) AS ongoingOrDoneRecords,
        MAX(CASE WHEN cb.id IS NOT NULL THEN 1 ELSE 0 END) AS collectionCompleted
      FROM run_scoped_collections csb
      LEFT JOIN record e ON e.collectionId = csb.collectionId AND e.deletedAt IS NULL
      LEFT JOIN run_record ce
        ON ce.recordId = e.id
        AND ce.runId = csb.runId
        AND ce.deletedAt IS NULL
      LEFT JOIN run_collection cb
        ON cb.collectionId = csb.collectionId
        AND cb.runId = csb.runId
      GROUP BY csb.runId, csb.collectionId
      ORDER BY csb.runId, csb.collectionId
    `,
    `
      SELECT ce.runId, ce.state, COUNT(*) AS recordCount
      FROM run_record ce
      WHERE ce.runId IN (${inList(TARGET_RUN_IDS)})
        AND ce.deletedAt IS NULL
      GROUP BY ce.runId, ce.state
      ORDER BY ce.runId, ce.state
    `,
    `
      SELECT bw.B AS groupId, COUNT(DISTINCT e.id) AS recordCount
      FROM collection_to_group bw
      INNER JOIN record e ON e.collectionId = bw.A
      WHERE bw.A IN (${inList(TARGET_COLLECTION_IDS)})
        AND e.deletedAt IS NULL
      GROUP BY bw.B
      ORDER BY bw.B
    `,
    `
      SELECT
        COUNT(*) AS activeRecordCount,
        SUM(CASE WHEN e.imported = 1 THEN 1 ELSE 0 END) AS importedRecordCount,
        SUM(CASE WHEN e.status = 'UNTRACEABLE' THEN 1 ELSE 0 END) AS untraceableRecordCount
      FROM record e
      WHERE e.collectionId IN (${inList(TARGET_COLLECTION_IDS)})
        AND e.deletedAt IS NULL
        AND e.archivedAt IS NULL
    `,
] as const;

const createEmptySamples = (): BenchmarkSamples => ({
    burstMs: [],
    firstReadMs: [],
    firstWriteMs: [],
    mixedReadMs: [],
    mixedWriteMs: [],
    poolReadyMs: [],
    seedMs: [],
    sequentialMs: [],
});

const round = (value: number) => Math.round(value * 100) / 100;
const summarize = (samples: readonly number[]): BenchmarkSummary => {
    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = (value: number) =>
        sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;

    return {
        max: round(sorted.at(-1) ?? 0),
        mean: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
        min: round(sorted[0] ?? 0),
        p50: round(percentile(0.5)),
        p95: round(percentile(0.95)),
        samples: sorted.length,
    };
};

const executeStatements = async (tx: LockContext, statements: readonly string[]) => {
    await statements.reduce<Promise<void>>(
        (previous, statement) => previous.then(async () => void (await tx.execute(statement))),
        Promise.resolve()
    );
};

const resetRuntimeForArm = (arm: BenchmarkArm, runtime: MemoryDatabaseStackBenchmarkRuntime) => {
    if (arm.vfs === 'MemoryWriteAheadVFS') {
        runtime.resetMemoryWriteAheadRuntime();
    }
};

const armFilenameCode = (arm: BenchmarkArm) => (arm.vfs === 'InMemoryVFS' ? 'im' : `mw${arm.additionalReaders}`);

const openDatabase = (
    arm: BenchmarkArm,
    pass: number,
    purpose: 'first-read' | 'first-write' | 'pool-ready',
    runtime: MemoryDatabaseStackBenchmarkRuntime
) => {
    const dbFilename = `ms-${armFilenameCode(arm)}-${purpose}-${pass}-${crypto.randomUUID().slice(0, 8)}.db`;

    return arm.vfs === 'InMemoryVFS'
        ? runtime.createInMemoryDatabase({ dbFilename })
        : runtime.createMemoryWriteAheadDatabase({
              additionalReaders: arm.additionalReaders,
              dbFilename,
              workerUrl: runtime.workerUrl,
          });
};

const closeDatabase = async (arm: BenchmarkArm, database: DBAdapter, runtime: MemoryDatabaseStackBenchmarkRuntime) => {
    await Promise.resolve(database.close()).catch(() => undefined);
    resetRuntimeForArm(arm, runtime);
};

const measureFirstOperation = async (
    arm: BenchmarkArm,
    pass: number,
    operation: 'first-read' | 'first-write',
    runtime: MemoryDatabaseStackBenchmarkRuntime
) => {
    const startedAt = performance.now();
    const database = openDatabase(arm, pass, operation, runtime);

    try {
        if (operation === 'first-read') {
            await database.readLock((tx) => tx.execute('SELECT 1'));
        } else {
            await database.writeLock((tx) =>
                tx.execute('CREATE TABLE benchmark_open_probe (id INTEGER PRIMARY KEY, value TEXT)')
            );
        }

        return performance.now() - startedAt;
    } finally {
        await closeDatabase(arm, database, runtime);
    }
};

const createPoolReadyDatabase = async (
    arm: BenchmarkArm,
    pass: number,
    runtime: MemoryDatabaseStackBenchmarkRuntime
) => {
    const startedAt = performance.now();
    const database = openDatabase(arm, pass, 'pool-ready', runtime);

    try {
        const waitForAdditionalReaderPool = Reflect.get(database, 'waitForAdditionalReaderPool');
        const init = Reflect.get(database, 'init');

        if (typeof waitForAdditionalReaderPool === 'function') {
            await waitForAdditionalReaderPool.call(database);
        } else if (typeof init === 'function') {
            await init.call(database);
        } else {
            throw new Error(`${arm.name} adapter does not expose a readiness method`);
        }

        return {
            database,
            poolReadyMs: performance.now() - startedAt,
        };
    } catch (error) {
        await closeDatabase(arm, database, runtime);
        throw error;
    }
};

const createDatabase = async (arm: BenchmarkArm, pass: number, runtime: MemoryDatabaseStackBenchmarkRuntime) => {
    try {
        const firstReadMs = await measureFirstOperation(arm, pass, 'first-read', runtime);
        const firstWriteMs = await measureFirstOperation(arm, pass, 'first-write', runtime);
        const { database, poolReadyMs } = await createPoolReadyDatabase(arm, pass, runtime);

        return {
            database,
            firstReadMs,
            firstWriteMs,
            poolReadyMs,
        };
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
        runtime.onProgress(`${arm.name} pass ${pass}: startup probe failed with SQLite code ${code}`);
        throw error;
    }
};

const seedDatabase = async (database: DBAdapter) => {
    const totalRecords = DATASET.collections * DATASET.recordsPerCollection;
    const totalLabels = DATASET.collections * DATASET.labelsPerCollection;

    await database.writeLock((tx) =>
        executeStatements(tx, [
            'CREATE TABLE collection (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, sourceId TEXT NOT NULL, deletedAt INTEGER)',
            'CREATE TABLE label (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, nodeLevel INTEGER NOT NULL, collectionId TEXT NOT NULL, parentId TEXT, "order" INTEGER NOT NULL, deletedAt INTEGER, name TEXT NOT NULL)',
            'CREATE TABLE run (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, groupId TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER)',
            'CREATE TABLE collection_to_group (id TEXT PRIMARY KEY, A TEXT NOT NULL, B TEXT NOT NULL)',
            'CREATE TABLE record (id TEXT PRIMARY KEY, collectionId TEXT NOT NULL, deletedAt INTEGER, archivedAt INTEGER, imported INTEGER NOT NULL, status TEXT NOT NULL, category TEXT NOT NULL)',
            'CREATE TABLE run_record (id TEXT PRIMARY KEY, runId TEXT NOT NULL, recordId TEXT NOT NULL, state TEXT NOT NULL, deletedAt INTEGER)',
            'CREATE TABLE run_collection (id TEXT PRIMARY KEY, runId TEXT NOT NULL, collectionId TEXT NOT NULL)',
            `
              WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${DATASET.collections})
              INSERT INTO collection (id, accountId, sourceId, deletedAt)
              SELECT printf('collection-%03d', n), 'account-01', printf('source-collection-%03d', n), NULL FROM seq
            `,
            `
              WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${DATASET.collections})
              INSERT INTO collection_to_group (id, A, B)
              SELECT
                printf('collection-%03d.group-%02d', n, ((n - 1) % ${DATASET.groups}) + 1),
                printf('collection-%03d', n),
                printf('group-%02d', ((n - 1) % ${DATASET.groups}) + 1)
              FROM seq
            `,
            `
              WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${DATASET.runs})
              INSERT INTO run (id, accountId, groupId, createdAt, deletedAt)
              SELECT
                printf('run-%03d', n),
                'account-01',
                printf('group-%02d', ((n - 1) % ${DATASET.groups}) + 1),
                n,
                NULL
              FROM seq
            `,
            `
              WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${totalLabels})
              INSERT INTO label (id, accountId, nodeLevel, collectionId, parentId, "order", deletedAt, name)
              SELECT
                printf('label-%06d', n),
                'account-01',
                CASE WHEN n % 5 = 0 THEN 4 ELSE 3 END,
                printf('collection-%03d', ((n - 1) / ${DATASET.labelsPerCollection}) + 1),
                NULL,
                ((n - 1) % ${DATASET.labelsPerCollection}) + 1,
                CASE WHEN n % 97 = 0 THEN 1 ELSE NULL END,
                printf('Label %06d', n)
              FROM seq
            `,
            `
              WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${totalRecords})
              INSERT INTO record (id, collectionId, deletedAt, archivedAt, imported, status, category)
              SELECT
                printf('record-%06d', n),
                printf('collection-%03d', ((n - 1) / ${DATASET.recordsPerCollection}) + 1),
                CASE WHEN n % 151 = 0 THEN 1 ELSE NULL END,
                CASE WHEN n % 37 = 0 THEN 1 ELSE NULL END,
                CASE WHEN n % 3 = 0 THEN 1 ELSE 0 END,
                CASE n % 5 WHEN 0 THEN 'DEPOSIT' WHEN 1 THEN 'UNTRACEABLE' ELSE 'ACTIVE' END,
                CASE n % 4 WHEN 0 THEN 'CONFIRMED' WHEN 1 THEN 'EXCLUDED' ELSE 'PENDING' END
              FROM seq
            `,
            `
              INSERT INTO run_record (id, runId, recordId, state, deletedAt)
              SELECT
                c.id || '.' || e.id,
                c.id,
                e.id,
                CASE ((CAST(substr(e.id, 11) AS INTEGER) + c.createdAt) % 3)
                  WHEN 0 THEN 'DONE'
                  WHEN 1 THEN 'ONGOING'
                  ELSE 'TODO'
                END,
                NULL
              FROM run c
              INNER JOIN collection_to_group bw ON bw.B = c.groupId
              INNER JOIN record e ON e.collectionId = bw.A
              WHERE (CAST(substr(e.id, 11) AS INTEGER) % 2) = (c.createdAt % 2)
            `,
            `
              INSERT INTO run_collection (id, runId, collectionId)
              SELECT c.id || '.' || bw.A, c.id, bw.A
              FROM run c
              INNER JOIN collection_to_group bw ON bw.B = c.groupId
              WHERE ((CAST(substr(bw.A, 10) AS INTEGER) + c.createdAt) % 5) = 0
            `,
            'CREATE INDEX idx_label_account_node_deleted_order ON label(accountId, nodeLevel, deletedAt, "order")',
            'CREATE INDEX idx_label_collection ON label(collectionId)',
            'CREATE INDEX idx_run_account_deleted_created ON run(accountId, deletedAt, createdAt)',
            'CREATE INDEX idx_btw_group_collection ON collection_to_group(B, A)',
            'CREATE INDEX idx_record_collection_deleted ON record(collectionId, deletedAt)',
            'CREATE INDEX idx_run_record_run_record_deleted ON run_record(runId, recordId, deletedAt, state)',
            'CREATE INDEX idx_run_collection_run_collection ON run_collection(runId, collectionId)',
        ])
    );
};

const queryChecksum = (rows: readonly Record<string, unknown>[]) =>
    rows.reduce(
        (sum, row) =>
            sum +
            Object.values(row).reduce<number>(
                (rowSum, value) => rowSum + (typeof value === 'number' ? value : String(value ?? '').length),
                0
            ),
        0
    );

const serializeQueryResultValue = (value: unknown): readonly unknown[] => {
    if (value === null) {
        return ['null'];
    }
    if (value instanceof Uint8Array) {
        return ['blob', ...value];
    }
    if (typeof value === 'bigint') {
        return ['bigint', value.toString()];
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return [typeof value, value];
    }

    throw new Error(`Unsupported benchmark query result value: ${Object.prototype.toString.call(value)}`);
};

const fingerprintQueryRows = async (rows: readonly Record<string, unknown>[]) => {
    const canonicalRows = rows.map((row) =>
        JSON.stringify(
            Object.entries(row)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([column, value]) => [column, ...serializeQueryResultValue(value)])
        )
    );
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalRows)))
    );

    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const fingerprintReadQueryResults = (database: DBAdapter) =>
    READ_QUERIES.reduce<Promise<string[]>>(
        (previous, sql) =>
            previous.then(async (fingerprints) => {
                const result = await database.readLock((tx) => tx.execute(sql));
                const rows = (result.rows?._array ?? []) as Record<string, unknown>[];
                fingerprints.push(await fingerprintQueryRows(rows));
                return fingerprints;
            }),
        Promise.resolve([])
    );

const validateCrossArmQueryResults = async (
    arm: BenchmarkArm,
    database: DBAdapter,
    baselineState: QueryResultBaselineState
) => {
    const fingerprints = await fingerprintReadQueryResults(database);
    const baseline = baselineState.current;

    if (!baseline) {
        baselineState.current = { armName: arm.name, fingerprints };
        return;
    }

    const mismatchedQueries = fingerprints.flatMap((fingerprint, index) =>
        fingerprint === baseline.fingerprints[index] ? [] : [index + 1]
    );
    if (mismatchedQueries.length > 0) {
        throw new Error(
            `${arm.name} query results differ from ${baseline.armName} for queries ${mismatchedQueries.join(', ')}`
        );
    }
};

const executeRead = (database: DBAdapter, sql: string) =>
    database.readLock(async (tx) => {
        const result = await tx.execute(sql);
        const rows = (result.rows?._array ?? []) as Record<string, unknown>[];
        return rows.length + queryChecksum(rows);
    });

const runSequentialTrial = async (database: DBAdapter) => {
    const startedAt = performance.now();
    const checksums = await READ_QUERIES.reduce<Promise<number[]>>(
        (previous, sql) =>
            previous.then(async (values) => {
                values.push(await executeRead(database, sql));
                return values;
            }),
        Promise.resolve([])
    );

    return {
        checksum: checksums.reduce((sum, value) => sum + value, 0),
        elapsedMs: performance.now() - startedAt,
    };
};

const runBurstTrial = async (database: DBAdapter) => {
    const startedAt = performance.now();
    const checksums = await Promise.all(READ_QUERIES.map((sql) => executeRead(database, sql)));

    return {
        checksum: checksums.reduce((sum, value) => sum + value, 0),
        elapsedMs: performance.now() - startedAt,
    };
};

const runWriteTrial = async (database: DBAdapter, iteration: number) => {
    const startedAt = performance.now();

    const result = await database.writeLock((tx) =>
        tx.execute(`
          UPDATE label
          SET parentId = CASE parentId
            WHEN 'benchmark-parent-a' THEN 'benchmark-parent-b'
            ELSE 'benchmark-parent-a'
          END
          WHERE id IN (
            SELECT id
            FROM label
            WHERE collectionId = 'collection-${String((iteration % DATASET.collections) + 1).padStart(3, '0')}'
            ORDER BY id
            LIMIT 40
          )
        `)
    );

    if (result.rowsAffected !== 40) {
        throw new Error(`Benchmark write updated ${result.rowsAffected} rows instead of 40`);
    }

    return performance.now() - startedAt;
};

const verifyDataset = async (database: DBAdapter) => {
    const result = await database.readLock((tx) =>
        tx.execute(`
          SELECT
            (SELECT COUNT(*) FROM collection) AS collections,
            (SELECT COUNT(*) FROM collection_to_group) AS collectionGroups,
            (SELECT COUNT(*) FROM run) AS runs,
            (SELECT COUNT(*) FROM record) AS records,
            (SELECT COUNT(*) FROM label) AS labels,
            (SELECT COUNT(*) FROM run_record) AS runRecords,
            (SELECT COUNT(*) FROM run_collection) AS runCollections
        `)
    );
    const row = (result.rows?._array?.[0] ?? {}) as Record<string, unknown>;

    if (
        Number(row.collections) !== DATASET.collections ||
        Number(row.collectionGroups) !== DATASET.collections ||
        Number(row.runs) !== DATASET.runs ||
        Number(row.records) !== DATASET.collections * DATASET.recordsPerCollection ||
        Number(row.labels) !== DATASET.collections * DATASET.labelsPerCollection ||
        Number(row.runRecords) !== 30_000 ||
        Number(row.runCollections) !== 10
    ) {
        throw new Error(`Benchmark dataset verification failed: ${JSON.stringify(row)}`);
    }
};

const verifyMixedWrites = async (database: DBAdapter) => {
    const result = await database.writeLock((tx) =>
        tx.execute(`
          SELECT COUNT(*) AS updatedLabels
          FROM label
          WHERE parentId = 'benchmark-parent-a'
            AND collectionId IN (${inList(
                Array.from({ length: MIXED_TRIALS }, (_, index) => `collection-${String(index + 1).padStart(3, '0')}`)
            )})
        `)
    );
    const row = (result.rows?._array?.[0] ?? {}) as Record<string, unknown>;
    if (Number(row.updatedLabels) !== MIXED_TRIALS * 40) {
        throw new Error(`Benchmark final write verification failed: ${JSON.stringify(row)}`);
    }
};

const verifyAdditionalReadersAreQueryOnly = async (arm: BenchmarkArm, database: DBAdapter) => {
    if (arm.vfs !== 'MemoryWriteAheadVFS' || arm.additionalReaders === 0) {
        return;
    }

    let rejected = false;
    try {
        await database.readLock((tx) =>
            tx.execute("UPDATE label SET parentId = 'unexpected-reader-write' WHERE id = 'label-000001'")
        );
    } catch (_error) {
        rejected = true;
    }

    if (!rejected) {
        throw new Error(`${arm.name} allowed a mutation through an additional reader`);
    }

    const result = await database.writeLock((tx) => tx.execute("SELECT parentId FROM label WHERE id = 'label-000001'"));
    const row = (result.rows?._array?.[0] ?? {}) as Record<string, unknown>;
    if (row.parentId !== null) {
        throw new Error(`${arm.name} changed data through an additional reader`);
    }
};

const runArmPass = async (
    arm: BenchmarkArm,
    pass: number,
    samples: BenchmarkSamples,
    runtime: MemoryDatabaseStackBenchmarkRuntime,
    queryResultBaselineState: QueryResultBaselineState
) => {
    runtime.onProgress(`${arm.name} pass ${pass}: measuring adapter startup`);
    const { database, firstReadMs, firstWriteMs, poolReadyMs } = await createDatabase(arm, pass, runtime);
    samples.firstReadMs.push(firstReadMs);
    samples.firstWriteMs.push(firstWriteMs);
    samples.poolReadyMs.push(poolReadyMs);

    try {
        runtime.onProgress(`${arm.name} pass ${pass}: seeding`);
        const seedStartedAt = performance.now();
        await seedDatabase(database);
        samples.seedMs.push(performance.now() - seedStartedAt);
        await database.refreshSchema();
        await verifyDataset(database);
        await verifyAdditionalReadersAreQueryOnly(arm, database);
        runtime.onProgress(`${arm.name} pass ${pass}: validating cross-arm query results`);
        await validateCrossArmQueryResults(arm, database, queryResultBaselineState);

        runtime.onProgress(`${arm.name} pass ${pass}: warming up`);
        const warmupChecksums = await Promise.all(
            Array.from({ length: WARMUP_TRIALS }, async () => (await runBurstTrial(database)).checksum)
        );
        const expectedChecksum = warmupChecksums[0];

        if (warmupChecksums.some((checksum) => checksum !== expectedChecksum)) {
            throw new Error(`${arm.name} produced inconsistent warmup checksums`);
        }

        runtime.onProgress(`${arm.name} pass ${pass}: sequential reads`);
        const sequentialPassMs: number[] = [];
        for (let trial = 0; trial < SEQUENTIAL_TRIALS; trial += 1) {
            const result = await runSequentialTrial(database);
            if (result.checksum !== expectedChecksum) {
                throw new Error(`${arm.name} produced an inconsistent sequential checksum`);
            }
            sequentialPassMs.push(result.elapsedMs);
        }
        samples.sequentialMs.push(...sequentialPassMs);

        runtime.onProgress(`${arm.name} pass ${pass}: burst reads`);
        const burstPassMs: number[] = [];
        for (let trial = 0; trial < BURST_TRIALS; trial += 1) {
            const result = await runBurstTrial(database);
            if (result.checksum !== expectedChecksum) {
                throw new Error(`${arm.name} produced an inconsistent burst checksum`);
            }
            burstPassMs.push(result.elapsedMs);
        }
        samples.burstMs.push(...burstPassMs);

        runtime.onProgress(`${arm.name} pass ${pass}: mixed reads and writes`);
        const mixedReadPassMs: number[] = [];
        const mixedWritePassMs: number[] = [];
        for (let trial = 0; trial < MIXED_TRIALS; trial += 1) {
            const [readResult, writeElapsedMs] = await Promise.all([
                runBurstTrial(database),
                runWriteTrial(database, trial),
            ]);
            if (readResult.checksum !== expectedChecksum) {
                throw new Error(`${arm.name} produced an inconsistent mixed-workload checksum`);
            }
            mixedReadPassMs.push(readResult.elapsedMs);
            mixedWritePassMs.push(writeElapsedMs);
        }
        samples.mixedReadMs.push(...mixedReadPassMs);
        samples.mixedWriteMs.push(...mixedWritePassMs);
        await verifyMixedWrites(database);
    } finally {
        runtime.onProgress(`${arm.name} pass ${pass}: closing`);
        await database.close();
        resetRuntimeForArm(arm, runtime);
        runtime.onProgress(`${arm.name} pass ${pass}: complete`);
    }
};

const runStartupOnlyPass = async (
    arm: BenchmarkArm,
    pass: number,
    samples: BenchmarkSamples,
    runtime: MemoryDatabaseStackBenchmarkRuntime
) => {
    runtime.onProgress(`${arm.name} pass ${pass}: measuring adapter startup`);
    const { database, firstReadMs, firstWriteMs, poolReadyMs } = await createDatabase(arm, pass, runtime);
    samples.firstReadMs.push(firstReadMs);
    samples.firstWriteMs.push(firstWriteMs);
    samples.poolReadyMs.push(poolReadyMs);
    await database.close();
    resetRuntimeForArm(arm, runtime);
    runtime.onProgress(`${arm.name} pass ${pass}: startup measurements complete`);
};

export const runMemoryDatabaseStackComparisonBenchmark = async (
    runtime: MemoryDatabaseStackBenchmarkRuntime
): Promise<MemoryDatabaseStackComparisonBenchmarkResult> => {
    const samplesByArm = new Map<BenchmarkArmName, BenchmarkSamples>(
        ARMS.map((arm) => [arm.name, createEmptySamples()])
    );
    const queryResultBaselineState: QueryResultBaselineState = {};

    for (let pass = 0; pass < OPEN_PASSES; pass += 1) {
        const offset = pass % ARMS.length;
        const rotatedArms = [...ARMS.slice(offset), ...ARMS.slice(0, offset)];
        const passArms = Math.floor(pass / ARMS.length) % 2 === 0 ? rotatedArms : rotatedArms.reverse();

        for (const arm of passArms) {
            const samples = samplesByArm.get(arm.name);
            if (!samples) {
                throw new Error(`Missing benchmark sample collector for ${arm.name}`);
            }
            if (pass < WORKLOAD_PASSES) {
                await runArmPass(arm, pass + 1, samples, runtime, queryResultBaselineState);
            } else {
                await runStartupOnlyPass(arm, pass + 1, samples, runtime);
            }
        }
    }

    return {
        arms: ARMS.map((arm) => {
            const samples = samplesByArm.get(arm.name) ?? createEmptySamples();
            return {
                additionalReaderCount: arm.additionalReaders,
                aggregateCacheSizeKiB: runtime.cacheSizeKiB * arm.connectionCount,
                burst: summarize(samples.burstMs),
                connectionCount: arm.connectionCount,
                firstRead: summarize(samples.firstReadMs),
                firstWrite: summarize(samples.firstWriteMs),
                mixedRead: summarize(samples.mixedReadMs),
                mixedWrite: summarize(samples.mixedWriteMs),
                name: arm.name,
                poolReady: summarize(samples.poolReadyMs),
                seed: summarize(samples.seedMs),
                sequential: summarize(samples.sequentialMs),
                vfs: arm.vfs,
            };
        }),
        comparisonScope: 'implementation-stack',
        configuration: {
            burstTrials: BURST_TRIALS,
            cacheSizeKiB: runtime.cacheSizeKiB,
            correctnessValidation: [
                'dataset-row-counts',
                'cross-arm-full-result-sha256',
                'per-trial-checksum',
                'write-row-count',
                'final-write-values',
                'additional-reader-query-only',
            ],
            dataset: DATASET,
            mixedTrials: MIXED_TRIALS,
            openPasses: OPEN_PASSES,
            queriesPerTrial: READ_QUERIES.length,
            sequentialTrials: SEQUENTIAL_TRIALS,
            warmupTrials: WARMUP_TRIALS,
            workloadPasses: WORKLOAD_PASSES,
        },
        environment: {
            crossOriginIsolated,
            hardwareConcurrency: navigator.hardwareConcurrency,
            userAgent: navigator.userAgent,
        },
        generatedAt: new Date().toISOString(),
        harness: runtime.harness,
        runtimeVersions: runtime.versions,
        schemaVersion: 1,
    };
};
