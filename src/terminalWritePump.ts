export interface TerminalWriteTarget {
  write(data: string, callback?: () => void): void;
}

export interface TerminalWritePump {
  enqueue(data: string): void;
  dispose(): void;
}

export interface TerminalWritePumpScheduler {
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const WRITE_BATCH_CHARS = 32 * 1024;
export const WRITE_IMMEDIATE_THRESHOLD = 128 * 1024;

function getDefaultScheduler(): TerminalWritePumpScheduler {
  const requestAnimationFrame = globalThis.requestAnimationFrame
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback: () => void) => globalThis.setTimeout(callback, 0);
  const cancelAnimationFrame = globalThis.cancelAnimationFrame
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);

  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

export function createTerminalWritePump(
  terminal: TerminalWriteTarget,
  scheduler: TerminalWritePumpScheduler = getDefaultScheduler(),
): TerminalWritePump {
  const chunks: string[] = [];
  let readIndex = 0;
  let queuedChars = 0;
  let frameId: unknown | null = null;
  let timeoutId: unknown | null = null;
  let writing = false;
  let disposed = false;

  const clearPending = () => {
    if (frameId !== null) {
      scheduler.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      scheduler.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const compactQueue = () => {
    if (readIndex === 0) return;
    if (readIndex >= chunks.length) {
      chunks.length = 0;
      readIndex = 0;
      return;
    }
    if (readIndex > 64 && readIndex * 2 >= chunks.length) {
      chunks.splice(0, readIndex);
      readIndex = 0;
    }
  };

  const drain = () => {
    clearPending();
    if (disposed || writing || queuedChars === 0) return;

    const batch: string[] = [];
    let batchChars = 0;
    while (readIndex < chunks.length && batchChars < WRITE_BATCH_CHARS) {
      const chunk = chunks[readIndex++];
      if (!chunk) continue;
      batch.push(chunk);
      batchChars += chunk.length;
    }

    if (batch.length === 0) {
      compactQueue();
      return;
    }

    compactQueue();
    queuedChars = Math.max(0, queuedChars - batchChars);
    writing = true;
    terminal.write(batch.join(""), () => {
      writing = false;
      if (!disposed && queuedChars > 0) {
        schedule();
      }
    });
  };

  const schedule = () => {
    if (disposed || writing || queuedChars === 0 || frameId !== null || timeoutId !== null) return;
    const flush = () => {
      clearPending();
      drain();
    };

    frameId = scheduler.requestAnimationFrame(flush);
    timeoutId = scheduler.setTimeout(flush, 24);
  };

  return {
    enqueue(data: string) {
      if (disposed || data.length === 0) return;
      chunks.push(data);
      queuedChars += data.length;

      if (queuedChars >= WRITE_IMMEDIATE_THRESHOLD && !writing) {
        drain();
        return;
      }

      schedule();
    },
    dispose() {
      disposed = true;
      chunks.length = 0;
      readIndex = 0;
      queuedChars = 0;
      clearPending();
    },
  };
}
