import { openMemoryWriteAheadDatabase } from './sqliteHarness.js';
import type { MemoryWriteAheadSharedRuntime } from '../../src/index.js';

type WorkerRequest = {
    dbFilename: string;
    id: number;
    rowsPerTransaction: number;
    runtime: MemoryWriteAheadSharedRuntime;
    transactions: number;
    writerId: number;
};

type WorkerResponse =
    | { id: number; ok: true; insertedRows: number }
    | { id: number; ok: false; message: string; stack?: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;

    try {
        const connection = await openMemoryWriteAheadDatabase(request.dbFilename, request.runtime);

        try {
            await connection.exec('PRAGMA busy_timeout=10000');
            await connection.exec('PRAGMA wal_autocheckpoint=0');
            await connection.exec('PRAGMA journal_size_limit=8192');

            for (let transactionIndex = 0; transactionIndex < request.transactions; transactionIndex += 1) {
                await connection.exec('BEGIN IMMEDIATE');
                try {
                    for (let rowIndex = 0; rowIndex < request.rowsPerTransaction; rowIndex += 1) {
                        const sequence = transactionIndex * request.rowsPerTransaction + rowIndex;
                        await connection.exec(
                            `INSERT INTO worker_rows (writer_id, sequence, payload) VALUES (${request.writerId}, ${sequence}, randomblob(4096))`
                        );
                    }
                    await connection.exec('COMMIT');
                } catch (error) {
                    await connection.exec('ROLLBACK').catch(() => undefined);
                    throw error;
                }
            }
        } finally {
            await connection.close();
        }

        const response: WorkerResponse = {
            id: request.id,
            ok: true,
            insertedRows: request.transactions * request.rowsPerTransaction,
        };
        await new Promise((resolve) => setTimeout(resolve, 0));
        self.postMessage(response);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const response: WorkerResponse = {
            id: request.id,
            ok: false,
            message: err.message,
            ...(err.stack ? { stack: err.stack } : {}),
        };
        self.postMessage(response);
    }
};
