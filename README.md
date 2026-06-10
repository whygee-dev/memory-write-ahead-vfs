# memory-write-ahead-vfs

SharedArrayBuffer-backed in-memory write-ahead VFS for [`@journeyapps/wa-sqlite`](https://github.com/powersync-ja/wa-sqlite).

It provides one shared, named, in-memory SQLite runtime that can be structured-cloned into dedicated workers. Main database bytes and write-ahead files live in segmented `SharedArrayBuffer`s, while transaction overlay, snapshot isolation, and checkpointing are delegated to wa-sqlite's `WriteAhead` helper.

Originally developed for internal use at Beeldi; this standalone package contains only the generic VFS.

## Motivation

wa-sqlite's in-memory VFS examples store their bytes in one JavaScript context: a database created in one worker is invisible to every other worker. The common workarounds are to proxy every statement through a single owner worker over `postMessage` (serializing each query and result, and funneling all work through one thread) or to switch to persistent storage such as OPFS or IndexedDB (paying real file I/O and exclusive access-handle coordination for data that never needed to outlive the page).

This library targets the gap between those options: an ephemeral SQLite database that several dedicated workers read and write concurrently at memory speed — caches, scratch stores, staging areas, and query workspaces.

### Why SharedArrayBuffer

- `SharedArrayBuffer` is the only browser primitive that lets multiple workers map the same memory. Structured-cloning the runtime shares the underlying bytes instead of copying them, so every worker runs its own SQLite WASM instance directly against a single copy of the database.
- SQLite's VFS interface is synchronous, so cross-worker coordination cannot `await`. `Atomics` over shared memory provide the compare-and-swap file locks and — in dedicated workers — the blocking `Atomics.wait` the lock protocol needs. This is also why contended locks require dedicated workers and why cross-origin isolation is a hard requirement.
- Each query is a plain synchronous WASM call against shared bytes: no per-statement message round-trip, no result serialization, no single-owner bottleneck.

### Why growable SharedArrayBuffer

A plain `SharedArrayBuffer` is fixed-size at construction, which forces a bad choice for a database with a large ceiling: either commit the maximum capacity up front (hundreds of MiB for a mostly-small database), or re-allocate bigger buffers as data grows and re-broadcast the new handles to every worker mid-flight, copying bytes and re-coordinating every open connection.

`SharedArrayBuffer.prototype.grow` removes that dilemma. Buffers start at the initial capacity and grow in place up to `maxByteLength`, and every worker that already holds the runtime observes the new length immediately — no re-sharing, no copies. Files are split into segments so each buffer's reservation stays bounded, and write-ahead segments past the logical end drop out of the active set after `PRAGMA wal_checkpoint(TRUNCATE)` (tracked in diagnostics; the underlying allocation is not returned to the OS, since shared buffers cannot shrink).

On engines without growable `SharedArrayBuffer`, `allowFixedCapacityFallback: true` restores the fixed-size strategy at the cost of allocating each file's max capacity immediately.

## Runtime requirements

- Browser context with `SharedArrayBuffer` and growable `SharedArrayBuffer` support.
- Cross-origin isolation for pages and module workers that use the runtime:
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- Dedicated workers for blocking lock contention. Opening on the main thread is useful for simple flows, but a contended file lock on the main thread throws instead of blocking.
- wa-sqlite `>=1.7.0`.

This VFS is ephemeral. It does not persist data across page reloads, tab closes, crashes, or process restarts.
If growable `SharedArrayBuffer` is unavailable, `allowFixedCapacityFallback: true` uses fixed buffers allocated at each file's max capacity.

## Install

```bash
pnpm add memory-write-ahead-vfs @journeyapps/wa-sqlite
```

## Minimal usage

```ts
import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import {
  MEMORY_WRITE_AHEAD_VFS,
  MemoryWriteAheadVFS,
  createMemoryWriteAheadSharedRuntime,
} from 'memory-write-ahead-vfs';

const dbFilename = '/app.sqlite';
const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
const module = await waSqliteModuleFactory();
const sqlite3 = SQLite.Factory(module);
const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, runtime);

sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
const db = await sqlite3.open_v2(dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
await sqlite3.exec(db, 'PRAGMA journal_mode=WAL');
await sqlite3.exec(db, 'CREATE TABLE rows (value TEXT NOT NULL)');
await sqlite3.exec(db, "INSERT INTO rows VALUES ('hello')");
await sqlite3.close(db);
```

`SQLiteVFS` is declared globally by wa-sqlite's type definitions; it is not exported from the `@journeyapps/wa-sqlite` module.
SQLite may report `delete` after `PRAGMA journal_mode=WAL` because this VFS rejects native `-wal` files and delegates write-ahead behavior to wa-sqlite's in-memory `WriteAhead` helper over shared `-wa0`/`-wa1` files.

## Worker usage

Share the runtime with dedicated workers by structured-cloning it in `postMessage`.
Create a VFS for each concurrent SQLite connection; share the runtime object, not a `MemoryWriteAheadVFS` instance.
A VFS instance can reopen the same database after close, but it rejects two simultaneous main-database handles for the same filename.

```ts
// main.ts
import { createMemoryWriteAheadSharedRuntime } from 'memory-write-ahead-vfs';

const dbFilename = '/app.sqlite';
const runtime = createMemoryWriteAheadSharedRuntime(dbFilename);
const worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' });

worker.postMessage({ dbFilename, runtime, rows: ['alpha', 'beta'] });
```

```ts
// sqlite-worker.ts
import * as SQLite from '@journeyapps/wa-sqlite';
import waSqliteModuleFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import {
  MEMORY_WRITE_AHEAD_VFS,
  MemoryWriteAheadVFS,
  type MemoryWriteAheadSharedRuntime,
} from 'memory-write-ahead-vfs';

const quoteSqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

self.onmessage = async (
  event: MessageEvent<{ dbFilename: string; runtime: MemoryWriteAheadSharedRuntime; rows: string[] }>
) => {
  const module = await waSqliteModuleFactory();
  const sqlite3 = SQLite.Factory(module);
  const vfs = await MemoryWriteAheadVFS.create(MEMORY_WRITE_AHEAD_VFS, module, event.data.runtime);

  sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
  const db = await sqlite3.open_v2(event.data.dbFilename, undefined, MEMORY_WRITE_AHEAD_VFS);
  try {
    await sqlite3.exec(db, 'PRAGMA journal_mode=WAL');
    await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS rows (value TEXT NOT NULL)');
    for (const value of event.data.rows) {
      await sqlite3.exec(db, `INSERT INTO rows VALUES (${quoteSqlText(value)})`);
    }
    self.postMessage({ ok: true });
  } finally {
    await sqlite3.close(db);
  }
};
```

Your development and production servers must send the COOP/COEP headers above for the page and worker/module assets; otherwise browsers disable `SharedArrayBuffer`.

## Locking model

File locks are cooperative and heartbeat-based. During long writes and truncates the VFS refreshes the lock heartbeat; if a holder makes no progress for longer than `fileLockStaleMs`, a waiting worker may recover the lock. Tune `fileLockStaleMs` above your worst expected GC pause, tab throttling delay, and write workload duration.

## Capacity options

```ts
createMemoryWriteAheadSharedRuntime('/app.sqlite', {
  initialDatabaseCapacityBytes: 16 * 1024 * 1024,
  maxDatabaseCapacityBytes: 1024 * 1024 * 1024,
  initialWriteAheadCapacityBytes: 8 * 1024 * 1024,
  maxWriteAheadCapacityBytes: 512 * 1024 * 1024,
  fileLockStaleMs: 30_000,
  allowFixedCapacityFallback: false,
});
```

If a file exceeds its max capacity, writes fail clearly rather than corrupting memory.
Capacity values must be positive safe integers and cannot exceed `2_147_483_647` bytes because file metadata is stored in atomic `Int32Array` slots.

## Diagnostics

```ts
import { getMemoryWriteAheadRuntimeDiagnostics } from 'memory-write-ahead-vfs';

const diagnostics = getMemoryWriteAheadRuntimeDiagnostics('/app.sqlite');
```

Diagnostics include logical file sizes, segment counts, reclaimed capacity, lock state, open handle counts, and stale-lock recovery counters.

Pass `logger` to `MemoryWriteAheadVFS.create(..., { logger })` for structured debug/error output. `vfs.lastError`
keeps the last VFS-layer exception for SQLite's `xGetLastError`, and `vfs.log` is a wa-sqlite trace sink toggled by
VFS pragmas; both are public for wa-sqlite compatibility, but application code should prefer the logger option.

## Development

```bash
pnpm install
pnpm exec playwright install chromium
pnpm check
pnpm build
pnpm test:browser
```

The browser integration tests run through Playwright against a Vite server with COOP/COEP headers enabled.
