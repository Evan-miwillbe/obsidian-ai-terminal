import { ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PtyProcess } from "./PtyProcess";
import type { AITerminalSettings, Preset } from "./settings";
import * as path from "path";

export const VIEW_TYPE_TERMINAL = "ai-terminal-view";

interface TabInstance {
  id: string;
  name: string;
  userRenamed: boolean;
  terminal: Terminal;
  fitAddon: FitAddon;
  pty: PtyProcess;
  el: HTMLElement;
  timers: ReturnType<typeof setTimeout>[];
}

interface SplitPane {
  id: string;
  tabId: string;
  el: HTMLElement;
  headerEl: HTMLElement;
}

export class TerminalView extends ItemView {
  // Tab bar tabs (shown in main pane, one at a time)
  private tabs: TabInstance[] = [];
  private activeTabId: string | null = null;
  // Split panes (pinned below, each shows one terminal)
  private splits: SplitPane[] = [];

  private tabBarEl: HTMLElement | null = null;
  private mainPaneEl: HTMLElement | null = null;
  private splitsWrapperEl: HTMLElement | null = null;
  private containerEl_: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private preset: Preset | null;
  private settings: AITerminalSettings;
  private pluginDir: string;
  private keymapScope = new Scope();
  private keymapScopeActive = false;
  private tabCounter = 0;
  private _resizerEl: HTMLElement | null = null;

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
    this.containerEl_ = container;

    // Tab bar
    this.tabBarEl = container.createDiv({ cls: "ai-terminal-tab-bar" });
    const addBtn = this.tabBarEl.createDiv({ cls: "ai-terminal-tab-add", attr: { "aria-label": "New terminal" } });
    addBtn.setText("+");
    addBtn.addEventListener("click", () => this.addTab());

    // Main pane — shows the active tab from tab bar
    this.mainPaneEl = container.createDiv({ cls: "ai-terminal-main-pane" });

