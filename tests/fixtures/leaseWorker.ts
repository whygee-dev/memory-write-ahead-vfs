import { openMemoryWriteAheadDatabase } from './sqliteHarness.js';
import { getMemoryWriteAheadRuntimeOwnerId, type MemoryWriteAheadSharedRuntime } from '../../src/index.js';

type LeaseWorkerRequest = {
    attachedDbFilename?: string;
    dbFilename: string;
    runtime: MemoryWriteAheadSharedRuntime;
};

type LeaseWorkerResponse = { ok: true; ownerId: number } | { ok: false; message: string; stack?: string };

let keepAliveConnection: Awaited<ReturnType<typeof openMemoryWriteAheadDatabase>> | null = null;

self.onmessage = async (event: MessageEvent<LeaseWorkerRequest>) => {
    try {
        keepAliveConnection = await openMemoryWriteAheadDatabase(event.data.dbFilename, event.data.runtime);
        await keepAliveConnection.exec('PRAGMA journal_mode=WAL');
        if (event.data.attachedDbFilename) {
            await keepAliveConnection.exec(`ATTACH DATABASE '${event.data.attachedDbFilename}' AS secondary`);
            await keepAliveConnection.exec('PRAGMA secondary.cache_size=5');
            await keepAliveConnection.exec('BEGIN');
            await keepAliveConnection.exec('UPDATE secondary.attached_rows SET payload = zeroblob(3500)');
        }
        await keepAliveConnection.exec('CREATE TABLE IF NOT EXISTS lease_rows (value TEXT NOT NULL)');
        await keepAliveConnection.exec("INSERT INTO lease_rows (value) VALUES ('leased')");
        const ownerId = getMemoryWriteAheadRuntimeOwnerId(event.data.runtime);
        if (!ownerId) {
            throw new Error('MemoryWriteAhead runtime owner was not registered');
        }
        const response: LeaseWorkerResponse = { ok: true, ownerId };
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
