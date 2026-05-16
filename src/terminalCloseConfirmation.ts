export interface TerminalCloseConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmButtonClass: string;
  cancelButtonClass: string;
}

export function getTerminalCloseConfirmation(tabName: string): TerminalCloseConfirmation {
  const safeName = tabName.trim() || "this terminal";
  return {
    title: "Close terminal?",
    message: `Close "${safeName}"? The running process in this tab will be stopped.`,
    confirmLabel: "Close",
    cancelLabel: "Cancel",
    confirmButtonClass: "ai-terminal-confirm-accent",
    cancelButtonClass: "ai-terminal-confirm-secondary",
  };
}

export function shouldCloseTerminalTab(confirmed: boolean): boolean {
  return confirmed;
}
