import assert from "node:assert/strict";
import { createTerminalWritePump } from "../src/terminalWritePump";

function createScheduler() {
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];

  return {
    scheduler: {
      requestAnimationFrame(callback: () => void): number {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame(): void {},
      setTimeout(callback: () => void): number {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout(): void {},
    },
    runFrame(): void {
      const callback = frames.shift();
      assert.ok(callback, "expected a queued animation frame");
      callback();
    },
    runTimer(): void {
      const callback = timers.shift();
      assert.ok(callback, "expected a queued timeout");
      callback();
    },
  };
}

{
  const writes: string[] = [];
  const { scheduler, runFrame } = createScheduler();
  const pump = createTerminalWritePump({
    write(data: string, callback?: () => void): void {
      writes.push(data);
      callback?.();
    },
  }, scheduler);

  pump.enqueue("hello");
  pump.enqueue(" world");
  runFrame();

  assert.deepEqual(writes, ["hello world"], "queued chunks should be batched into one terminal write");
}

{
  const writes: string[] = [];
  const { scheduler, runFrame } = createScheduler();
  const pump = createTerminalWritePump({
    write(data: string, callback?: () => void): void {
      writes.push(data);
      callback?.();
    },
  }, scheduler);

  pump.enqueue("before dispose");
  pump.dispose();
  runFrame();

  assert.deepEqual(writes, [], "disposing the pump should drop queued writes");
}

console.log("terminalWritePump tests passed");
