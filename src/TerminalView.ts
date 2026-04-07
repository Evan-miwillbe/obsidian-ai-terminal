import { ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PtyProcess } from "./PtyProcess";
import type { AITerminalSettings, Preset } from "./settings";

export const VIEW_TYPE_TERMINAL = "ai-terminal-view";

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private pty: PtyProcess | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private preset: Preset | null;
  private settings: AITerminalSettings;
  private pluginDir: string;
  private keymapScope = new Scope();
  private keymapScopeActive = false;
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(leaf: WorkspaceLeaf, settings: AITerminalSettings, pluginDir: string, preset: Preset | null = null) {
    super(leaf);
    this.settings = settings;
    this.pluginDir = pluginDir;
    this.preset = preset;
  }

  getViewType(): string {
    return VIEW_TYPE_TERMINAL;
  }

  getDisplayText(): string {
    if (this.preset) {
      return `Terminal: ${this.preset.name}`;
    }
    return "AI Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ai-terminal-container");

    // xterm.js 초기화
    this.terminal = new Terminal({
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b7066",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // 터미널을 DOM에 마운트
    const terminalEl = container.createDiv({ cls: "ai-terminal-xterm" });
    this.terminal.open(terminalEl);

    // Ctrl 조합 핸들러: 터미널이 Ctrl 키를 직접 처리
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.type === "keydown") {
        const key = e.key.toLowerCase();

        // Ctrl+C: 선택 텍스트 있으면 복사, 없으면 SIGINT
        if (key === "c" && this.terminal?.hasSelection()) {
          navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {});
          this.terminal.clearSelection();
          return false;
        }

        // Ctrl+V: 클립보드 붙여넣기 (브라우저 기본 paste 차단 + 수동 1회)
        if (key === "v") {
          e.preventDefault();
          navigator.clipboard.readText().then((text) => {
            this.pty?.write(text);
          }).catch(() => {});
          return false;
        }

        // 나머지 Ctrl 조합(C/D/Z/L/A/R/U/W/K 등)은 xterm이 처리
        return true;
      }
      return true;
    });

    // Obsidian 핫키 차단: 같은 Scope 인스턴스로 push/pop
    this.registerDomEvent(terminalEl, "focusin", (e: FocusEvent) => {
      // 터미널 내부 포커스 이동은 무시 (버블링 방지)
      if (e.relatedTarget instanceof Node && terminalEl.contains(e.relatedTarget)) return;
      if (!this.keymapScopeActive) {
        this.app.keymap.pushScope(this.keymapScope);
        this.keymapScopeActive = true;
      }
    });
    this.registerDomEvent(terminalEl, "focusout", (e: FocusEvent) => {
      // 터미널 내부 포커스 이동은 무시
      if (e.relatedTarget instanceof Node && terminalEl.contains(e.relatedTarget)) return;
      if (this.keymapScopeActive) {
        this.app.keymap.popScope(this.keymapScope);
        this.keymapScopeActive = false;
      }
    });

    // 초기 fit
    this.pendingTimers.push(setTimeout(() => {
      this.fitAddon?.fit();
      this.startPty();
    }, 100));

    // 리사이즈 감지
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit();
      if (this.terminal && this.pty) {
        this.pty.resize(this.terminal.cols, this.terminal.rows);
      }
    });
    this.resizeObserver.observe(terminalEl);

    // xterm → pty 입력 연결
    this.terminal.onData((data: string) => {
      this.pty?.write(data);
    });
  }

  private startPty(): void {
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const cwd = this.settings.defaultCwd || vaultPath;

    // 프리셋이 있으면 프리셋 명령어로 실행, 없으면 기본 셸
    const shell = this.settings.defaultShell || "/bin/zsh";

    this.pty = new PtyProcess(shell, cwd, this.pluginDir);

    this.pty.on("data", (data: string) => {
      this.terminal?.write(data);
    });

    this.pty.on("exit", () => {
      this.terminal?.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    });

    this.pty.on("error", (err: Error) => {
      this.terminal?.write(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`);
    });

    this.pty.start();

    // fit 후 정확한 크기 전달
    if (this.terminal) {
      this.pty.resize(this.terminal.cols, this.terminal.rows);
    }

    // 프리셋 명령어 자동 실행
    if (this.preset?.command) {
      this.pendingTimers.push(setTimeout(() => {
        this.pty?.write(this.preset!.command + "\n");
      }, 300));
    }
  }

  async onClose(): Promise<void> {
    // 대기 중인 타이머 정리
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers = [];
    // 포커스 상태에서 닫힐 경우 scope 정리
    if (this.keymapScopeActive) {
      this.app.keymap.popScope(this.keymapScope);
      this.keymapScopeActive = false;
    }
    this.resizeObserver?.disconnect();
    this.pty?.kill();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.pty = null;
  }
}
