export type MemoryWriteAheadLogger = Pick<Console, 'debug' | 'error' | 'info' | 'warn'>;

const noop = () => undefined;

export const noopMemoryWriteAheadLogger: MemoryWriteAheadLogger = {
    debug: noop,
    error: noop,
    info: noop,
    warn: noop,
};

export const resolveMemoryWriteAheadLogger = (logger?: Partial<MemoryWriteAheadLogger>): MemoryWriteAheadLogger => ({
    debug: logger?.debug?.bind(logger) ?? noop,
    error: logger?.error?.bind(logger) ?? noop,
    info: logger?.info?.bind(logger) ?? noop,
    warn: logger?.warn?.bind(logger) ?? noop,
});
