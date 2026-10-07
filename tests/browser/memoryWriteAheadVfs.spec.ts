import { expect, type Page, test } from '@playwright/test';

const browserFixtureNames = [
    'runAbandonedFileLockWorkerRecovery',
    'runAbandonedAttachedTransactionRecovery',
    'runAbandonedWorkerLeaseRecovery',
    'runAttachedDatabaseAtomicTransaction',
    'runAttachedDatabaseConcurrentWrites',
    'runAttachedDatabaseWithoutWriteAheadFiles',
    'runCapacityExceededFailure',
    'runCleanSlateResetWithOpenHandle',
    'runDuplicatePendingOpenRejection',
    'runDeferredWriteUpgrade',
    'runFileLockRegression',
    'runMultipleRuntimeIsolation',
    'runOwnerLeaseClaimRecovery',
    'runOwnerLeaseExhaustionRecovery',
    'runReadmeQuickstart',
    'runRejectedGrowableReservation',
    'runRollbackAndPragmaBehavior',
    'runRuntimeLifecycle',
    'runRuntimeOptionValidation',
    'runSameVfsConnectionExpectation',
    'runSameVfsSequentialReopen',
    'runSegmentGrowthAndCheckpointReclaim',
    'runSegmentReclaimAccounting',
    'runSegmentReclaimAccountingSaturation',
    'runSnapshotIsolation',
    'runStaleDeferredWriteRejection',
    'runStaleOwnedLeaseSlotPreservation',
    'runTargetedResetRefusal',
    'runWalRoundTrip',
    'runWorkerConcurrency',
    'runZeroByteWriteAndDiagnostics',
] as const;

type BrowserApi = typeof import('../fixtures/browserApi.js');
type BrowserFixtureName = (typeof browserFixtureNames)[number];
type BrowserFixtureResult<TName extends BrowserFixtureName> = Awaited<ReturnType<BrowserApi[TName]>>;

const runBrowserFixture = async <TName extends BrowserFixtureName>(page: Page, fixtureName: TName) =>
    page.evaluate(async (name) => {
        const browserApiModulePath = '/tests/fixtures/browserApi.ts';
        const browserApi = (await import(browserApiModulePath)) as BrowserApi;
        return browserApi[name]() as Promise<BrowserFixtureResult<TName>>;
    }, fixtureName);

