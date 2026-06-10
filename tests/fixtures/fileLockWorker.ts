import { acquireMemoryWriteAheadFileLock, releaseMemoryWriteAheadFileLock } from '../../src/MemoryWriteAheadVFS.js';
import { MEMORY_WRITE_AHEAD_FILE_META } from '../../src/memoryWriteAheadSharedRuntime.js';

type FileLockWorkerRequest = {
    meta: SharedArrayBuffer;
    mode: 'acquire' | 'hold';
    ownerId: number;
    staleMs: number;
};

type FileLockWorkerResponse =
    | { ok: true; lockState: number; mode: 'acquire' | 'hold'; ownerId: number }
    | { ok: false; message: string; stack?: string };

self.onmessage = (event: MessageEvent<FileLockWorkerRequest>) => {
    const request = event.data;
    const view = new Int32Array(request.meta);

    try {
        acquireMemoryWriteAheadFileLock(view, request.ownerId, request.staleMs);
        const lockState = Atomics.load(view, MEMORY_WRITE_AHEAD_FILE_META.lock);

        if (request.mode === 'acquire') {
            releaseMemoryWriteAheadFileLock(view, request.ownerId);
        }

        const response: FileLockWorkerResponse = {
            lockState,
            mode: request.mode,
            ok: true,
            ownerId: request.ownerId,
        };
        self.postMessage(response);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const response: FileLockWorkerResponse = {
            ok: false,
            message: err.message,
            ...(err.stack ? { stack: err.stack } : {}),
        };
        self.postMessage(response);
    }
};
