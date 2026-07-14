import * as Comlink from 'comlink';

import { createLocalBenchmarkConnection, type BenchmarkSqlResult, type BenchmarkWorkerApi } from './mwaConnection.js';

let connection: Awaited<ReturnType<typeof createLocalBenchmarkConnection>> | null = null;

const api: BenchmarkWorkerApi = {
    async close() {
        await connection?.close();
        connection = null;
    },
    async execute(sql: string): Promise<BenchmarkSqlResult> {
        if (!connection) {
            throw new Error('Memory Write-Ahead VFS benchmark worker is not initialized');
        }
        return connection.execute(sql);
    },
    async init(options) {
        if (connection) {
            throw new Error('Memory Write-Ahead VFS benchmark worker is already initialized');
        }
        connection = await createLocalBenchmarkConnection(options);
        return connection.ownerId;
    },
};

Comlink.expose(api);
