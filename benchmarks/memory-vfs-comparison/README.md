# Memory VFS implementation-stack benchmark

This benchmark compares PowerSync's public `InMemoryVFS` configuration with Memory Write-Ahead VFS connection pools. It measures the complete JavaScript stack used by each arm—adapter, worker transport, SQLite WASM, VFS, and pool routing—not an isolated VFS function call.

Latency is p50 / p95 in milliseconds. Lower is better.

## Primary comparison: workers enabled for both implementations

| Configuration                              | Sequential reads | Concurrent reads |   Mixed reads | Mixed write completion |     Pool ready |
| ------------------------------------------ | ---------------: | ---------------: | ------------: | ---------------------: | -------------: |
| PowerSync MemoryVFS — 1 connection         |    31.97 / 34.69 |    31.70 / 34.78 | 31.84 / 36.35 |          32.27 / 36.80 |  36.20 / 45.56 |
| Memory Write-Ahead VFS — 1 connection      |    31.71 / 35.76 |    31.43 / 34.05 | 31.47 / 33.25 |          31.89 / 33.76 |  42.39 / 49.74 |
| Memory Write-Ahead VFS — 2-connection pool |    31.64 / 34.69 |    18.34 / 19.85 | 19.30 / 22.86 |          13.77 / 16.36 |  74.39 / 89.62 |
| Memory Write-Ahead VFS — 3-connection pool |    31.91 / 34.32 |    16.17 / 18.88 | 16.69 / 19.68 |            7.99 / 9.51 |  80.16 / 96.01 |
| Memory Write-Ahead VFS — 4-connection pool |    31.49 / 35.02 |    15.09 / 17.69 | 15.93 / 18.02 |            7.06 / 8.55 | 87.64 / 104.61 |

Compared with the PowerSync MemoryVFS arm, the 3-connection Memory Write-Ahead VFS pool recorded:

- 49.0% lower median concurrent-read latency.
- 47.6% lower median mixed-read latency.
- 75.2% lower median mixed-workload write-completion latency.
- 0.2% lower median sequential latency.
- 43.96 ms more median pool-ready latency because three workers and SQLite instances are opened instead of one.

The 3-connection pool means one writer plus two additional readers. For throughput-focused desktop use, it is the startup/concurrency trade-off suggested by this run: the fourth connection improved median concurrent reads by 6.7% and mixed reads by 4.6%, while adding another worker and 7.48 ms of median pool-ready latency. This is not a memory-balanced conclusion; the aggregate cache ceilings are disclosed below.

[Full result](./results/both-workers.json)

### Connection and cache topology

Every SQLite connection receives the same configured 32 MiB page-cache ceiling. A pool therefore has a higher aggregate configured ceiling:

| Configuration                              | Total connections | Additional readers | Aggregate configured cache ceiling |
| ------------------------------------------ | ----------------: | -----------------: | ---------------------------------: |
| PowerSync MemoryVFS — 1 connection         |                 1 |                  0 |                             32 MiB |
| Memory Write-Ahead VFS — 1 connection      |                 1 |                  0 |                             32 MiB |
| Memory Write-Ahead VFS — 2-connection pool |                 2 |                  1 |                             64 MiB |
| Memory Write-Ahead VFS — 3-connection pool |                 3 |                  2 |                             96 MiB |
| Memory Write-Ahead VFS — 4-connection pool |                 4 |                  3 |                            128 MiB |

SQLite's cache setting is a ceiling, not preallocated resident memory, and this harness does not measure RSS. No fixed-total-cache control was run. The results compare the implementations as configured per connection and must not be presented as equal-memory results.

## Application configuration: PowerSync on the main thread, MWA in workers

This asymmetric configuration represents an application that uses `useWebWorker: false` for PowerSync MemoryVFS and dedicated workers for Memory Write-Ahead VFS. It is useful as an application-level measurement, but it is not the primary like-for-like worker comparison.

| Configuration                              | Sequential reads | Concurrent reads |   Mixed reads | Mixed write completion |     Pool ready |
| ------------------------------------------ | ---------------: | ---------------: | ------------: | ---------------------: | -------------: |
| PowerSync MemoryVFS — 1 connection         |    27.88 / 31.06 |    28.70 / 31.64 | 28.36 / 31.27 |          28.63 / 31.50 |   6.78 / 10.80 |
| Memory Write-Ahead VFS — 1 connection      |    29.75 / 32.57 |    29.18 / 32.68 | 29.04 / 32.03 |          29.47 / 32.64 |  29.69 / 40.02 |
| Memory Write-Ahead VFS — 2-connection pool |    30.59 / 38.89 |    17.88 / 20.68 | 18.53 / 20.57 |          13.31 / 14.94 |  59.05 / 73.05 |
| Memory Write-Ahead VFS — 3-connection pool |    30.45 / 34.81 |    15.33 / 17.19 | 15.88 / 20.35 |            7.74 / 9.42 | 62.50 / 130.55 |
| Memory Write-Ahead VFS — 4-connection pool |    30.28 / 32.93 |    14.72 / 15.74 | 15.45 / 16.89 |            6.94 / 7.77 |  67.68 / 81.82 |