test.describe('MemoryWriteAheadVFS browser integration', () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await page.goto(new URL('/test-host.html', baseURL ?? 'http://127.0.0.1:5173').toString());
    });

    test('validates runtime options and path normalization', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runRuntimeOptionValidation');

        expect(result.validOptions.initialDatabaseCapacityBytes).toBe(4096);
        expect(result.validOptions.maxWriteAheadCapacityBytes).toBe(8192);
        expect(result.normalizedAbsolute).toBe('/tmp/app.sqlite');
        expect(result.normalizedRelative).toBe('/relative.sqlite');
        expect(result.errors).toEqual([
            'initialDatabaseCapacityBytes must be a positive integer; received 0',
            'maxDatabaseCapacityBytes must be a positive integer; received 1.5',
            'initialDatabaseCapacityBytes cannot exceed maxDatabaseCapacityBytes',
            'maxWriteAheadCapacityBytes cannot exceed 2147483647 bytes',
        ]);
    });

    test('names the allocator error when a growable SharedArrayBuffer reservation is rejected', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runRejectedGrowableReservation');

        expect(result.message).toBe(
            'MemoryWriteAheadVFS could not reserve a growable SharedArrayBuffer: Array buffer allocation failed'
        );
        expect(result.causeIsAllocatorError).toBe(true);
        expect(result.runtimeRegistered).toBe(false);
    });

    test('tracks lifecycle diagnostics and refuses reset while handles are open', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runRuntimeLifecycle');

        expect(result.reusedSameRuntime).toBe(true);
        expect(result.fileCount).toBe(3);
        expect(result.initialOpenHandleCount).toBe(0);
        expect(result.openHandleCount).toBe(3);
        expect(result.openActiveOwnerLeaseCount).toBe(1);
        expect(result.incompatibleReuseMessage).toContain('already exists with different options');
        expect(result.resetWhileOpenMessage).toBe('Cannot reset MemoryWriteAheadVFS while 3 open handles remain');
    });

    test('resets and deregisters every runtime even when one still holds an open handle', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runCleanSlateResetWithOpenHandle');

        expect(result.resetError).toBeNull();
        expect(result.leakingRuntimeRegistered).toBe(false);
        expect(result.followingRuntimeRegistered).toBe(false);
        expect(result.followingFileSizeAfterReset).toBe(0);
    });

    test('refuses a targeted reset with open handles without touching the runtime', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runTargetedResetRefusal');

        expect(result.resetMessage).toBe('Cannot reset MemoryWriteAheadVFS while 1 open handles remain');
        expect(result.openHandleCountAfterRefusal).toBe(1);
        expect(result.fileSizeAfterRefusal).toBe(4);
    });

    test('reopens committed WAL data from the shared in-memory runtime', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runWalRoundTrip');

        expect(result.vfs).toBe('MemoryWriteAheadVFS');
        expect(result.rows).toEqual(['alpha', 'beta']);
        expect(result.fileCount).toBe(3);
    });

    test('tracks segmented file growth through a truncate checkpoint', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSegmentGrowthAndCheckpointReclaim');

        expect(result.count).toBe(40);
        expect(result.payloadBytes).toBe(40 * 2048);
        expect(result.checkpointCount).toBeGreaterThanOrEqual(1);
        expect(result.checkpointWriteAheadPages).toBeGreaterThan(0);
        expect(result.lastCheckpointWriteAheadPages).toBeGreaterThan(0);
        expect(result.writeAheadExpandedBeforeCheckpoint).toBe(true);
        expect(result.writeAheadLogicalSizeBeforeCheckpoint).toBeGreaterThan(0);
        expect(result.writeAheadSegmentCountAfterCheckpoint).toBeGreaterThanOrEqual(2);
        expect(result.databaseSegmentCountAfterCheckpoint).toBeGreaterThan(1);
    });

    test('accounts reclaimed bytes using actual final segment allocation', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSegmentReclaimAccounting');

        expect(result.allocatedBytesBeforeTruncate).toBe(96 * 1024);
        expect(result.secondSegmentBytes).toBe(32 * 1024);
        expect(result.reclaimedBytes).toBe(32 * 1024);
        expect(result.reclaimedSegmentCount).toBe(1);
        expect(result.activeSegmentsAfterTruncate).toBe(1);
    });

    test('saturates reclaimed diagnostics counters instead of wrapping Int32', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSegmentReclaimAccountingSaturation');

        expect(result.reclaimedBytes).toBe(0x7fffffff);
        expect(result.reclaimedSegmentCount).toBe(0x7fffffff);
    });

    test('extends logical size for zero-byte writes and records high-water diagnostics', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runZeroByteWriteAndDiagnostics');

        expect(result.bytesWritten).toBe(0);
        expect(result.logicalSizeBytes).toBe(64 * 1024);
        expect(result.peakLogicalSizeBytes).toBe(64 * 1024);
        expect(result.peakCapacityBytes).toBeGreaterThanOrEqual(64 * 1024);
        expect(result.peakAllocatedCapacityBytes).toBeGreaterThanOrEqual(64 * 1024);
        expect(result.writeOperationCount).toBe(1);
        expect(result.writtenBytes).toBe(0);
    });

    test('fails at configured capacity and logs the underlying VFS capacity error', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runCapacityExceededFailure');

        expect(result.maxWriteAheadCapacityBytes).toBe(64 * 1024);
        expect(result.overflowMessage).toContain('disk I/O error');
        expect(result.errorLogs.join('\n')).toContain('capacity exceeded');
    });

    test('keeps reader snapshots stable while a writer transaction is open', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSnapshotIsolation');

        expect(result.before).toEqual(['before']);
        expect(result.during).toEqual(['before']);
        expect(result.after).toEqual(['before', 'during-1', 'during-2']);
    });

    test('upgrades deferred and savepoint transactions from reads to writes', async ({ page }) => {
        const rows = await runBrowserFixture(page, 'runDeferredWriteUpgrade');

        expect(rows).toEqual(['warmup', 'transaction', 'savepoint']);
    });

    test('rejects a deferred write when another connection made its snapshot stale', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runStaleDeferredWriteRejection');

        expect(result.rejectionMessage).toContain('database is locked');
        expect(result.detailedRejectionMessage).toContain('snapshot is stale');
        expect(result.detailedRejectionMessage).not.toContain('Not in write isolated state');
        expect(result.rows).toEqual(['warmup', 'concurrent', 'recovered']);
    });

    test('commits atomically across the primary and an attached shared database', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAttachedDatabaseAtomicTransaction');

        expect(result.mainRows).toEqual(['main']);
        expect(result.attachedRows).toEqual(['attached']);
        expect(result.fileCount).toBe(4);
    });

    test('reserves no write-ahead files for an attached database', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAttachedDatabaseWithoutWriteAheadFiles');

        expect(result.primaryWriteAheadFileCount).toBe(2);
        expect(result.attachedWriteAheadFileCount).toBe(0);
        expect(result.pathnames).toEqual(['main', 'main-wa0', 'main-wa1', 'attached']);
        expect(result.attachedRows).toEqual(['attached']);
    });

    test('serializes concurrent transactions opened directly on an attached shared database', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAttachedDatabaseConcurrentWrites');

        expect(result.value).toBe(40);
        expect(result.integrity).toBe('ok');
    });

    test('preserves rollback semantics and VFS pragma round-trips', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runRollbackAndPragmaBehavior');

        expect(result.journalMode).toBe('delete');
        expect(result.busyTimeout).toBe(2500);
        expect(result.lazyLockNone).toBe('none');
        expect(result.lazyLockReadWrite).toBe('readwrite');
        expect(result.journalSizeLimit).toBe(4096);
        expect(result.backstopInterval).toBe(75);
        expect(result.rows).toEqual(['committed', 'after-rollback']);
    });

    test('keeps file-lock ownership atomic across recovery and stale release races', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runFileLockRegression');

        expect(result.acquiredLockState).toBe(101);
        expect(result.acquiredLockOwner).toBe(101);
        expect(result.releasedLockState).toBe(0);
        expect(result.lockStateAfterStaleOwnerRelease).toBe(202);
        expect(result.lockStateAfterAcquireRecoveredNegative).toBe(202);
        expect(result.recoveredHeldLock).toBe(true);
        expect(result.lockStateAfterHeldRecovery).toBe(0);
        expect(result.secondRecoveryAttempt).toBe(false);
        expect(result.lockStateAfterSecondRecoveryAttempt).toBe(0);
        expect(result.recoveredInterruptedRecovery).toBe(true);
        expect(result.lockStateAfterInterruptedRecovery).toBe(0);
    });

    test('recovers a dead worker-held file lock while another worker waits', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAbandonedFileLockWorkerRecovery');

        expect(result.heldLockState).toBe(707);
        expect(result.acquiredLockState).toBe(808);
        expect(result.finalLockState).toBe(0);
        expect(result.recoveredAbandonedLockCount).toBe(1);
    });

    test('reclaims stale orphaned owner lease slots and skips fresh leftovers', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runOwnerLeaseClaimRecovery');

        expect(result.freshSlotZeroOwnerId).toBe(0);
        expect(result.freshSlotOneOwnerId).toBeGreaterThan(0);
        expect(result.staleSlotZeroOwnerId).toBeGreaterThan(0);
        expect(result.staleSlotZeroHandleCount).toBe(1);
        expect(result.slotZeroOwnerIdAfterRelease).toBe(0);
        expect(result.slotZeroHeartbeatAfterRelease).toBe(0);
    });

    test('leaves stale dead-owner lease slots untouched for recovery', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runStaleOwnedLeaseSlotPreservation');

        expect(result.slotZeroOwnerId).toBe(result.deadOwnerId);
        expect(result.slotZeroHeartbeatMs).toBe(result.staleHeartbeatMs);
        expect(result.slotOneOwnerId).toBeGreaterThan(0);
    });

    test('recovers abandoned owner leases when claiming finds every slot exhausted', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runOwnerLeaseExhaustionRecovery');

        expect(result.claimedOwnerId).toBeGreaterThan(0);
        expect(result.activeOwnerLeaseCount).toBe(1);
        expect(result.openHandleCount).toBe(1);
        expect(result.recoveredAbandonedHandleCount).toBe(result.slotCount);
    });

    test('rejects opening one main database twice through the same VFS instance', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSameVfsConnectionExpectation');

        expect(result.secondOpenMessage).toContain('sqlite3_open_v2');
        expect(result.lastVfsError).toContain('separate MemoryWriteAheadVFS instance');
        expect(result.rows).toEqual(['first', 'after-rejected-second-open']);
    });

    test('reopens the same main database sequentially through one VFS instance', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runSameVfsSequentialReopen');

        expect(result.rows).toEqual(['first-open', 'second-open']);
    });

    test('rejects a duplicate primary open while the first open is still pending', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runDuplicatePendingOpenRejection');

        expect(result.firstOpen).toBe(5); // SQLITE_BUSY: first open queues #retryOpen
        expect(result.duplicateOpen).toBe(14); // SQLITE_CANTOPEN: rejected before allocating handles
        expect(result.duplicateOpenError).toContain('separate MemoryWriteAheadVFS instance');
        expect(result.retriedFirstOpen).toBe(0); // SQLITE_OK
        expect(result.closedFirstOpen).toBe(0); // SQLITE_OK
        expect(result.openHandleCount).toBe(0);
    });

    test('runs the README quickstart fixture in a browser', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runReadmeQuickstart');

        expect(result.rows).toEqual(['hello']);
    });

    test('serializes concurrent dedicated-worker writers over one shared runtime', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runWorkerConcurrency');

        expect(result.responses).toEqual([
            { id: 1, ok: true, insertedRows: 20 },
            { id: 2, ok: true, insertedRows: 20 },
            { id: 3, ok: true, insertedRows: 20 },
        ]);
        expect(result.count).toBe(60);
        expect(result.writerCount).toBe(3);
        expect(result.payloadBytes).toBe(60 * 4096);
        expect(result.segmentedWriteAheadBeforeCheckpoint).toBe(true);
        expect(result.openHandleCountAfterClose).toBe(0);
    });

    test('recovers terminated-worker runtime leases immediately', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAbandonedWorkerLeaseRecovery');

        expect(result.openHandleCountBeforeTerminate).toBe(3);
        expect(result.activeOwnerLeaseCountBeforeTerminate).toBe(1);
        expect(result.recoveredHandleCount).toBe(3);
        expect(result.diagnosticsAfterReset).toBeNull();
    });

    test('quarantines an attached database when its transaction owner terminates', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runAbandonedAttachedTransactionRecovery');

        expect(result.recoveredHandleCount).toBeGreaterThan(0);
        expect(result.transactionLockBeforeTerminate).toBeGreaterThan(0);
        expect(result.transactionLockAfterRecovery).toBe(result.transactionLockBeforeTerminate);
        expect(result.transactionLockOwnerAfterRecovery).toBeGreaterThan(0);
        expect(result.attachedReadMessage).toContain('database is locked');
        expect(result.lastVfsError).toContain('quarantined');
    });

    test('keeps named runtimes isolated when one runtime is reset', async ({ page }) => {
        const result = await runBrowserFixture(page, 'runMultipleRuntimeIsolation');

        expect(result.firstDiagnosticsAfterReset).toBeNull();
        expect(result.secondDiagnosticsFileCount).toBe(3);
        expect(result.secondRows).toEqual(['second']);
    });
});
