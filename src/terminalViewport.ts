import type { Terminal } from "@xterm/xterm";
import {
  getViewportSyncDecision,
  getWheelViewportSyncDecision,
  shouldSuppressBottomWheel,
  type TerminalScrollSnapshot,
} from "./terminalScrollState";

export interface TerminalViewportOwner {
  terminal: Terminal;
  el: HTMLElement;
  viewportGuardsInstalled: boolean;
}

export function getXtermViewport(tabEl: HTMLElement): HTMLElement | null {
  return tabEl.querySelector(".xterm-viewport") as HTMLElement | null;
}

export function getTerminalScrollSnapshot(
  terminal: Terminal,
  tabEl: HTMLElement,
): TerminalScrollSnapshot | null {
  const viewport = getXtermViewport(tabEl);
  if (!viewport) return null;

  const buffer = terminal.buffer.active;
  return {
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    scrollTop: viewport.scrollTop,
    maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  };
}

export function syncTerminalViewportScrollArea(terminal: Terminal): void {
  const internalViewport = (terminal as any)._core?.viewport ?? (terminal as any).viewport;
  internalViewport?.syncScrollArea?.(true);
}

export function repairTerminalBottomViewport(
  terminal: Terminal,
  tabEl: HTMLElement,
): void {
  const snapshot = getTerminalScrollSnapshot(terminal, tabEl);
  if (!snapshot) return;

  const decision = getViewportSyncDecision(snapshot);
  if (decision.action !== "repair-to-bottom") return;

  const viewport = getXtermViewport(tabEl);
  if (viewport) viewport.scrollTop = decision.scrollTop;
}

export function installTerminalViewportGuards(owner: TerminalViewportOwner): void {
  if (owner.viewportGuardsInstalled) return;

  const viewport = getXtermViewport(owner.el);
  if (!viewport) return;

  owner.el.addEventListener("wheel", (e: WheelEvent) => {
    if (e.ctrlKey) return;

    const snapshot = getTerminalScrollSnapshot(owner.terminal, owner.el);
    if (!snapshot || e.deltaY <= 0) return;

    const decision = getWheelViewportSyncDecision(snapshot, e.deltaY);
    if (decision.action === "repair-to-bottom") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      viewport.scrollTop = decision.scrollTop;
      owner.terminal.scrollToBottom();
      return;
    }

    if (shouldSuppressBottomWheel(snapshot, e.deltaY)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      viewport.scrollTop = snapshot.maxScrollTop;
      owner.terminal.scrollToBottom();
    }
  }, { capture: true, passive: false });

  owner.viewportGuardsInstalled = true;
}