[Full result](./results/application-workers.json)

## Control: workers disabled for both implementations

| Configuration                              | Sequential reads | Concurrent reads |   Mixed reads | Mixed write completion |    Pool ready |
| ------------------------------------------ | ---------------: | ---------------: | ------------: | ---------------------: | ------------: |
| PowerSync MemoryVFS — 1 connection         |    27.06 / 30.20 |    27.22 / 30.09 | 27.18 / 29.46 |          27.40 / 29.79 |   5.32 / 7.55 |
| Memory Write-Ahead VFS — 1 connection      |    27.03 / 28.59 |    26.96 / 29.40 | 27.12 / 28.67 |          27.37 / 28.92 |   5.28 / 8.20 |
| Memory Write-Ahead VFS — 2-connection pool |    27.03 / 29.64 |    27.28 / 30.49 | 27.30 / 29.94 |          11.75 / 13.13 | 10.69 / 14.18 |
| Memory Write-Ahead VFS — 3-connection pool |    27.30 / 29.57 |    27.38 / 29.14 | 27.71 / 30.71 |          20.63 / 22.53 | 14.58 / 18.87 |
| Memory Write-Ahead VFS — 4-connection pool |    27.36 / 29.21 |    27.43 / 29.09 | 27.74 / 29.86 |          13.41 / 14.57 | 18.51 / 26.20 |

These pools still contain multiple SQLite connections, but every connection runs on the same JavaScript thread. The read workload therefore gains no CPU parallelism; this control should not be presented as evidence of concurrent-reader acceleration.

[Full result](./results/both-main-thread.json)

## Reproduce

Requirements: Node.js 20+, pnpm 10.27.0, and Playwright Chromium.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Workers enabled for both implementations:

```bash
pnpm benchmark
```

Validate and sanitize that raw result for publication:

```bash
pnpm benchmark:publish-result \
  benchmark-results/memory-vfs-worker-worker.json \
  benchmarks/memory-vfs-comparison/results/both-workers.json \
  true true
```

PowerSync on the main thread and Memory Write-Ahead VFS in workers:

```bash
BENCHMARK_POWERSYNC_USE_WEB_WORKER=false \
BENCHMARK_MWA_USE_WEB_WORKER=true \
BENCHMARK_OUTPUT=benchmark-results/application-workers.json \
pnpm benchmark
```

Workers disabled for both implementations:

```bash
BENCHMARK_POWERSYNC_USE_WEB_WORKER=false \
BENCHMARK_MWA_USE_WEB_WORKER=false \
BENCHMARK_OUTPUT=benchmark-results/both-main-thread.json \
pnpm benchmark
```

`useWebWorker` is PowerSync's public `flags.useWebWorker` option for the PowerSync arm. `BENCHMARK_MWA_USE_WEB_WORKER` controls the equivalent benchmark harness choice for the Memory Write-Ahead VFS arm; it is not a package API.

## Methodology

- Pinned runtime versions: `@powersync/web` 1.39.0, `@powersync/common` 1.57.2, `@journeyapps/wa-sqlite` 1.7.0, `@playwright/test` 1.60.0, Vite 8.0.16, and `memory-write-ahead-vfs` 0.2.0.
- Same Chromium page, deterministic schema and data, eight SQL read queries, 32 MiB SQLite cache per connection, and identical SQL for every arm. Aggregate configured cache ceilings consequently range from 32 MiB to 128 MiB as shown above.
- Dataset: 30 collections, 6 groups, 12 runs, 30,000 records, and 3,000 labels, plus deterministic join rows and indexes.
- MWA reads use the least-active connection among the writer and additional readers. Writes stay pinned to the writer. Each connection is serialized independently.
- Ten workload passes per arm. Each pass excludes two warmups and records 10 sequential trials, 12 concurrent-read trials, and 8 mixed read/write trials.
- Published percentiles use the raw 100 sequential, 120 concurrent, 80 mixed-read, and 80 mixed-write samples—not percentiles of pass averages.
- Thirty startup passes per arm. Arm order rotates and reverses between passes to reduce order and thermal bias.
- Every arm must pass dataset row counts, full-result SHA-256 equivalence across arms, per-trial checksums, exact affected-row counts, and final write-value verification. MWA pools must also prove that mutations routed through an additional reader are rejected and leave data unchanged.
- The committed result was recorded in cross-origin-isolated Playwright Chromium 148 with `navigator.hardwareConcurrency = 18`.

## Interpretation limits

This is one synthetic workload on one machine and browser build. It does not establish universal application performance, equal-memory performance, memory consumption, energy use, or behavior on lower-end devices. Worker scheduling and p95 latency vary between runs. Use the harness with production-shaped queries and device classes before choosing a pool size.

The benchmark pool is reference harness code, not an exported connection-pool API. PowerSync MemoryVFS is tested through its public `WASQLiteOpenFactory` with `WASQLiteVFS.InMemoryVfs`; Memory Write-Ahead VFS is tested through its public VFS API and the reference pool in this directory.
