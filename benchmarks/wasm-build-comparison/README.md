# wa-sqlite build comparison

This benchmark compares the `wa-sqlite.wasm` published in `@journeyapps/wa-sqlite` 1.7.0 ("stock") with the one built by [`wasm/Dockerfile`](../../wasm/Dockerfile) ("rebuilt"). Both arms run the same SQL through Memory Write-Ahead VFS in a dedicated worker, with the same wa-sqlite JavaScript API; only the Emscripten glue and the wasm binary change.

## What differs between the two builds

|                                            | stock                              | rebuilt                                    |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------ |
| Source                                     | npm `@journeyapps/wa-sqlite` 1.7.0 | [`wasm/Dockerfile`](../../wasm/Dockerfile) |
| SQLite                                     | 3.53.0                             | 3.53.0                                     |
| Compiler in `PRAGMA compile_options`       | clang-23.0.0                       | clang-21.0.0                               |
| `MAX_ATTACHED` in `PRAGMA compile_options` | 10                                 | 125                                        |
| `wa-sqlite.wasm` size                      | 1,128,032 bytes                    | 1,129,991 bytes                            |
| `wa-sqlite.wasm` SHA-256                   | `d167becf5a69…`                    | `91defe9a35e0…`                            |

A difference between the arms can come from the compiler or from the attach limit; this benchmark does not separate the two.

## Result

Run on 2026-10-07 with Chromium 148.0.7778.96 on an Apple M5 Pro (18 logical CPUs, darwin arm64), 16 runs per arm. The machine was not idle: the 1-minute load average was 8.43 when the benchmark started and 7.56 when it ended.

| Workload          | stock, ms: median (min–max) | rebuilt, ms: median (min–max) | rebuilt against stock |
| ----------------- | --------------------------- | ----------------------------- | --------------------- |
| `filterScan`      | 46.72 (43.83–52.36)         | 46.89 (45.01–50.15)           | +0.4%                 |
| `join`            | 11.86 (11.50–15.02)         | 12.10 (11.46–15.28)           | +2.0%                 |
| `groupedLeftJoin` | 12.80 (11.05–14.01)         | 13.44 (12.57–14.94)           | +5.0%                 |
| `orderByText`     | 45.63 (41.88–54.92)         | 47.01 (44.01–50.61)           | +3.0%                 |
| `insert`          | 23.89 (22.78–25.95)         | 24.48 (23.31–26.06)           | +2.5%                 |
| `seed`            | 164.15 (155.18–184.40)      | 167.60 (158.62–172.60)        | +2.1%                 |
| `instantiate`     | 3.93 (3.62–4.43)            | 3.26 (3.00–3.51)              | −17.0%                |

The rebuilt build is not faster. On the five SQL workloads and the seed, its median is 0.4% to 5.0% above the stock build's, and the two ranges overlap on every one of them. Instantiation is 0.67 ms shorter. Every run of both arms returned the same row counts and the same result hashes.

## Workload

A seeded generator in [`dataset.ts`](./dataset.ts) builds the same database in every run: 1,000 categories and 30,000 items with 20 columns mixing text, integers, reals, and nullable values, plus an index on `item.category_id`.

| Workload          | What runs                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `filterScan`      | `SELECT *` with a filter on two unindexed columns, returning 17,900 of the 30,000 rows                  |
| `join`            | items joined to their category, filtered on three of the 20 category families, ordered by item id       |
| `groupedLeftJoin` | every category left-joined to its active items, grouped with `COUNT`, `SUM`, `AVG`, `MAX`               |
| `orderByText`     | 4 columns of all 30,000 items ordered by a text column, without an index                                |
| `insert`          | 5,000 rows with all 20 columns in one transaction through one prepared statement, into an indexed table |
| `instantiate`     | the glue's module factory compiling and instantiating the wasm bytes, once per run                      |
| `seed`            | creating the schema and inserting the 31,000 rows and the index in one transaction, once per run        |

Each read is timed from `prepare` until every row has been read into JavaScript values with `sqlite3.row`, so the time includes wa-sqlite's per-row JavaScript overhead, which is the same in both arms.

## Method

- One run opens a new browser context and page, starts a dedicated worker, loads one arm's glue, fetches its wasm bytes, and passes them as `wasmBinary`. The worker opens a Memory Write-Ahead VFS database in WAL mode with a 64 MiB page cache, which holds the whole database, so warm reads do not go through the VFS read path.
- Each run executes 2 warmup rounds, which are discarded, then 5 measured rounds. A round runs the four reads, then the insert. A run's value for a workload is the median of its 5 measured rounds; the table reports the median, minimum, and maximum of those values across runs.
- Arms alternate in ABBA and BAAB blocks so that each arm runs equally often early and late. One priming run per arm, before the first block, is discarded.
- Every run hashes each read result and the inserted rows; all runs of both arms must produce the same hashes. The worker also hashes the wasm bytes it loaded and the test checks them against the files on disk.
- [Raw runs](./results/npm-1.7.0-vs-rebuilt.json) include every measured round and the 1-minute load average when each run started.

## What this does not measure

- Attached databases: the workload uses one database, so it does not exercise the code paths that the higher attach limit changes.
- Other wa-sqlite variants (asynchronous, JSPI, multiple ciphers), other VFS implementations, other browsers, or other machines.
- Memory use, download size, page-load time, or the cost of fetching the wasm over a network.
- Concurrency between workers or connections; every run uses one connection.
- Prepared-statement reuse for reads; each read prepares its statement again.

## Reproduce

Requirements: Docker, Node.js 20+, pnpm 10.27.0, and Playwright Chromium.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build:wasm
pnpm benchmark:wasm
```

The raw result is written to `benchmark-results/wasm-build-comparison.json`. `BENCHMARK_RUNS_PER_ARM` (even, default 16) changes the number of measured runs, and `WASM_BENCHMARK_CANDIDATE_DIR` points the rebuilt arm at another directory inside the repository, for example a build with a different `SQLITE_MAX_ATTACHED`.
