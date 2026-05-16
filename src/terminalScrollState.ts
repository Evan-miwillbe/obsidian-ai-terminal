export interface TerminalScrollSnapshot {
  viewportY: number;
  baseY: number;
  scrollTop: number;
  maxScrollTop: number;
}

export interface ViewportSyncDecision {
  action: "none" | "repair-to-bottom";
  scrollTop: number;
}

export function isAtBufferBottom(snapshot: TerminalScrollSnapshot): boolean {
  return snapshot.viewportY >= snapshot.baseY;
}

export function shouldSuppressBottomWheel(
  snapshot: TerminalScrollSnapshot,
  deltaY: number,
): boolean {
  return deltaY > 0 && snapshot.maxScrollTop > 0 && isAtBufferBottom(snapshot);
}

export function getWheelViewportSyncDecision(
  snapshot: TerminalScrollSnapshot,
  deltaY: number,
): ViewportSyncDecision {
  if (deltaY <= 0) {
    return { action: "none", scrollTop: snapshot.scrollTop };
  }

  return getViewportSyncDecision(snapshot);
}

export function getViewportSyncDecision(snapshot: TerminalScrollSnapshot): ViewportSyncDecision {
  if (snapshot.maxScrollTop <= 0) {
    return { action: "none", scrollTop: snapshot.scrollTop };
  }

  if (!isAtBufferBottom(snapshot)) {
    return { action: "none", scrollTop: snapshot.scrollTop };
  }

  if (snapshot.scrollTop <= 1 || snapshot.scrollTop < snapshot.maxScrollTop - 1) {
    return { action: "repair-to-bottom", scrollTop: snapshot.maxScrollTop };
  }

  return { action: "none", scrollTop: snapshot.scrollTop };
}
