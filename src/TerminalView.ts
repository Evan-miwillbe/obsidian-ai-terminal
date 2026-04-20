import { ItemView, Modal, Notice, Scope, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PtyProcess } from "./PtyProcess";
import type { AITerminalSettings, Preset } from "./Settings";

export const VIEW_TYPE_TERMINAL = "ai-terminal-view";

interface TerminalWritePump {
  enqueue(data: string): void;
  dispose(): void;
}

interface TabInstance {
  id: string;
  name: string;
  userRenamed: boolean;
  terminal: Terminal;
  fitAddon: FitAddon;
  pty: PtyProcess;
  writer: TerminalWritePump;
  el: HTMLElement;
  timers: ReturnType<typeof setTimeout>[];
}

interface SplitPane {
  id: string;
  tabId: string;
  el: HTMLElement;
  headerEl: HTMLElement;
}

const WRITE_BATCH_CHARS = 32 * 1024;
const WRITE_IMMEDIATE_THRESHOLD = 128 * 1024;

function createTerminalWritePump(terminal: Terminal): TerminalWritePump {
  const chunks: string[] = [];
  let readIndex = 0;
  let queuedChars = 0;
  let frameId: number | null = null;
  let timeoutId: number | null = null;
  let writing = false;
  let disposed = false;

  const clearPending = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
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

  const schedule = () => {
    if (disposed || writing || queuedChars === 0 || frameId !== null || timeoutId !== null) return;
    const flush = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      drain();
    };

    frameId = window.requestAnimationFrame(() => {
      flush();
    });
    timeoutId = window.setTimeout(() => {
      flush();
    }, 24);
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

export class TerminalView extends ItemView {
  private tabs: TabInstance[] = [];
  private activeTabId: string | null = null;
  private splits: SplitPane[] = [];

  private tabBarEl: HTMLElement | null = null;
  private mainPaneEl: HTMLElement | null = null;
  private splitsWrapperEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private preset: Preset | null;
  private settings: AITerminalSettings;
  private pluginDir: string;
  private keymapScope = new Scope();
  private keymapScopeActive = false;
  private tabCounter = 0;
  private resizerEl: HTMLElement | null = null;
  private fitFrameId: number | null = null;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, settings: AITerminalSettings, pluginDir: string, preset: Preset | null = null) {
    super(leaf);
    this.settings = settings;
    this.pluginDir = pluginDir;
    this.preset = preset;
  }

  getViewType(): string { return VIEW_TYPE_TERMINAL; }
  getDisplayText(): string { return "AI Terminal"; }
  getIcon(): string { return "terminal"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ai-terminal-container");

    this.tabBarEl = container.createDiv({ cls: "ai-terminal-tab-bar" });

    const addBtn = this.tabBarEl.createDiv({ cls: "ai-terminal-tab-add", attr: { "aria-label": "New terminal" } });
    addBtn.setText("+");
    addBtn.addEventListener("click", () => this.addTab());

    const copyBtn = this.tabBarEl.createDiv({ cls: "ai-terminal-tab-copy", attr: { "aria-label": "Copy note path" } });
    copyBtn.setText("📄");
    copyBtn.addEventListener("click", () => this.copyNotePath());

    this.mainPaneEl = container.createDiv({ cls: "ai-terminal-main-pane" });

    let dropIndicator: HTMLElement | null = null;
    this.mainPaneEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      e.dataTransfer.dropEffect = "move";
      if (!dropIndicator) {
        dropIndicator = this.mainPaneEl!.createDiv({ cls: "ai-terminal-drop-indicator" });
      }
    });
    this.mainPaneEl.addEventListener("dragleave", () => {
      dropIndicator?.remove();
      dropIndicator = null;
    });
    this.mainPaneEl.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      dropIndicator?.remove();
      dropIndicator = null;
      const tabId = e.dataTransfer?.getData("text/plain");
      if (!tabId) return;
      this.splitOutTab(tabId);
    });

    const resizer = container.createDiv({ cls: "ai-terminal-resizer" });
    this.resizerEl = resizer;

    this.splitsWrapperEl = container.createDiv({ cls: "ai-terminal-splits-wrapper" });
    this.setSplitsVisible(false);

    let startY = 0;
    let startMainH = 0;
    let startSplitsH = 0;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      const newMainH = Math.max(80, startMainH + delta);
      const newSplitsH = Math.max(60, startSplitsH - delta);
      this.mainPaneEl!.style.flex = `0 0 ${newMainH}px`;
      this.splitsWrapperEl!.style.flex = `0 0 ${newSplitsH}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.scheduleFitAll();
    };
    resizer.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startMainH = this.mainPaneEl!.getBoundingClientRect().height;
      startSplitsH = this.splitsWrapperEl!.getBoundingClientRect().height;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    let lastW = 0;
    let lastH = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        this.scheduleFitAll();
      }, 120);
    });
    this.resizeObserver.observe(container);

    const scopeTarget = container;
    this.registerDomEvent(scopeTarget, "focusin", () => {
      if (!this.keymapScopeActive) {
        this.app.keymap.pushScope(this.keymapScope);
        this.keymapScopeActive = true;
      }
    });
    this.registerDomEvent(scopeTarget, "focusout", (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && scopeTarget.contains(e.relatedTarget)) return;
      if (this.keymapScopeActive) {
        this.app.keymap.popScope(this.keymapScope);
        this.keymapScopeActive = false;
      }
    });

    this.addTab(this.preset);
  }

  private getThemeColors() {
    const cs = getComputedStyle(document.body);
    const bgRaw = cs.getPropertyValue("--background-primary").trim() || "#1e1e2e";
    const accent = cs.getPropertyValue("--interactive-accent").trim() || "#7f6df2";
    const isDark = bgRaw.match(/[0-9a-f]{6}/i)
      ? parseInt(bgRaw.slice(1, 3), 16) * 0.299 + parseInt(bgRaw.slice(3, 5), 16) * 0.587 + parseInt(bgRaw.slice(5, 7), 16) * 0.114 < 128
      : true;

    return {
      isDark,
      fg: isDark ? "#e2e4e9" : "#1a1b1e",
      muted: isDark ? "#9ca0ab" : "#5a5d68",
      faint: isDark ? "#6e7280" : "#8b8f9a",
      termBg: isDark ? "#1e1f26ee" : "#f5f5f5ee",
      accent,
    };
  }

  private getTab(tabId: string | null): TabInstance | null {
    if (!tabId) return null;
    return this.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  private isTabSplit(tabId: string): boolean {
    return this.splits.some((split) => split.tabId === tabId);
  }

  private getNextMainTab(excludeTabId?: string): TabInstance | null {
    return this.tabs.find((tab) => tab.id !== excludeTabId && !this.isTabSplit(tab.id)) ?? null;
  }

  private clearMainPane(): void {
    if (!this.mainPaneEl) return;
    while (this.mainPaneEl.firstChild) {
      (this.mainPaneEl.firstChild as HTMLElement).detach();
    }
  }

  private removeTabButton(tabId: string): void {
    this.tabBarEl?.querySelector(`[data-tab-id="${tabId}"]`)?.remove();
  }

  private removeSplitDivider(splitIdx: number): void {
    const dividers = Array.from(this.splitsWrapperEl?.querySelectorAll(".ai-terminal-divider") ?? []);
    if (dividers.length === 0) return;
    dividers[Math.min(splitIdx, dividers.length - 1)]?.remove();
  }

  private setSplitsVisible(visible: boolean): void {
    if (this.resizerEl) this.resizerEl.style.display = visible ? "" : "none";
    if (!this.splitsWrapperEl || !this.mainPaneEl) return;

    if (visible) {
      this.splitsWrapperEl.style.display = "";
      return;
    }

    this.mainPaneEl.style.flex = "";
    this.splitsWrapperEl.style.flex = "";
    this.splitsWrapperEl.style.display = "none";
  }

  private scheduleFitAll(delayMs = 0): void {
    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    if (this.fitFrameId !== null) {
      window.cancelAnimationFrame(this.fitFrameId);
      this.fitFrameId = null;
    }

    const run = () => {
      this.fitFrameId = window.requestAnimationFrame(() => {
        this.fitFrameId = null;
        this.fitAll();
      });
    };

    if (delayMs > 0) {
      this.fitTimer = setTimeout(() => {
        this.fitTimer = null;
        run();
      }, delayMs);
      return;
    }

    run();
  }

  private bindAction(target: HTMLElement, handler: () => void): void {
    target.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    });
    target.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
  }

  private disposeTab(tab: TabInstance): void {
    for (const timer of tab.timers) clearTimeout(timer);
    tab.timers.length = 0;

    tab.writer.dispose();
    tab.pty.removeAllListeners();

    try {
      tab.pty.kill();
    } catch (err) {
      console.error("AI Terminal: failed to stop PTY.", err);
    }

    try {
      tab.terminal.dispose();
    } catch (err) {
      console.error("AI Terminal: failed to dispose terminal.", err);
    }

    try {
      tab.el.remove();
    } catch (err) {
      console.error("AI Terminal: failed to remove terminal element.", err);
    }
  }

  private shouldKickWindowsPrompt(tab: TabInstance): boolean {
    if (process.platform !== "win32") return false;
    const shell = this.settings.defaultShell || "";
    if (!/pwsh|powershell/i.test(shell)) return false;

    const firstLine = tab.terminal.buffer.active.getLine(0)?.translateToString(true).trim() ?? "";
    const visibleLines = Math.min(tab.terminal.buffer.active.length, 12);

    for (let i = 0; i < visibleLines; i++) {
      const line = tab.terminal.buffer.active.getLine(i)?.translateToString(true).trim() ?? "";
      if (/^[A-Z]:\\.*>\s*$/.test(line) || /^PS [A-Z]:\\.*>\s*$/.test(line)) {
        return false;
      }
    }

    return /powershell/i.test(firstLine) && tab.terminal.buffer.active.cursorY <= 1;
  }

  /** Create terminal infrastructure (PTY, xterm config) but do NOT open into DOM yet */
  private createTerminalInstance(id: string, preset: Preset | null): TabInstance {
    const colors = this.getThemeColors();
    const termEl = createDiv({ cls: "ai-terminal-xterm" });

    const terminal = new Terminal({
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: 1000,
      fastScrollModifier: "alt",
      fastScrollSensitivity: 5,
      theme: {
        background: colors.termBg,
        foreground: colors.fg,
        cursor: colors.accent,
        selectionBackground: colors.isDark ? "#264f78" : "#add6ff",
        selectionForeground: colors.isDark ? "#ffffff" : "#000000",
        black: colors.faint,
        red: colors.isDark ? "#ff6b6b" : "#d63031",
        green: colors.isDark ? "#63d471" : "#27ae60",
        yellow: colors.isDark ? "#ffd43b" : "#c69026",
        blue: colors.isDark ? "#74b9ff" : "#2e86de",
        magenta: colors.isDark ? "#d19df0" : "#a55eea",
        cyan: colors.isDark ? "#63e6e2" : "#00b894",
        white: colors.fg,
        brightBlack: colors.muted,
        brightRed: colors.isDark ? "#ff8787" : "#e74c3c",
        brightGreen: colors.isDark ? "#8ce99a" : "#2ecc71",
        brightYellow: colors.isDark ? "#ffe066" : "#d4a017",
        brightBlue: colors.isDark ? "#91c8f5" : "#3498db",
        brightMagenta: colors.isDark ? "#e0b0ff" : "#9b59b6",
        brightCyan: colors.isDark ? "#81ecec" : "#1abc9c",
        brightWhite: colors.isDark ? "#caced6" : "#3d3f47",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termEl);

    termEl.addEventListener("wheel", (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const current = terminal.options.fontSize as number;
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.max(8, Math.min(32, current + delta));
      if (next === current) return;

      terminal.options.fontSize = next;
      fitAddon.fit();
      pty.resize(terminal.cols, terminal.rows);
      this.scheduleFitAll();
    }, { passive: false });

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.type === "keydown") {
        const key = e.key.toLowerCase();
        const tab = this.getTab(id);
        if (key === "enter") {
          tab?.pty.write("\n");
          return false;
        }
        if (key === "c" && terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
          terminal.clearSelection();
          return false;
        }
        if (key === "v") {
          e.preventDefault();
          navigator.clipboard.readText().then((text) => {
            tab?.pty.write(text);
          }).catch(() => {});
          return false;
        }
      }
      return true;
    });

    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const cwd = this.settings.defaultCwd || vaultPath;
    const shell = this.settings.defaultShell || "/bin/zsh";
    const pipePath = process.platform === "win32" ? "\\\\.\\pipe\\obsidian-ai-terminal" : "/tmp/obsidian-ai-terminal.sock";

    const pty = new PtyProcess(shell, cwd, this.pluginDir, {
      OBSIDIAN_CONTEXT_PIPE: pipePath,
      OBSIDIAN_VAULT_PATH: vaultPath,
    });

    const writer = createTerminalWritePump(terminal);
    pty.on("data", (data: string) => { writer.enqueue(data); });
    pty.on("exit", () => { writer.enqueue("\r\n\x1b[90m[Process exited]\x1b[0m\r\n"); });
    pty.on("error", (err: Error) => { writer.enqueue(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`); });
    terminal.onData((data: string) => { pty.write(data); });

    const timers: ReturnType<typeof setTimeout>[] = [];
    const defaultName = preset ? preset.name : `Terminal ${this.tabCounter}`;

    return {
      id,
      name: defaultName,
      userRenamed: false,
      terminal,
      fitAddon,
      pty,
      writer,
      el: termEl,
      timers,
    };
  }

  /** Start PTY + fit terminal. Called after el is attached to visible DOM. */
  private activateTerminal(tab: TabInstance, preset: Preset | null): void {
    tab.pty.start();
    tab.fitAddon.fit();
    tab.pty.resize(tab.terminal.cols, tab.terminal.rows);
    tab.terminal.focus();
    this.scheduleFitAll();

    if (!preset?.command) {
      tab.timers.push(setTimeout(() => {
        if (this.getTab(tab.id) !== tab || !tab.pty.isRunning) return;
        if (this.shouldKickWindowsPrompt(tab)) {
          tab.pty.write("\n");
        }
      }, 250));
    }

    if (preset?.command) {
      tab.timers.push(setTimeout(() => {
        tab.pty.write(`${preset.command}\n`);
      }, 400));
    }
  }

  addTab(preset: Preset | null = null): void {
    this.tabCounter++;
    const id = `tab-${Date.now()}-${this.tabCounter}`;
    const tab = this.createTerminalInstance(id, preset);
    this.tabs.push(tab);

    this.renderTabButton(tab);
    this.showTabInMain(id);
    this.activateTerminal(tab, preset);
  }

  private showTabInMain(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    if (this.activeTabId === tabId && tab.el.parentElement === this.mainPaneEl) {
      tab.terminal.focus();
      return;
    }

    tab.el.detach();
    this.clearMainPane();
    this.mainPaneEl!.appendChild(tab.el);
    tab.el.style.display = "";

    this.activeTabId = tabId;
    this.updateTabHighlight();
    tab.terminal.focus();
    this.scheduleFitAll();
  }

  private splitOutTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || this.isTabSplit(tabId)) return;

    this.removeTabButton(tabId);

    if (this.activeTabId === tabId) {
      tab.el.detach();
      this.clearMainPane();
      this.activeTabId = null;
    }

    if (this.splits.length > 0) {
      this.splitsWrapperEl!.createDiv({ cls: "ai-terminal-divider" });
    }

    const splitEl = this.splitsWrapperEl!.createDiv({ cls: "ai-terminal-split-pane" });
    const header = splitEl.createDiv({ cls: "ai-terminal-split-header" });
    const leftGroup = header.createDiv({ cls: "ai-terminal-split-left" });
    const splitName = leftGroup.createSpan({ cls: "ai-terminal-split-name", text: tab.name });
    splitName.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.renameTab(tab.id);
    });

    const restoreBtn = leftGroup.createSpan({ cls: "ai-terminal-split-restore", text: "↑" });
    this.bindAction(restoreBtn, () => this.restoreSplitToMain(tab.id));

    const rightGroup = header.createDiv({ cls: "ai-terminal-split-left" });
    const splitCopyBtn = rightGroup.createSpan({ cls: "ai-terminal-split-copy", text: "📄" });
    this.bindAction(splitCopyBtn, () => this.copyNotePath());

    const closeBtn = rightGroup.createSpan({ cls: "ai-terminal-split-close", text: "×" });
    this.bindAction(closeBtn, () => this.closeSplit(tab.id));

    const termArea = splitEl.createDiv({ cls: "ai-terminal-split-term" });
    tab.el.style.display = "";
    termArea.appendChild(tab.el);

    this.splits.push({ id: `split-${Date.now()}`, tabId: tab.id, el: splitEl, headerEl: header });

    if (this.activeTabId === null) {
      const nextTab = this.getNextMainTab(tab.id);
      if (nextTab) this.showTabInMain(nextTab.id);
    }

    this.setSplitsVisible(true);
    this.scheduleFitAll();
  }

  private closeSplit(tabId: string): void {
    const splitIdx = this.splits.findIndex((split) => split.tabId === tabId);
    if (splitIdx === -1) return;

    const split = this.splits[splitIdx];
    const tab = this.getTab(tabId);
    if (!tab) return;

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      this.clearMainPane();
    }

    this.removeSplitDivider(splitIdx);
    split.el.remove();
    this.splits.splice(splitIdx, 1);
    this.tabs = this.tabs.filter((candidate) => candidate.id !== tab.id);

    if (this.splits.length === 0) {
      this.setSplitsVisible(false);
    }

    this.disposeTab(tab);
    this.updateTabHighlight();
    this.scheduleFitAll();
  }

  private renderTabButton(tab: TabInstance): void {
    const btn = this.tabBarEl!.createDiv({
      cls: "ai-terminal-tab-item",
      attr: { "data-tab-id": tab.id, draggable: "true" },
    });

    btn.createSpan({ cls: "ai-terminal-tab-label", text: tab.name });

    const renameBtn = btn.createSpan({ cls: "ai-terminal-tab-rename", text: "✎" });
    this.bindAction(renameBtn, () => this.renameTab(tab.id));

    const closeBtn = btn.createSpan({ cls: "ai-terminal-tab-close", text: "×" });
    this.bindAction(closeBtn, () => this.closeTab(tab.id));

    btn.addEventListener("click", () => this.showTabInMain(tab.id));
    btn.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", tab.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });

    const addEl = this.tabBarEl!.querySelector(".ai-terminal-tab-add");
    if (addEl) {
      this.tabBarEl!.insertBefore(btn, addEl);
    } else {
      this.tabBarEl!.appendChild(btn);
    }
  }

  private closeTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    if (this.isTabSplit(tab.id)) {
      this.closeSplit(tab.id);
      return;
    }

    const wasActive = this.activeTabId === tab.id;
    this.removeTabButton(tab.id);
    this.tabs = this.tabs.filter((candidate) => candidate.id !== tab.id);

    if (wasActive) {
      this.activeTabId = null;
      this.clearMainPane();

      const next = this.getNextMainTab();
      if (next) {
        this.showTabInMain(next.id);
      } else if (this.splits.length > 0) {
        this.restoreSplitToMain(this.splits[0].tabId);
      }
    }

    this.disposeTab(tab);
    this.updateTabHighlight();
    this.scheduleFitAll();
  }

  private restoreSplitToMain(tabId: string): void {
    const splitIdx = this.splits.findIndex((split) => split.tabId === tabId);
    if (splitIdx === -1) return;

    const split = this.splits[splitIdx];
    const tab = this.getTab(tabId);
    if (!tab) return;

    this.removeSplitDivider(splitIdx);
    tab.el.detach();
    split.el.remove();
    this.splits.splice(splitIdx, 1);

    this.renderTabButton(tab);
    this.showTabInMain(tab.id);

    if (this.splits.length === 0) {
      this.setSplitsVisible(false);
    }

    this.scheduleFitAll();
  }

  private updateTabHighlight(): void {
    this.tabBarEl?.querySelectorAll(".ai-terminal-tab-item").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-tab-id") === this.activeTabId);
    });
  }

  private renameTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    new RenameModal(this.app, tab.name, (newName) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === tab.name) return;

      tab.name = trimmed;
      tab.userRenamed = true;

      const tabBtn = this.tabBarEl?.querySelector(`[data-tab-id="${tabId}"] .ai-terminal-tab-label`);
      if (tabBtn) tabBtn.textContent = tab.name;

      const split = this.splits.find((pane) => pane.tabId === tabId);
      if (split) {
        const nameEl = split.headerEl.querySelector(".ai-terminal-split-name");
        if (nameEl) nameEl.textContent = tab.name;
      }
    }).open();
  }

  private fitting = false;

  private fitTab(tab: TabInstance): void {
    if (!tab.el.isConnected || tab.el.offsetParent === null) return;

    const prevCols = tab.terminal.cols;
    const prevRows = tab.terminal.rows;
    tab.fitAddon.fit();

    if (tab.terminal.cols !== prevCols || tab.terminal.rows !== prevRows) {
      tab.pty.resize(tab.terminal.cols, tab.terminal.rows);
    }
  }

  private fitAll(): void {
    if (this.fitting) return;
    this.fitting = true;
    try {
      const active = this.getTab(this.activeTabId);
      if (active) this.fitTab(active);

      for (const split of this.splits) {
        const tab = this.getTab(split.tabId);
        if (tab) this.fitTab(tab);
      }
    } finally {
      this.fitting = false;
    }
  }

  writeOutput(text: string): void {
    const tab = this.getTab(this.activeTabId)
      ?? (this.splits.length > 0 ? this.getTab(this.splits[this.splits.length - 1].tabId) : null);
    tab?.writer.enqueue(text);
  }

  private copyNotePath(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const absPath = `${vaultPath}/${file.path}`;
    navigator.clipboard.writeText(absPath).then(() => {
      new Notice(`Copied: ${absPath}`, 3000);
    }).catch(() => {
      new Notice("Failed to copy note path");
    });
  }

  sendKeys(keys: string): void {
    const tab = this.getTab(this.activeTabId)
      ?? (this.splits.length > 0 ? this.getTab(this.splits[this.splits.length - 1].tabId) : null);
    tab?.pty.write(keys);
  }

  async onClose(): Promise<void> {
    for (const tab of this.tabs) {
      this.disposeTab(tab);
    }

    this.tabs = [];
    this.splits = [];
    this.activeTabId = null;

    if (this.keymapScopeActive) {
      this.app.keymap.popScope(this.keymapScope);
      this.keymapScopeActive = false;
    }

    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    if (this.fitFrameId !== null) {
      window.cancelAnimationFrame(this.fitFrameId);
      this.fitFrameId = null;
    }

    this.resizeObserver?.disconnect();
  }
}

class RenameModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private currentName: string,
    private onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h4", { text: "Rename terminal" });

    const inputEl = contentEl.createEl("input", {
      type: "text",
      value: this.currentName,
      cls: "ai-terminal-rename-input",
    });
    inputEl.style.cssText = "width:100%;padding:6px 8px;font-size:14px;margin:8px 0;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-normal);";

    const submit = () => {
      const val = inputEl.value.trim();
      if (val) this.onSubmit(val);
      this.close();
    };

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") this.close();
    });

    const btnRow = contentEl.createDiv({ cls: "ai-terminal-rename-btns" });
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;";
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const okBtn = btnRow.createEl("button", { text: "Rename", cls: "mod-cta" });
    okBtn.addEventListener("click", submit);

    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