    // Drop zone on main pane — drag a tab here to split it out below
    let dropIndicator: HTMLElement | null = null;
    this.mainPaneEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (!dropIndicator) {
        dropIndicator = this.mainPaneEl!.createDiv({ cls: "ai-terminal-drop-indicator" });
        dropIndicator.style.bottom = "0";
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

    // Draggable divider between main pane and splits (hidden until split exists)
    const resizer = container.createDiv({ cls: "ai-terminal-resizer" });

    // Splits wrapper — holds split panes below the main pane
    this.splitsWrapperEl = container.createDiv({ cls: "ai-terminal-splits-wrapper" });
    resizer.style.display = "none";
    let startY = 0;
    let startMainH = 0;
    let startSplitsH = 0;
    resizer.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startMainH = this.mainPaneEl!.getBoundingClientRect().height;
      startSplitsH = this.splitsWrapperEl!.getBoundingClientRect().height;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
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
      // Keep the user-chosen heights — don't reset flex
      this.fitAll();
    };
    // Expose resizer visibility control
    this._resizerEl = resizer;

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.fitAll());
    this.resizeObserver.observe(container);

    // Hotkey scope
    const scopeTarget = container;
    this.registerDomEvent(scopeTarget, "focusin", () => {
      if (!this.keymapScopeActive) { this.app.keymap.pushScope(this.keymapScope); this.keymapScopeActive = true; }
    });
    this.registerDomEvent(scopeTarget, "focusout", (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && scopeTarget.contains(e.relatedTarget)) return;
      if (this.keymapScopeActive) { this.app.keymap.popScope(this.keymapScope); this.keymapScopeActive = false; }
    });

    // Open initial tab
    this.addTab(this.preset);
  }

  private getThemeColors() {
    const cs = getComputedStyle(document.body);
    const bgRaw = cs.getPropertyValue("--background-primary").trim() || "#1e1e2e";
    const accent = cs.getPropertyValue("--interactive-accent").trim() || "#7f6df2";
    const isDark = bgRaw.match(/[0-9a-f]{6}/i)
      ? parseInt(bgRaw.slice(1,3),16)*0.299 + parseInt(bgRaw.slice(3,5),16)*0.587 + parseInt(bgRaw.slice(5,7),16)*0.114 < 128
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

  /** Create a terminal + PTY and return the TabInstance (no DOM attachment yet) */
  private createTerminalInstance(id: string, preset: Preset | null): TabInstance {
    const colors = this.getThemeColors();
    const termEl = createDiv({ cls: "ai-terminal-xterm" });

    const terminal = new Terminal({
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      cursorBlink: true, cursorStyle: "block", allowProposedApi: true,
      theme: {
        background: colors.termBg, foreground: colors.fg, cursor: colors.accent,
        selectionBackground: colors.isDark ? "#264f78" : "#add6ff", selectionForeground: colors.isDark ? "#ffffff" : "#000000",
        black: colors.faint,
        red: colors.isDark ? "#ff6b6b" : "#d63031", green: colors.isDark ? "#63d471" : "#27ae60",
        yellow: colors.isDark ? "#ffd43b" : "#c69026", blue: colors.isDark ? "#74b9ff" : "#2e86de",
        magenta: colors.isDark ? "#d19df0" : "#a55eea", cyan: colors.isDark ? "#63e6e2" : "#00b894",
        white: colors.fg, brightBlack: colors.muted,
        brightRed: colors.isDark ? "#ff8787" : "#e74c3c", brightGreen: colors.isDark ? "#8ce99a" : "#2ecc71",
        brightYellow: colors.isDark ? "#ffe066" : "#d4a017", brightBlue: colors.isDark ? "#91c8f5" : "#3498db",
        brightMagenta: colors.isDark ? "#e0b0ff" : "#9b59b6", brightCyan: colors.isDark ? "#81ecec" : "#1abc9c",
        brightWhite: colors.isDark ? "#caced6" : "#3d3f47",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termEl);

    // Ctrl + scroll wheel to zoom font size
    termEl.addEventListener("wheel", (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const current = terminal.options.fontSize as number;
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.max(8, Math.min(32, current + delta));
      if (next !== current) {
        terminal.options.fontSize = next;
        fitAddon.fit();
        pty.resize(terminal.cols, terminal.rows);
      }
    }, { passive: false });

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.type === "keydown") {
        const key = e.key.toLowerCase();
        const tab = this.tabs.find(t => t.id === id) || this.splits.flatMap(s => {
          const t = this.tabs.find(tt => tt.id === s.tabId); return t ? [t] : [];
        }).find(t => t.id === id);
        if (key === "enter") { tab?.pty.write("\n"); return false; }
        if (key === "c" && terminal.hasSelection()) { navigator.clipboard.writeText(terminal.getSelection()).catch(() => {}); terminal.clearSelection(); return false; }
        if (key === "v") { e.preventDefault(); navigator.clipboard.readText().then((text) => { tab?.pty.write(text); }).catch(() => {}); return false; }
      }
      return true;
    });

    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const cwd = this.settings.defaultCwd || vaultPath;
    const shell = this.settings.defaultShell || "/bin/zsh";
    const pipePath = process.platform === "win32" ? "\\\\.\\pipe\\obsidian-ai-terminal" : "/tmp/obsidian-ai-terminal.sock";

    const pty = new PtyProcess(shell, cwd, this.pluginDir, {
      OBSIDIAN_CONTEXT_PIPE: pipePath, OBSIDIAN_VAULT_PATH: vaultPath,
    });
    pty.on("data", (data: string) => { terminal.write(data); });
    pty.on("exit", () => { terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n"); });
    pty.on("error", (err: Error) => { terminal.write(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`); });
    pty.start();
    terminal.onData((data: string) => { pty.write(data); });

    // Auto-rename tab when the running program sets terminal title (OSC escape sequence)
    // Respects user manual rename — once renamed by user, OSC won't override
    terminal.onTitleChange((title: string) => {
      const tab = this.tabs.find(t => t.id === id);
      if (!tab || !title.trim() || tab.userRenamed) return;
      tab.name = title;
      // Update tab bar label
      const tabBtn = this.tabBarEl?.querySelector(`[data-tab-id="${id}"] .ai-terminal-tab-label`);
      if (tabBtn) tabBtn.textContent = title;
      // Update split pane header
      const split = this.splits.find(s => s.tabId === id);
      if (split) {
        const nameEl = split.headerEl.querySelector(".ai-terminal-split-name");
        if (nameEl) nameEl.textContent = title;
      }
    });

    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => {
      fitAddon.fit();
      pty.resize(terminal.cols, terminal.rows);
      if (preset?.command) { timers.push(setTimeout(() => { pty.write(preset!.command + "\n"); }, 300)); }
    }, 100));

    const shellName = preset ? preset.name : path.basename(shell).replace(/\.(exe|cmd)$/i, "");
    return { id, name: shellName, userRenamed: false, terminal, fitAddon, pty, el: termEl, timers };
  }

  addTab(preset: Preset | null = null): void {
    this.tabCounter++;
    const id = `tab-${Date.now()}-${this.tabCounter}`;
    const tab = this.createTerminalInstance(id, preset);
    this.tabs.push(tab);

    // Add tab button to tab bar
    this.renderTabButton(tab);

    // Show in main pane
    this.showTabInMain(id);
  }

  /** Show a tab's terminal in the main pane */
  private showTabInMain(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Detach from wherever it currently is
    tab.el.detach();

    this.mainPaneEl!.empty();
    this.mainPaneEl!.appendChild(tab.el);
    tab.el.style.display = "";

    this.activeTabId = tabId;
    this.updateTabHighlight();

    setTimeout(() => {
      tab.fitAddon.fit();
      tab.pty.resize(tab.terminal.cols, tab.terminal.rows);
      tab.terminal.focus();
    }, 50);
  }

  /** Split a tab out of the tab bar into a pinned pane below */
  private splitOutTab(tabId: string): void {
    const tabIdx = this.tabs.findIndex(t => t.id === tabId);
    if (tabIdx === -1) return;
    const tab = this.tabs[tabIdx];

    // Remove tab button from tab bar
    this.tabBarEl!.querySelector(`[data-tab-id="${tabId}"]`)?.remove();

    // If this was the active tab in main pane, detach it
    if (this.activeTabId === tabId) {
      tab.el.detach();
      this.mainPaneEl!.empty();
      this.activeTabId = null;
    }

    // Add divider if splits exist
    if (this.splits.length > 0) {
      this.splitsWrapperEl!.createDiv({ cls: "ai-terminal-divider" });
    }

    // Create split pane with header
    const splitEl = this.splitsWrapperEl!.createDiv({ cls: "ai-terminal-split-pane" });
    const header = splitEl.createDiv({ cls: "ai-terminal-split-header" });
    const splitName = header.createSpan({ cls: "ai-terminal-split-name", text: tab.name });
    splitName.addEventListener("dblclick", () => this.renameTab(tab.id));
    const closeBtn = header.createSpan({ cls: "ai-terminal-split-close", text: "×" });
    closeBtn.addEventListener("click", () => {
      if (!confirm(`Close "${tab.name}"?`)) return;
      this.closeSplit(tab.id);
    });

    // Terminal area
    const termArea = splitEl.createDiv({ cls: "ai-terminal-split-term" });
    tab.el.style.display = "";
    termArea.appendChild(tab.el);

    const split: SplitPane = { id: `split-${Date.now()}`, tabId: tab.id, el: splitEl, headerEl: header };
    this.splits.push(split);

    // Show next tab in main pane
    if (this.activeTabId === null && this.tabs.length > 0) {
      // Find the first tab that's not in a split
      const nextTab = this.tabs.find(t => !this.splits.some(s => s.tabId === t.id));
      if (nextTab) this.showTabInMain(nextTab.id);
    }

    setTimeout(() => {
      tab.fitAddon.fit();
      tab.pty.resize(tab.terminal.cols, tab.terminal.rows);
    }, 100);

    // Show resizer
    if (this._resizerEl) this._resizerEl.style.display = "";
  }

  private closeSplit(tabId: string): void {
    const splitIdx = this.splits.findIndex(s => s.tabId === tabId);
    if (splitIdx === -1) return;
    const split = this.splits[splitIdx];
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Kill the terminal
    for (const t of tab.timers) clearTimeout(t);
    tab.pty.kill();
    tab.terminal.dispose();
    tab.el.remove();

    // Remove divider (before this split)
    const dividers = Array.from(this.splitsWrapperEl!.querySelectorAll(".ai-terminal-divider"));
    // Remove the divider adjacent to this split
    if (dividers.length > 0) {
      dividers[Math.min(splitIdx, dividers.length - 1)].remove();
    }

    split.el.remove();
    this.splits.splice(splitIdx, 1);
    this.tabs.splice(this.tabs.indexOf(tab), 1);

    // Hide resizer if no splits left
    if (this.splits.length === 0 && this._resizerEl) {
      this._resizerEl.style.display = "none";
    }
  }

  private renderTabButton(tab: TabInstance): void {
    const btn = this.tabBarEl!.createDiv({ cls: "ai-terminal-tab-item", attr: { "data-tab-id": tab.id, draggable: "true" } });
    const label = btn.createSpan({ cls: "ai-terminal-tab-label", text: tab.name });
    const closeBtn = btn.createSpan({ cls: "ai-terminal-tab-close", text: "×" });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Close "${tab.name}"?`)) return;
      const idx = this.tabs.indexOf(tab);
      this.closeTab(idx);
    });
    btn.addEventListener("click", () => this.showTabInMain(tab.id));
    btn.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.renameTab(tab.id);
    });
    btn.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", tab.id);
      e.dataTransfer!.effectAllowed = "move";
    });
    const addEl = this.tabBarEl!.querySelector(".ai-terminal-tab-add");
    if (addEl) this.tabBarEl!.insertBefore(btn, addEl);
  }

  private closeTab(idx: number): void {
    if (idx === -1) return;
    const tab = this.tabs[idx];
    const wasActive = this.activeTabId === tab.id;
    const isInSplit = this.splits.some(s => s.tabId === tab.id);

    // If tab is in a split pane, close that split
    if (isInSplit) {
      const splitIdx = this.splits.findIndex(s => s.tabId === tab.id);
      if (splitIdx !== -1) {
        const split = this.splits[splitIdx];
        for (const t of tab.timers) clearTimeout(t);
        tab.pty.kill();
        tab.terminal.dispose();
        tab.el.remove();
        const dividers = Array.from(this.splitsWrapperEl!.querySelectorAll(".ai-terminal-divider"));
        if (dividers.length > 0) dividers[Math.min(splitIdx, dividers.length - 1)].remove();
        split.el.remove();
        this.splits.splice(splitIdx, 1);
        this.tabs.splice(idx, 1);
        if (this.splits.length === 0 && this._resizerEl) this._resizerEl.style.display = "none";
        return;
      }
    }

    // Tab is in main pane
    for (const t of tab.timers) clearTimeout(t);
    tab.pty.kill();
    tab.terminal.dispose();
    tab.el.remove();
    this.tabBarEl?.querySelector(`[data-tab-id="${tab.id}"]`)?.remove();
    this.tabs.splice(idx, 1);

    if (wasActive) {
      this.activeTabId = null;
      this.mainPaneEl!.empty();

      // Find next non-split tab
      const next = this.tabs.find(t => !this.splits.some(s => s.tabId === t.id));
      if (next) {
        this.showTabInMain(next.id);
      } else if (this.splits.length > 0) {
        // Last main-pane tab closed but splits exist — promote first split back to main
        this.promoteSplitToMain();
      }
    }
  }

  /** Promote the first split pane's terminal back to the main pane */
  private promoteSplitToMain(): void {
    if (this.splits.length === 0) return;
    const split = this.splits[0];
    const tab = this.tabs.find(t => t.id === split.tabId);
    if (!tab) return;

    // Remove split pane DOM
    const dividers = Array.from(this.splitsWrapperEl!.querySelectorAll(".ai-terminal-divider"));
    if (dividers.length > 0) dividers[0].remove();
    split.el.remove();
    this.splits.splice(0, 1);

    // Add tab button back to tab bar
    this.renderTabButton(tab);

    // Show in main pane
    this.showTabInMain(tab.id);

    // Hide resizer if no more splits
    if (this.splits.length === 0 && this._resizerEl) {
      this._resizerEl.style.display = "none";
    }
  }

  private updateTabHighlight(): void {
    this.tabBarEl?.querySelectorAll(".ai-terminal-tab-item").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-tab-id") === this.activeTabId);
    });
  }

  /** Prompt user to rename a tab — locks the name so OSC auto-title won't override */
  private renameTab(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const newName = window.prompt("Rename terminal:", tab.name);
    if (!newName || !newName.trim() || newName.trim() === tab.name) return;
    tab.name = newName.trim();
    tab.userRenamed = true;
    // Update tab bar label
    const tabBtn = this.tabBarEl?.querySelector(`[data-tab-id="${tabId}"] .ai-terminal-tab-label`);
    if (tabBtn) tabBtn.textContent = tab.name;
    // Update split pane header
    const split = this.splits.find(s => s.tabId === tabId);
    if (split) {
      const nameEl = split.headerEl.querySelector(".ai-terminal-split-name");
      if (nameEl) nameEl.textContent = tab.name;
    }
  }

  private fitAll(): void {
    const active = this.tabs.find(t => t.id === this.activeTabId);
    if (active) {
      active.fitAddon.fit();
      active.pty.resize(active.terminal.cols, active.terminal.rows);
    }
    for (const split of this.splits) {
      const t = this.tabs.find(tt => tt.id === split.tabId);
      if (t) { t.fitAddon.fit(); t.pty.resize(t.terminal.cols, t.terminal.rows); }
    }
  }

  writeOutput(text: string): void {
    const tab = this.tabs.find(t => t.id === this.activeTabId)
      ?? (this.splits.length > 0 ? this.tabs.find(t => t.id === this.splits[this.splits.length - 1].tabId) : null);
    tab?.terminal.write(text);
  }
  sendKeys(keys: string): void {
    const tab = this.tabs.find(t => t.id === this.activeTabId)
      ?? (this.splits.length > 0 ? this.tabs.find(t => t.id === this.splits[this.splits.length - 1].tabId) : null);
    tab?.pty.write(keys);
  }

  async onClose(): Promise<void> {
    for (const tab of this.tabs) {
      for (const t of tab.timers) clearTimeout(t);
      tab.pty.kill();
      tab.terminal.dispose();
    }
    this.tabs = [];
    this.splits = [];
    if (this.keymapScopeActive) { this.app.keymap.popScope(this.keymapScope); this.keymapScopeActive = false; }
    this.resizeObserver?.disconnect();
  }
}
