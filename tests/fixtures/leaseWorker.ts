import { openMemoryWriteAheadDatabase } from './sqliteHarness.js';
import type { MemoryWriteAheadSharedRuntime } from '../../src/index.js';

type LeaseWorkerRequest = {
    dbFilename: string;
    runtime: MemoryWriteAheadSharedRuntime;
};

type LeaseWorkerResponse = { ok: true } | { ok: false; message: string; stack?: string };

let keepAliveConnection: Awaited<ReturnType<typeof openMemoryWriteAheadDatabase>> | null = null;

self.onmessage = async (event: MessageEvent<LeaseWorkerRequest>) => {
    try {
        keepAliveConnection = await openMemoryWriteAheadDatabase(event.data.dbFilename, event.data.runtime);
        await keepAliveConnection.exec('PRAGMA journal_mode=WAL');
        await keepAliveConnection.exec('CREATE TABLE IF NOT EXISTS lease_rows (value TEXT NOT NULL)');
        await keepAliveConnection.exec("INSERT INTO lease_rows (value) VALUES ('leased')");
        const response: LeaseWorkerResponse = { ok: true };
        self.postMessage(response);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const response: LeaseWorkerResponse = {
            ok: false,
            message: err.message,
            ...(err.stack ? { stack: err.stack } : {}),
        };
        self.postMessage(response);
    }
};
