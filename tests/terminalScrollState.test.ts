import assert from "node:assert/strict";
import {
  getWheelViewportSyncDecision,
  getViewportSyncDecision,
  shouldSuppressBottomWheel,
  type TerminalScrollSnapshot,
} from "../src/terminalScrollState";

function snapshot(overrides: Partial<TerminalScrollSnapshot> = {}): TerminalScrollSnapshot {
  return {
    viewportY: 120,
    baseY: 120,
    scrollTop: 1920,
    maxScrollTop: 1920,
    ...overrides,
  };
}

assert.equal(
  shouldSuppressBottomWheel(snapshot(), 100),
  true,
  "wheel-down at terminal bottom should stay pinned to the bottom",
);

assert.equal(
  shouldSuppressBottomWheel(snapshot(), -100),
  false,
  "wheel-up at terminal bottom should remain scrollable",
);

assert.equal(
  shouldSuppressBottomWheel(snapshot({ viewportY: 80 }), 100),
  false,
  "wheel-down away from the bottom should use normal xterm scrolling",
);

assert.deepEqual(
  getViewportSyncDecision(snapshot({ scrollTop: 0 })),
  { action: "repair-to-bottom", scrollTop: 1920 },
  "hidden Obsidian tab restoring with DOM scrollTop=0 should be repaired before xterm sees it",
);

assert.deepEqual(
  getViewportSyncDecision(snapshot({ viewportY: 80, scrollTop: 0 })),
  { action: "none", scrollTop: 0 },
  "non-bottom buffers should not be forced back to the bottom",
);

assert.deepEqual(
  getWheelViewportSyncDecision(snapshot({ scrollTop: 1680 }), -100),
  { action: "none", scrollTop: 1680 },
  "wheel-up from bottom must be left to xterm instead of being repaired back to the bottom",
);

assert.deepEqual(
  getWheelViewportSyncDecision(snapshot({ scrollTop: 0 }), 100),
  { action: "repair-to-bottom", scrollTop: 1920 },
  "wheel-down in a corrupted bottom viewport should repair the DOM scroll position",
);

assert.deepEqual(
  getViewportSyncDecision(snapshot({ maxScrollTop: 0, scrollTop: 0 })),
  { action: "none", scrollTop: 0 },
  "empty scroll areas do not need repair",
);

console.log("terminalScrollState tests passed");
