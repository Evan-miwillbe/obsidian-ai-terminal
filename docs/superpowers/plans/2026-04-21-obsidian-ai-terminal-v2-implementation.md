# Obsidian AI Terminal v2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零重写 obsidian-ai-terminal 插件，代码 100% 自有，分层架构，含嵌入式终端 + 二叉树分栏 + Named Pipe 服务器。

**Architecture:** 7 层架构（PTY 抽象、终端实例、Tab/Split 状态机、Obsidian 视图、设置层、Pipe 服务器），通过 typed EventBus 单向通信。

**Tech Stack:** TypeScript + esbuild + node-pty + @xterm/xterm + Electron named pipe

---

## 文件清单

### 新建文件
| 文件 | 职责 |
|---|---|
| `package.json` (改写) | 添加 node-pty、electron-rebuild 依赖 |
| `esbuild.config.mjs` (改写) | node-pty external 配置 |
| `src/eventbus.ts` | 类型化 EventEmitter |
| `src/pty/types.ts` | PtyProcess 接口定义 |
| `src/pty/NodePtyProcess.ts` | node-pty 实现 |
| `src/pty/capability.ts` | 启动时 node-pty 可用性检测 |
| `src/terminal/TerminalInstance.ts` | xterm.js + FitAddon + WebGL 封装 |
| `src/terminal/theme.ts` | Obsidian CSS 变量 → xterm 主题色提取 |
| `src/settings.ts` (重写) | 设置类型 + SettingTab（仅 v2 配置项） |
| `src/ui/LayoutTree.ts` | 二叉树分栏状态模型 |
| `src/ui/OperationQueue.ts` | 操作队列串行化 |
| `src/ui/TabBar.ts` | 标签栏 DOM 渲染 |
| `src/ui/SplitRenderer.ts` | 分栏 DOM 渲染 + 拖拽分割线 |
| `src/pipe/PipeServer.ts` | JSON-RPC 命名管道服务器 |
| `src/pipe/protocol.ts` | JSON-RPC 方法类型定义 |
| `src/pipe/vaultContext.ts` | Vault 只读上下文查询 |
| `src/view/TerminalView.ts` (重写) | Obsidian ItemView 入口 |
| `src/main.ts` (重写) | 插件入口，编排初始化 |
| `styles.css` (重写) | Obsidian 主题适配样式 |

### 删除文件（最终清理 Task）
`src/PtyProcess.ts`, `src/TerminalView.ts`, `src/acpLayer.ts`, `src/contextPipeServer.ts`, `src/contextSync.ts`, `src/deployRegistry.ts`, `src/hubGenerator.ts`, `src/logWriter.ts`, `src/otCommand.ts`, `src/ruleSync.ts`, `src/scheduler.ts`, `src/vaultIndexer.ts`, `src/vaultQuery.ts`, `src/watchdog.ts`, `src/RoadmapView.ts`, `src/SchemaMapView.ts`, `src/presets.ts`

---

### Task 1: 构建配置 + node-pty 集成

**Files:**
- Modify: `package.json`
- Modify: `esbuild.config.mjs`

添加 node-pty 和 electron-rebuild 依赖，配置 esbuild 将 node-pty 标记为 external（native addon 不能在 bundle 中）。

```json
// package.json 改写
{
  "name": "obsidian-ai-terminal",
  "version": "0.4.0",
  "description": "Embedded terminal for AI CLI tools (Claude Code, Gemini CLI, etc.)",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "rebuild-pty": "electron-rebuild -f -w node-pty"
  },
  "keywords": ["obsidian", "terminal", "claude", "gemini", "ai"],
  "author": "theco",
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "electron-rebuild": "^3.2.9",
    "esbuild": "^0.21.0",
    "obsidian": "latest",
    "typescript": "^5.4.0"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^5.5.0",
    "node-pty": "^1.0.0"
  }
}
```

```javascript
// esbuild.config.mjs 改写
import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // node-pty 是 native addon，必须在外部由 Electron 运行时加载
  external: [
    "obsidian", "electron", "@codemirror/*", "@lezer/*",
    "node-pty", "node-pty/*",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  platform: "node",
}).catch(() => process.exit(1));
```

- [ ] **Step 1: 安装依赖**

```bash
cd C:/Users/Tengm/AppData/Local/Temp/obsidian-ai-terminal
npm install
```

- [ ] **Step 2: electron-rebuild node-pty**

Obsidian 使用 Electron 27+（Node ABI 119），需要将 node-pty 重编译适配。

```bash
npx electron-rebuild -f -w node-pty --version=27.0.0
```

如果上述版本不确定，可尝试：
```bash
npx electron-rebuild -f -w node-pty
```

- [ ] **Step 3: 编译验证**

```bash
npm run build
```

预期：`main.js` 生成，无编译错误。node-pty 被正确标记为 external。

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json esbuild.config.mjs
git commit -m "build: add node-pty dependency + electron-rebuild config"
```

---

### Task 2: EventBus（类型化事件总线）

**Files:**
- Create: `src/eventbus.ts`

所有层间通信的统一通道。下层发事件，上层订阅。类型安全。

```typescript
// src/eventbus.ts
import { EventEmitter } from "events";
import type { TFile } from "obsidian";

export type EventBusEvents = {
  // PTY 层事件
  "pty:data": (tabId: string, data: string) => void;
  "pty:exit": (tabId: string, code: number | null) => void;
  "pty:error": (tabId: string, err: Error) => void;
  "pty:ready": (tabId: string) => void;

  // Tab 状态事件
  "tab:created": (tabId: string, name: string) => void;
  "tab:closed": (tabId: string) => void;
  "tab:activated": (tabId: string) => void;
  "tab:renamed": (tabId: string, newName: string) => void;

  // Split 状态事件
  "split:created": (tabId: string) => void;
  "split:restored": (tabId: string) => void;
  "split:closed": (tabId: string) => void;

  // 主题事件
  "theme:changed": (isDark: boolean) => void;

  // Vault 上下文事件
  "activeNote:changed": (file: TFile | null) => void;

  // Pipe 服务器事件
  "pipe:started": () => void;
  "pipe:stopped": () => void;
};

export class EventBus extends EventEmitter {
  on<K extends keyof EventBusEvents>(event: K, listener: EventBusEvents[K]): this {
    return super.on(event, listener);
  }

  off<K extends keyof EventBusEvents>(event: K, listener: EventBusEvents[K]): this {
    return super.off(event, listener);
  }

  emit<K extends keyof EventBusEvents>(event: K, ...args: Parameters<EventBusEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}
```

- [ ] **Step 1: 创建文件** — 写入上述代码到 `src/eventbus.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/eventbus.ts
git commit -m "feat: add typed EventBus for inter-layer communication"
```

---

### Task 3: PTY 抽象层

**Files:**
- Create: `src/pty/types.ts`
- Create: `src/pty/NodePtyProcess.ts`
- Create: `src/pty/capability.ts`

#### 3a. 接口定义

```typescript
// src/pty/types.ts
export interface PtyProcess {
  start(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  readonly isRunning: boolean;
  readonly pid: number | undefined;
}
```

#### 3b. node-pty 实现

```typescript
// src/pty/NodePtyProcess.ts
import { EventEmitter } from "events";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { PtyProcess } from "./types";

let nodePty: typeof import("node-pty") | null = null;

function getNodePty(): typeof import("node-pty") {
  if (!nodePty) {
    nodePty = require("node-pty");
  }
  return nodePty;
}

export class NodePtyProcess extends EventEmitter implements PtyProcess {
  private pty: IPty | null = null;
  private readonly shell: string;
  private readonly cwd: string;
  private readonly cols: number;
  private readonly rows: number;
  private readonly env: Record<string, string>;

  constructor(
    shell: string,
    cwd: string,
    cols: number = 80,
    rows: number = 24,
    env: Record<string, string> = {},
  ) {
    super();
    this.shell = shell;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.env = env;
  }

  start(): void {
    const pty = getNodePty();
    const options: IPtyForkOptions = {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        COLORTERM: "truecolor",
        ...this.env,
      } as Record<string, string>,
    };

    this.pty = pty.spawn(this.shell, [], options);

    this.pty.onData((data) => this.emit("data", data));
    this.pty.onExit(({ exitCode }) => {
      this.emit("exit", exitCode);
      this.pty = null;
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  kill(): void {
    if (this.pty) {
      this.pty.write("exit\n");
      setTimeout(() => {
        if (this.pty && !this.pty.exited) {
          this.pty.kill();
        }
      }, 500);
    }
  }

  onData(cb: (data: string) => void): () => void {
    this.on("data", cb);
    return () => this.off("data", cb);
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.on("exit", cb);
    return () => this.off("exit", cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.on("error", cb);
    return () => this.off("error", cb);
  }

  get isRunning(): boolean {
    return this.pty !== null && !this.pty.exited;
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }
}
```

#### 3c. Capability Check

```typescript
// src/pty/capability.ts
export interface PtyCapabilityResult {
  available: boolean;
  error?: string;
}

export function checkPtyCapability(): PtyCapabilityResult {
  try {
    require("node-pty");
    return { available: true };
  } catch (err: any) {
    return {
      available: false,
      error: `node-pty 不可用: ${err.message}\n\n请运行: npm install && npx electron-rebuild -f -w node-pty`,
    };
  }
}
```

- [ ] **Step 1: 创建三个文件** — `src/pty/types.ts`, `src/pty/NodePtyProcess.ts`, `src/pty/capability.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/pty/types.ts src/pty/NodePtyProcess.ts src/pty/capability.ts
git commit -m "feat: add PTY abstraction layer with node-pty + capability check"
```

---

### Task 4: 终端实例层

**Files:**
- Create: `src/terminal/theme.ts`
- Create: `src/terminal/TerminalInstance.ts`

#### 4a. 主题色提取

```typescript
// src/terminal/theme.ts
export interface TerminalTheme {
  isDark: boolean;
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

function hexToLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 128;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

export function getObsidianTheme(): TerminalTheme {
  const cs = getComputedStyle(document.body);
  const bgRaw = cs.getPropertyValue("--background-primary").trim() || "#1e1e2e";
  const accent = cs.getPropertyValue("--interactive-accent").trim() || "#7f6df2";
  const isDark = hexToLuminance(bgRaw) < 128;

  const fg = isDark ? "#e2e4e9" : "#1a1b1e";
  const muted = isDark ? "#9ca0ab" : "#5a5d68";
  const faint = isDark ? "#6e7280" : "#8b8f9a";

  return {
    isDark,
    foreground: fg,
    background: isDark ? "#1e1f26ee" : "#f5f5f5ee",
    cursor: accent,
    selectionBackground: isDark ? "#264f78" : "#add6ff",
    selectionForeground: isDark ? "#ffffff" : "#000000",
    black: faint,
    red: isDark ? "#ff6b6b" : "#d63031",
    green: isDark ? "#63d471" : "#27ae60",
    yellow: isDark ? "#ffd43b" : "#c69026",
    blue: isDark ? "#74b9ff" : "#2e86de",
    magenta: isDark ? "#d19df0" : "#a55eea",
    cyan: isDark ? "#63e6e2" : "#00b894",
    white: fg,
    brightBlack: muted,
    brightRed: isDark ? "#ff8787" : "#e74c3c",
    brightGreen: isDark ? "#8ce99a" : "#2ecc71",
    brightYellow: isDark ? "#ffe066" : "#d4a017",
    brightBlue: isDark ? "#91c8f5" : "#3498db",
    brightMagenta: isDark ? "#e0b0ff" : "#9b59b6",
    brightCyan: isDark ? "#81ecec" : "#1abc9c",
    brightWhite: isDark ? "#caced6" : "#3d3f47",
  };
}
```

#### 4b. TerminalInstance 封装

```typescript
// src/terminal/TerminalInstance.ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { getObsidianTheme, type TerminalTheme } from "./theme";

export class TerminalInstance {
  readonly id: string;
  readonly element: HTMLElement;

  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon: WebglAddon | null = null;
  private theme: TerminalTheme;
  private attached = false;
  private resizeCallback: ((cols: number, rows: number) => void) | null = null;

  constructor(id: string, fontSize: number, fontFamily: string) {
    this.id = id;
    this.theme = getObsidianTheme();
    this.element = document.createElement("div");
    this.element.className = "ai-terminal-xterm";

    this.terminal = new Terminal({
      fontSize,
      fontFamily,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: 1000,
      fastScrollModifier: "alt",
      fastScrollSensitivity: 5,
      theme: this.theme,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
  }

  attachTo(container: HTMLElement): void {
    if (this.attached) return;
    container.appendChild(this.element);
    this.terminal.open(this.element);

    // WebGL 降级：try-catch 包裹，失败静默 fallback
    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(() => {
        this.webglAddon?.dispose();
        this.webglAddon = null;
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      // 自动使用内置 Canvas renderer
    }

    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.element.remove();
    this.attached = false;
  }

  fit(): void {
    try {
      this.fitAddon.fit();
    } catch (err) {
      console.warn(`[TerminalInstance] fit() failed for ${this.id}:`, err);
    }
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this.webglAddon?.dispose();
    this.fitAddon.dispose();
    this.terminal.dispose();
    this.element.remove();
    this.attached = false;
  }

  onResize(cb: (cols: number, rows: number) => void): () => void {
    this.resizeCallback = cb;
    this.terminal.onResize(({ cols, rows }) => cb(cols, rows));
    return () => { this.resizeCallback = null; };
  }

  getTheme(): TerminalTheme {
    return this.theme;
  }

  updateTheme(): void {
    const newTheme = getObsidianTheme();
    this.theme = newTheme;
    this.terminal.options.theme = newTheme;
  }
}
```

- [ ] **Step 1: 创建两个文件** — `src/terminal/theme.ts`, `src/terminal/TerminalInstance.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/terminal/theme.ts src/terminal/TerminalInstance.ts
git commit -m "feat: add TerminalInstance layer with xterm.js + WebGL fallback"
```

---

### Task 5: 设置层

**Files:**
- Create: `src/settings_v2.ts`（临时文件名，Task 10 时替换为 settings.ts）

```typescript
// src/settings_v2.ts
import { App, PluginSettingTab, Setting, Notice } from "obsidian";

export interface Preset {
  name: string;
  command: string;
}

export interface AITerminalV2Settings {
  defaultShell: string;
  defaultCwd: string;
  fontSize: number;
  fontFamily: string;
  presets: Preset[];
  pipeServerEnabled: boolean;
  enableWebGL: boolean;
}

function getDefaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

export const DEFAULT_V2_SETTINGS: AITerminalV2Settings = {
  defaultShell: getDefaultShell(),
  defaultCwd: "",
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
  presets: [{ name: "Terminal", command: "" }],
  pipeServerEnabled: true,
  enableWebGL: true,
};

export class AITerminalV2SettingTab extends PluginSettingTab {
  plugin: any; // 插件实例引用，类型为 any 避免循环依赖

  constructor(app: App, plugin: any) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Terminal v2 Settings" });

    new Setting(containerEl)
      .setName("Default shell")
      .setDesc("Shell to use when opening a terminal")
      .addText((text) =>
        text.setPlaceholder(getDefaultShell())
          .setValue(this.plugin.settings.defaultShell)
          .onChange(async (value) => {
            this.plugin.settings.defaultShell = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Default working directory (empty = vault root)")
      .addText((text) =>
        text.setPlaceholder("Vault root")
          .setValue(this.plugin.settings.defaultCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultCwd = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider.setLimits(10, 24, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font family")
      .setDesc("Terminal font family (CSS format)")
      .addText((text) =>
        text.setValue(this.plugin.settings.fontFamily)
          .onChange(async (value) => {
            this.plugin.settings.fontFamily = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable Pipe server")
      .setDesc("Expose vault context via Named Pipe for external tools")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pipeServerEnabled)
          .onChange(async (value) => {
            this.plugin.settings.pipeServerEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable WebGL acceleration")
      .setDesc("Use GPU-accelerated rendering (fallback to Canvas on failure)")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableWebGL)
          .onChange(async (value) => {
            this.plugin.settings.enableWebGL = value;
            await this.plugin.saveSettings();
          })
      );

    // Presets
    containerEl.createEl("h3", { text: "Presets" });
    this.plugin.settings.presets.forEach((preset: Preset, index: number) => {
      const s = new Setting(containerEl)
        .setName(preset.name)
        .setDesc(preset.command || "(default shell)")
        .addText((text) =>
          text.setPlaceholder("Name").setValue(preset.name)
            .onChange(async (value) => {
              this.plugin.settings.presets[index].name = value;
              await this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text.setPlaceholder("Command").setValue(preset.command)
            .onChange(async (value) => {
              this.plugin.settings.presets[index].command = value;
              await this.plugin.saveSettings();
            })
        );

      if (index > 0) {
        s.addExtraButton((btn) =>
          btn.setIcon("trash").setTooltip("Delete preset")
            .onClick(async () => {
              this.plugin.settings.presets.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            })
        );
      }
    });

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Add preset").onClick(async () => {
        this.plugin.settings.presets.push({ name: "New Preset", command: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
```

- [ ] **Step 1: 创建文件** — `src/settings_v2.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/settings_v2.ts
git commit -m "feat: add v2 settings with simplified config"
```

---

### Task 6: UI 层 — LayoutTree + OperationQueue

**Files:**
- Create: `src/ui/LayoutTree.ts`
- Create: `src/ui/OperationQueue.ts`

#### 6a. LayoutTree（二叉树分栏模型）

```typescript
// src/ui/LayoutTree.ts
import type { EventBus } from "../eventbus";
import type { TerminalInstance } from "../terminal/TerminalInstance";

export type LayoutNode =
  | { type: "leaf"; tabId: string }
  | { type: "split"; direction: "horizontal" | "vertical"; first: LayoutNode; second: LayoutNode; ratio: number };

export interface TabInfo {
  id: string;
  name: string;
  instance: TerminalInstance;
}

export class LayoutTree {
  private root: LayoutNode | null = null;
  private tabs = new Map<string, TabInfo>();
  private activeTabId: string | null = null;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  createTab(info: TabInfo): void {
    this.tabs.set(info.id, info);
    if (this.root === null) {
      this.root = { type: "leaf", tabId: info.id };
    }
    this.activeTabId = info.id;
    this.eventBus.emit("tab:created", info.id, info.name);
    this.eventBus.emit("tab:activated", info.id);
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab.instance.dispose();
    this.tabs.delete(tabId);

    if (this.root) {
      this.root = this.removeFromTree(this.root, tabId);
    }

    if (this.activeTabId === tabId) {
      // 激活相邻 tab
      const nextTab = this.getLeafTabIds().find((id) => id !== tabId);
      this.activeTabId = nextTab ?? null;
      if (this.activeTabId) {
        this.eventBus.emit("tab:activated", this.activeTabId);
      }
    }

    this.eventBus.emit("tab:closed", tabId);
  }

  activateTab(tabId: string): void {
    if (!this.tabs.has(tabId)) return;
    this.activeTabId = tabId;
    this.eventBus.emit("tab:activated", tabId);
  }

  splitOutTab(tabId: string, direction: "horizontal" | "vertical" = "horizontal"): void {
    if (!this.tabs.has(tabId)) return;
    if (this.root === null) return;

    this.root = this.splitLeafInTree(this.root, tabId, direction);
    this.eventBus.emit("split:created", tabId);
  }

  restoreToMain(tabId: string): void {
    if (!this.tabs.has(tabId)) return;
    // 将 split 节点替换为 leaf
    if (this.root) {
      this.root = this.flattenToLeaf(this.root, tabId);
    }
    this.eventBus.emit("split:restored", tabId);
  }

  renameTab(tabId: string, newName: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.name = newName;
    this.eventBus.emit("tab:renamed", tabId, newName);
  }

  getTab(tabId: string): TabInfo | undefined {
    return this.tabs.get(tabId);
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getAllTabIds(): string[] {
    return Array.from(this.tabs.keys());
  }

  getRoot(): LayoutNode | null {
    return this.root;
  }

  // ── 内部方法 ──

  private getLeafTabIds(node: LayoutNode | null = this.root): string[] {
    if (!node) return [];
    if (node.type === "leaf") return [node.tabId];
    return [...this.getLeafTabIds(node.first), ...this.getLeafTabIds(node.second)];
  }

  private removeFromTree(node: LayoutNode, tabId: string): LayoutNode | null {
    if (node.type === "leaf") {
      return node.tabId === tabId ? null : node;
    }
    const firstResult = this.removeFromTree(node.first, tabId);
    const secondResult = this.removeFromTree(node.second, tabId);

    if (firstResult === null && secondResult === null) return null;
    if (firstResult === null) return secondResult;
    if (secondResult === null) return firstResult;
    return { type: "split", direction: node.direction, first: firstResult, second: secondResult, ratio: node.ratio };
  }

  private splitLeafInTree(node: LayoutNode, tabId: string, direction: "horizontal" | "vertical"): LayoutNode {
    if (node.type === "leaf") {
      if (node.tabId === tabId) {
        // 创建新 tab 作为 split 的另一侧
        const newTabId = `tab-split-${Date.now()}`;
        const newTab = this.tabs.get(tabId); // 复用当前 tab 的信息作为占位
        // 注意：新 tab 的实际创建由调用方负责，这里只修改树结构
        return { type: "split", direction, first: node, second: { type: "leaf", tabId: "__pending__" }, ratio: 0.5 };
      }
      return node;
    }
    return {
      type: "split",
      direction: node.direction,
      first: this.splitLeafInTree(node.first, tabId, direction),
      second: this.splitLeafInTree(node.second, tabId, direction),
      ratio: node.ratio,
    };
  }

  private flattenToLeaf(node: LayoutNode, targetTabId: string): LayoutNode {
    if (node.type === "leaf") return node;
    // 递归查找包含 targetTabId 的子树并替换
    const firstLeaves = this.getLeafTabIds(node.first);
    if (firstLeaves.includes(targetTabId)) {
      return this.flattenToLeaf(node.first, targetTabId);
    }
    return this.flattenToLeaf(node.second, targetTabId);
  }
}
```

#### 6b. OperationQueue（操作队列）

```typescript
// src/ui/OperationQueue.ts
export class OperationQueue {
  private queue: Array<() => void> = [];
  private processing = false;

  enqueue(op: () => void): void {
    this.queue.push(op);
    if (!this.processing) {
      this.process();
    }
  }

  private process(): void {
    this.processing = true;
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      op();
    }
    this.processing = false;
  }
}
```

- [ ] **Step 1: 创建两个文件** — `src/ui/LayoutTree.ts`, `src/ui/OperationQueue.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/ui/LayoutTree.ts src/ui/OperationQueue.ts
git commit -m "feat: add LayoutTree binary tree model + OperationQueue"
```

---

### Task 7: UI 层 — TabBar + SplitRenderer

**Files:**
- Create: `src/ui/TabBar.ts`
- Create: `src/ui/SplitRenderer.ts`

#### 7a. TabBar（标签栏渲染）

```typescript
// src/ui/TabBar.ts
import type { LayoutTree } from "./LayoutTree";
import type { OperationQueue } from "./OperationQueue";
import type { EventBus } from "../eventbus";

export class TabBar {
  private el: HTMLElement;
  private layoutTree: LayoutTree;
  private queue: OperationQueue;
  private eventBus: EventBus;
  private tabButtons = new Map<string, HTMLElement>();
  private addBtn: HTMLElement;
  private copyBtn: HTMLElement;

  constructor(
    container: HTMLElement,
    layoutTree: LayoutTree,
    queue: OperationQueue,
    eventBus: EventBus,
    private createNewTab: () => void,
    private copyNotePath: () => void,
  ) {
    this.layoutTree = layoutTree;
    this.queue = queue;
    this.eventBus = eventBus;

    this.el = container.createDiv({ cls: "ai-terminal-tab-bar" });

    // + 新建按钮
    this.addBtn = this.el.createDiv({ cls: "ai-terminal-tab-add", attr: { "aria-label": "New terminal" } });
    this.addBtn.setText("+");
    this.addBtn.addEventListener("click", () => createNewTab());

    // 📄 复制按钮
    this.copyBtn = this.el.createDiv({ cls: "ai-terminal-tab-copy", attr: { "aria-label": "Copy note path" } });
    this.copyBtn.setText("📄");
    this.copyBtn.addEventListener("click", () => copyNotePath());

    this.renderAllTabs();
  }

  private renderAllTabs(): void {
    // 清除旧按钮（保留 + 和复制按钮）
    for (const [tabId, btn] of this.tabButtons) {
      btn.remove();
    }
    this.tabButtons.clear();

    // 重新渲染
    const tabIds = this.layoutTree.getAllTabIds();
    for (const tabId of tabIds) {
      this.renderTabButton(tabId);
    }
  }

  private renderTabButton(tabId: string): void {
    const tab = this.layoutTree.getTab(tabId);
    if (!tab) return;

    const btn = this.el.createDiv({ cls: "ai-terminal-tab-item", attr: { "data-tab-id": tabId } });
    if (tabId === this.layoutTree.getActiveTabId()) {
      btn.classList.add("active");
    }

    const label = btn.createSpan({ cls: "ai-terminal-tab-label", text: tab.name });
    label.addEventListener("click", () => {
      this.queue.enqueue(() => this.layoutTree.activateTab(tabId));
    });

    // 右键重命名
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.renameTab(tabId);
    });

    // 关闭按钮
    const closeBtn = btn.createSpan({ cls: "ai-terminal-tab-close", text: "×" });
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`Close "${tab.name}"?`)) {
        this.queue.enqueue(() => this.layoutTree.closeTab(tabId));
      }
    });

    // 拖拽
    btn.setAttribute("draggable", "true");
    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", tabId);
      e.dataTransfer!.effectAllowed = "move";
    });

    this.tabButtons.set(tabId, btn);

    // 插入到 + 按钮前面
    if (this.addBtn.parentElement === this.el) {
      this.el.insertBefore(btn, this.addBtn);
    }
  }

  private renameTab(tabId: string): void {
    const tab = this.layoutTree.getTab(tabId);
    if (!tab) return;

    const newName = prompt("Rename terminal:", tab.name);
    if (newName && newName.trim()) {
      this.queue.enqueue(() => this.layoutTree.renameTab(tabId, newName.trim()));
    }
  }

  // 响应 EventBus 事件
  setupEventListeners(): void {
    this.eventBus.on("tab:created", () => this.renderAllTabs());
    this.eventBus.on("tab:closed", () => this.renderAllTabs());
    this.eventBus.on("tab:activated", () => this.renderAllTabs());
    this.eventBus.on("tab:renamed", () => this.renderAllTabs());
  }
}
```

#### 7b. SplitRenderer（分栏渲染 + 拖拽分割线）

```typescript
// src/ui/SplitRenderer.ts
import type { LayoutTree, LayoutNode } from "./LayoutTree";
import type { OperationQueue } from "./OperationQueue";
import type { EventBus } from "../eventbus";
import type { TerminalInstance } from "../terminal/TerminalInstance";

export class SplitRenderer {
  private wrapperEl: HTMLElement;
  private resizerEl: HTMLElement;
  private mainPaneEl: HTMLElement;
  private layoutTree: LayoutTree;
  private queue: OperationQueue;
  private eventBus: EventBus;
  private splitContainers = new Map<string, HTMLElement>();

  constructor(
    container: HTMLElement,
    mainPaneEl: HTMLElement,
    layoutTree: LayoutTree,
    queue: OperationQueue,
    eventBus: EventBus,
    private dropSplitTab: (tabId: string) => void,
  ) {
    this.mainPaneEl = mainPaneEl;
    this.layoutTree = layoutTree;
    this.queue = queue;
    this.eventBus = eventBus;

    // 分割线
    this.resizerEl = container.createDiv({ cls: "ai-terminal-resizer" });
    this.resizerEl.style.display = "none";

    // 分栏容器
    this.wrapperEl = container.createDiv({ cls: "ai-terminal-splits-wrapper" });
    this.wrapperEl.style.display = "none";

    this.setupResizer();
    this.setupDropZone();
  }

  renderTree(node: LayoutNode | null, container: HTMLElement): void {
    if (!node) return;

    if (node.type === "leaf") {
      this.renderLeaf(node.tabId, container);
    } else {
      this.renderSplit(node, container);
    }
  }

  private renderLeaf(tabId: string, container: HTMLElement): void {
    const tab = this.layoutTree.getTab(tabId);
    if (!tab) return;

    const instance = tab.instance;
    // 如果当前不在容器中，attach 进来
    if (!instance.element.parentElement) {
      container.appendChild(instance.element);
    } else if (instance.element.parentElement !== container) {
      instance.element.remove();
      container.appendChild(instance.element);
    }
  }

  private renderSplit(node: Extract<LayoutNode, { type: "split" }>, container: HTMLElement): void {
    container.style.display = "flex";
    container.style.flexDirection = node.direction === "horizontal" ? "column" : "row";

    const firstContainer = container.createDiv({ cls: "ai-terminal-split-pane" });
    const secondContainer = container.createDiv({ cls: "ai-terminal-split-pane" });

    // 按比例设置 flex
    firstContainer.style.flex = `0 0 ${node.ratio * 100}%`;
    secondContainer.style.flex = `0 0 ${(1 - node.ratio) * 100}%`;

    this.renderTree(node.first, firstContainer);
    this.renderTree(node.second, secondContainer);
  }

  private setupResizer(): void {
    let startY = 0, startMainH = 0, startSplitsH = 0;

    this.resizerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startMainH = this.mainPaneEl.getBoundingClientRect().height;
      startSplitsH = this.wrapperEl.getBoundingClientRect().height;

      const onMove = (e: MouseEvent) => {
        const delta = e.clientY - startY;
        const totalH = startMainH + startSplitsH;
        let newMainH = Math.max(40, startMainH + delta);
        let newSplitsH = totalH - newMainH;
        if (newSplitsH < 26) { newSplitsH = 26; newMainH = totalH - 26; }

        this.mainPaneEl.style.flex = `0 0 ${newMainH}px`;
        this.wrapperEl.style.flex = `0 0 ${newSplitsH}px`;
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        this.fitAllTerminals();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  private setupDropZone(): void {
    this.mainPaneEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
    });

    this.mainPaneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const tabId = e.dataTransfer?.getData("text/plain");
      if (tabId) {
        this.queue.enqueue(() => this.dropSplitTab(tabId));
      }
    });

    this.wrapperEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
    });
  }

  private fitAllTerminals(): void {
    for (const tabId of this.layoutTree.getAllTabIds()) {
      const tab = this.layoutTree.getTab(tabId);
      tab?.instance.fit();
    }
  }

  show(): void {
    this.resizerEl.style.display = "";
    this.wrapperEl.style.display = "";
  }

  hide(): void {
    this.resizerEl.style.display = "none";
    this.wrapperEl.style.display = "none";
  }
}
```

- [ ] **Step 1: 创建两个文件** — `src/ui/TabBar.ts`, `src/ui/SplitRenderer.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/ui/TabBar.ts src/ui/SplitRenderer.ts
git commit -m "feat: add TabBar and SplitRenderer UI components"
```

---

### Task 8: Pipe 服务器层

**Files:**
- Create: `src/pipe/protocol.ts`
- Create: `src/pipe/vaultContext.ts`
- Create: `src/pipe/PipeServer.ts`

#### 8a. JSON-RPC 协议定义

```typescript
// src/pipe/protocol.ts
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

export type MethodHandler = (params: Record<string, any> | undefined) => any | Promise<any>;

export const METHOD_HANDLERS: Record<string, MethodHandler> = {};

// 方法注册表——由 PipeServer 初始化时注入
export function registerMethod(method: string, handler: MethodHandler): void {
  METHOD_HANDLERS[method] = handler;
}
```

#### 8b. Vault 上下文查询

```typescript
// src/pipe/vaultContext.ts
import type { App, TFile } from "obsidian";

export class VaultContext {
  constructor(private app: App) {}

  getVaultPath(): string {
    return (this.app.vault.adapter as any).basePath as string;
  }

  getActiveNote(): { path: string; content: string } | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) return null;
    try {
      const content = this.app.vault.readSync(file);
      return { path: file.path, content };
    } catch {
      return { path: file.path, content: "" };
    }
  }

  searchVault(query: string): Array<{ path: string; title: string; snippet: string }> {
    const results: Array<{ path: string; title: string; snippet: string }> = [];
    const lowerQuery = query.toLowerCase();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const nameLower = file.name.toLowerCase();
      if (nameLower.includes(lowerQuery)) {
        try {
          const content = this.app.vault.readSync(file);
          const snippet = this.extractSnippet(content, query);
          results.push({
            path: file.path,
            title: file.name.replace(/\.md$/, ""),
            snippet,
          });
        } catch {
          results.push({ path: file.path, title: file.name.replace(/\.md$/, ""), snippet: "" });
        }
      }
    }
    return results.slice(0, 20); // 限制 20 条
  }

  readNote(path: string): { content: string; frontmatter: Record<string, any> } | null {
    const file = this.app.vault.getFileByPath(path);
    if (!file || !(file instanceof TFile)) return null;

    try {
      const content = this.app.vault.readSync(file);
      let frontmatter: Record<string, any> = {};
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        try {
          frontmatter = JSON.parse(fmMatch[1]); // 简化处理，可用 yaml 解析器
        } catch { /* ignore */ }
      }
      return { content, frontmatter };
    } catch {
      return null;
    }
  }

  openNote(path: string): boolean {
    const file = this.app.vault.getFileByPath(path);
    if (!file || !(file instanceof TFile)) return false;
    this.app.workspace.getLeaf(false).openFile(file);
    return true;
  }

  sendKeys(keys: string, sendKeysFn: (keys: string) => void): boolean {
    sendKeysFn(keys);
    return true;
  }

  private extractSnippet(content: string, query: string): string {
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) return content.slice(0, 100);
    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + query.length + 70);
    return (start > 0 ? "..." : "") + content.slice(start, end).trim() + (end < content.length ? "..." : "");
  }
}
```

#### 8c. PipeServer

```typescript
// src/pipe/PipeServer.ts
import * as net from "net";
import * as fs from "fs";
import type { App, TFile } from "obsidian";
import type { EventBus } from "../eventbus";
import type { VaultContext } from "./vaultContext";
import type { JsonRpcRequest, JsonRpcResponse, MethodHandler } from "./protocol";

const isWindows = process.platform === "win32";

export function getPipePath(): string {
  return isWindows ? "\\\\.\\pipe\\obsidian-ai-terminal" : "/tmp/obsidian-ai-terminal.sock";
}

export class PipeServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private eventBus: EventBus;
  private vaultContext: VaultContext;
  private app: App;
  private sendKeysFn: ((keys: string) => void) | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(app: App, eventBus: EventBus, vaultContext: VaultContext) {
    this.app = app;
    this.eventBus = eventBus;
    this.vaultContext = vaultContext;
  }

  setSendKeysFn(fn: (keys: string) => void): void {
    this.sendKeysFn = fn;
  }

  start(): void {
    if (this.server) return;

    // Unix: 移除已有 socket
    if (!isWindows) {
      try { fs.unlinkSync(getPipePath()); } catch { /* ignore */ }
    }

    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString("utf-8");
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const request = JSON.parse(line) as JsonRpcRequest;
            const response = this.handleRequest(request);
            if (response) socket.write(JSON.stringify(response) + "\n");
          } catch {
            socket.write(JSON.stringify({
              jsonrpc: "2.0", id: null,
              error: { code: -32700, message: "Parse error" },
            } as JsonRpcResponse) + "\n");
          }
        }
      });

      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });

    this.server.listen(getPipePath());
    this.eventBus.emit("pipe:started");

    // 监听 active note 变化并广播
    const unsub = this.app.workspace.on("active-leaf-change", () => {
      const file = this.app.workspace.getActiveFile();
      this.broadcastNotification("vault/activeNoteChanged", {
        path: (file as TFile | null)?.path ?? null,
      });
    });
    this.unsubscribe.push(() => this.app.workspace.offByRef(unsub));
  }

  stop(): void {
    for (const unsub of this.unsubscribe) unsub();
    this.unsubscribe = [];

    for (const client of this.clients) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (!isWindows) {
      try { fs.unlinkSync(getPipePath()); } catch { /* ignore */ }
    }
    this.eventBus.emit("pipe:stopped");
  }

  private handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
    const { method, id, params } = request;

    const handlers: Record<string, MethodHandler> = {
      "context/get": () => ({
        vaultPath: this.vaultContext.getVaultPath(),
        activeNote: this.vaultContext.getActiveNote(),
      }),
      "context/activeNote": () => this.vaultContext.getActiveNote(),
      "vault/search": () => {
        const query = params?.query;
        if (!query) return { error: "query required" };
        return this.vaultContext.searchVault(query);
      },
      "vault/read": () => {
        const path = params?.path;
        if (!path) return { error: "path required" };
        return this.vaultContext.readNote(path);
      },
      "obsidian/openNote": () => {
        const path = params?.path;
        if (!path) return { error: "path required" };
        return { ok: this.vaultContext.openNote(path) };
      },
      "terminal/sendKeys": () => {
        const keys = params?.keys;
        if (!keys || !this.sendKeysFn) return { error: "keys required or no terminal" };
        return { ok: this.vaultContext.sendKeys(keys, this.sendKeysFn) };
      },
      "ping": () => ({ pong: true, timestamp: new Date().toISOString() }),
    };

    const handler = handlers[method];
    if (!handler) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }

    try {
      const result = handler();
      return { jsonrpc: "2.0", id, result };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: err.message } };
    }
  }

  private broadcastNotification(method: string, params: any): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    for (const client of this.clients) {
      try { if (!client.destroyed) client.write(message); } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 1: 创建三个文件** — `src/pipe/protocol.ts`, `src/pipe/vaultContext.ts`, `src/pipe/PipeServer.ts`

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/pipe/protocol.ts src/pipe/vaultContext.ts src/pipe/PipeServer.ts
git commit -m "feat: add Pipe server layer with JSON-RPC and vault context"
```

---

### Task 9: Obsidian 视图层 + 主入口

**Files:**
- Create: `src/view/TerminalView.ts`（新文件，覆盖旧文件）
- Create: `src/main_v2.ts`（临时文件名，Task 10 时替换为 main.ts）

#### 9a. TerminalView

```typescript
// src/view/TerminalView.ts
import { ItemView, Notice, WorkspaceLeaf, debounce } from "obsidian";
import { EventBus } from "../eventbus";
import { LayoutTree, type TabInfo } from "../ui/LayoutTree";
import { OperationQueue } from "../ui/OperationQueue";
import { TabBar } from "../ui/TabBar";
import { SplitRenderer, type LayoutNode } from "../ui/SplitRenderer";
import { TerminalInstance } from "../terminal/TerminalInstance";
import { NodePtyProcess } from "../pty/NodePtyProcess";
import type { AITerminalV2Settings } from "../settings_v2";

export const VIEW_TYPE_TERMINAL_V2 = "ai-terminal-view-v2";

export class TerminalView extends ItemView {
  private eventBus: EventBus;
  private layoutTree: LayoutTree;
  private queue: OperationQueue;
  private tabBar: TabBar | null = null;
  private splitRenderer: SplitRenderer | null = null;
  private mainPaneEl: HTMLElement | null = null;
  private settings: AITerminalV2Settings;
  private pluginDir: string;
  private tabCounter = 0;
  private resizeObserver: ResizeObserver | null = null;
  // PTY 引用映射（与 TerminalInstance 解耦）
  private ptyMap = new Map<string, InstanceType<typeof import("../pty/NodePtyProcess").NodePtyProcess>>();

  constructor(leaf: WorkspaceLeaf, settings: AITerminalV2Settings, pluginDir: string) {
    super(leaf);
    this.settings = settings;
    this.pluginDir = pluginDir;
    this.eventBus = new EventBus();
    this.layoutTree = new LayoutTree(this.eventBus);
    this.queue = new OperationQueue();
  }

  getViewType(): string { return VIEW_TYPE_TERMINAL_V2; }
  getDisplayText(): string { return "AI Terminal v2"; }
  getIcon(): string { return "terminal"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ai-terminal-container");

    // 主面板
    this.mainPaneEl = container.createDiv({ cls: "ai-terminal-main-pane" });

    // UI 组件
    this.tabBar = new TabBar(
      container, this.layoutTree, this.queue, this.eventBus,
      () => this.createNewTab(),
      () => this.copyNotePath(),
    );
    this.tabBar.setupEventListeners();

    this.splitRenderer = new SplitRenderer(
      container, this.mainPaneEl, this.layoutTree, this.queue, this.eventBus,
      (tabId) => this.splitOutTab(tabId),
    );

    // 窗口 resize 监听
    this.resizeObserver = new ResizeObserver(debounce(() => this.fitAll(), 200, true));
    this.resizeObserver.observe(container);

    // 主题变化监听
    const observer = new MutationObserver(() => {
      for (const tabId of this.layoutTree.getAllTabIds()) {
        this.layoutTree.getTab(tabId)?.instance.updateTheme();
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    // 活动笔记变化
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.eventBus.emit("activeNote:changed", this.app.workspace.getActiveFile());
      })
    );

    // 创建首个 tab
    this.createNewTab();
  }

  private createNewTab(): void {
    this.tabCounter++;
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const cwd = this.settings.defaultCwd || vaultPath;
    const shell = this.settings.defaultShell;
    const id = `tab-${Date.now()}-${this.tabCounter}`;
    const name = `Terminal ${this.tabCounter}`;

    const instance = new TerminalInstance(id, this.settings.fontSize, this.settings.fontFamily);
    const pty = new NodePtyProcess(shell, cwd, 80, 24, {
      OBSIDIAN_CONTEXT_PIPE: process.platform === "win32" ? "\\\\.\\pipe\\obsidian-ai-terminal" : "/tmp/obsidian-ai-terminal.sock",
      OBSIDIAN_VAULT_PATH: vaultPath,
    });

    // PTY → xterm
    const unsubData = pty.onData((data) => { instance.write(data); });
    const unsubExit = pty.onExit((code) => {
      instance.write(`\r\n\x1b[90m[Process exited${code != null ? " with code " + code : ""}]\x1b[0m\r\n`);
    });
    const unsubError = pty.onError((err) => {
      instance.write(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`);
    });

    // xterm → PTY
    instance.onResize((cols, rows) => { pty.resize(cols, rows); });

    // attach 到主面板
    if (this.mainPaneEl) {
      instance.attachTo(this.mainPaneEl);
      instance.fit();
      pty.resize(instance["terminal"].cols, instance["terminal"].rows);
    }

    // 启动 PTY
    pty.start();
    instance.focus();

    // 保存 pty 引用到 ptyMap
    this.ptyMap.set(id, pty);

    const tabInfo: TabInfo = { id, name, instance };
    this.queue.enqueue(() => this.layoutTree.createTab(tabInfo));
  }

  private splitOutTab(tabId: string): void {
    // 从 tree 中取出 tab，创建新 split
    const tab = this.layoutTree.getTab(tabId);
    if (!tab) return;

    // 分离当前 instance
    tab.instance.detach();

    this.queue.enqueue(() => {
      this.layoutTree.splitOutTab(tabId, "horizontal");
      // 重新 attach + fit
      tab.instance.attachTo(this.splitRenderer!.wrapperEl);
      tab.instance.fit();
      this.splitRenderer?.show();
    });
  }

  private copyNotePath(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note"); return; }
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const absPath = vaultPath + "/" + file.path;
    navigator.clipboard.writeText(absPath).then(() => new Notice(`Copied: ${absPath}`, 3000));
  }

  sendKeys(keys: string): void {
    const activeId = this.layoutTree.getActiveTabId();
    if (!activeId) return;
    const pty = this.ptyMap.get(activeId);
    pty?.write(keys);
  }

  private fitAll(): void {
    for (const tabId of this.layoutTree.getAllTabIds()) {
      this.layoutTree.getTab(tabId)?.instance.fit();
    }
  }

  writeOutput(text: string): void {
    const activeId = this.layoutTree.getActiveTabId();
    if (activeId) this.layoutTree.getTab(activeId)?.instance.write(text);
  }

  async onClose(): Promise<void> {
    // 先 kill 所有 pty 进程
    for (const [, pty] of this.ptyMap) {
      try { pty.kill(); } catch { /* ignore */ }
    }
    this.ptyMap.clear();

    for (const tabId of this.layoutTree.getAllTabIds()) {
      this.layoutTree.getTab(tabId)?.instance.dispose();
    }
    this.resizeObserver?.disconnect();
    this.eventBus.removeAllListeners();
  }
}
```

#### 9b. 主入口（mainV2.ts）

```typescript
// src/main_v2.ts
import { Plugin, Notice } from "obsidian";
import { checkPtyCapability } from "./pty/capability";
import { EventBus } from "./eventbus";
import { TerminalView, VIEW_TYPE_TERMINAL_V2 } from "./view/TerminalView";
import { DEFAULT_V2_SETTINGS, AITerminalV2SettingTab, type AITerminalV2Settings } from "./settings_v2";
import { PipeServer } from "./pipe/PipeServer";
import { VaultContext } from "./pipe/vaultContext";
import { getPipePath } from "./pipe/PipeServer";
import * as path from "path";

export default class AITerminalV2Plugin extends Plugin {
  settings: AITerminalV2Settings = DEFAULT_V2_SETTINGS;
  pipeServer: PipeServer | null = null;

  private get pluginDir(): string {
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    return path.join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal");
  }

  async onload(): Promise<void> {
    // 1. 加载设置
    await this.loadSettings();

    // 2. PTY capability check
    const capability = checkPtyCapability();
    if (!capability.available) {
      new Notice(`AI Terminal: ${capability.error}`, 15000);
      return;
    }

    // 3. 注册视图
    this.registerView(VIEW_TYPE_TERMINAL_V2, (leaf) => {
      return new TerminalView(leaf, this.settings, this.pluginDir);
    });

    // 4. 打开终端命令
    this.addCommand({
      id: "open-terminal-v2",
      name: "Open AI Terminal v2",
      callback: () => this.openTerminal(),
    });

    // 5. 复制笔记路径命令
    this.addCommand({
      id: "copy-note-path-v2",
      name: "Copy note path",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note"); return; }
        const vaultPath = (this.app.vault.adapter as any).basePath as string;
        navigator.clipboard.writeText(vaultPath + "/" + file.path)
          .then(() => new Notice(`Copied: ${vaultPath}/${file.path}`, 3000));
      },
    });

    // 6. 设置面板
    this.addSettingTab(new AITerminalV2SettingTab(this.app, this));

    // 7. Ribbon 图标
    this.addRibbonIcon("terminal", "Open AI Terminal v2", () => this.openTerminal());

    // 8. Pipe 服务器
    if (this.settings.pipeServerEnabled) {
      this.startPipeServer();
    }
  }

  async openTerminal(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_V2);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_TERMINAL_V2, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private startPipeServer(): void {
    const vaultContext = new VaultContext(this.app);
    // 使用插件自己的 EventBus（与 TerminalView 共享）
    const eventBus = new EventBus();
    this.pipeServer = new PipeServer(this.app, eventBus, vaultContext);

    // sendKeys 函数——从活动 TerminalView 获取
    this.pipeServer.setSendKeysFn((keys: string) => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_V2);
      const view = leaves[0]?.view as TerminalView | undefined;
      view?.sendKeys(keys);
    });

    try {
      this.pipeServer.start();
    } catch (err: any) {
      console.error("Pipe server failed to start:", err);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_V2_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    this.pipeServer?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL_V2);
  }
}
```

- [ ] **Step 1: 创建两个文件** — `src/view/TerminalView.ts`, `src/main_v2.ts`

注意：`TerminalView.ts` 直接覆盖旧文件（类名和导出相同）。`main_v2.ts` 是临时入口，Task 10 替换。

- [ ] **Step 2: 编译验证**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/view/TerminalView.ts src/main_v2.ts
git commit -m "feat: add v2 plugin entry point + TerminalView"
```

---

### Task 10: 样式 + 清理旧文件

**Files:**
- Rewrite: `styles.css`
- Delete: 17 个旧文件（见文件清单）

#### 10a. 样式重写

```css
/* styles.css — AI Terminal v2 */

/* 容器 */
.ai-terminal-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Tab 栏 */
.ai-terminal-tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
  min-height: 32px;
  flex-shrink: 0;
}

.ai-terminal-tab-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
}

.ai-terminal-tab-item:hover {
  background: var(--background-modifier-hover);
}

.ai-terminal-tab-item.active {
  background: var(--background-primary);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
  border-bottom-color: var(--background-primary);
}

.ai-terminal-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-terminal-tab-close {
  opacity: 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 2px;
}

.ai-terminal-tab-item:hover .ai-terminal-tab-close {
  opacity: 1;
}

.ai-terminal-tab-close:hover {
  background: var(--background-modifier-error);
  color: var(--text-on-accent);
}

.ai-terminal-tab-add,
.ai-terminal-tab-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  color: var(--text-muted);
}

.ai-terminal-tab-add:hover,
.ai-terminal-tab-copy:hover {
  background: var(--background-modifier-hover);
}

/* 主面板 */
.ai-terminal-main-pane {
  flex: 1;
  min-height: 40px;
  overflow: hidden;
}

/* 分割线 */
.ai-terminal-resizer {
  height: 5px;
  background: var(--background-modifier-border);
  cursor: row-resize;
  flex-shrink: 0;
}

.ai-terminal-resizer:hover {
  background: var(--interactive-accent);
}

/* 分栏容器 */
.ai-terminal-splits-wrapper {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ai-terminal-split-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 26px;
}

/* xterm 容器 */
.ai-terminal-xterm {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.ai-terminal-xterm .xterm {
  padding: 4px;
  height: 100%;
}

.ai-terminal-xterm .xterm-screen {
  padding: 0 4px;
}

/* 深色模式 */
.theme-dark .ai-terminal-xterm .xterm {
  background: var(--background-primary);
}

/* 浅色模式 */
.theme-light .ai-terminal-xterm .xterm {
  background: var(--background-primary);
}
```

- [ ] **Step 1: 重写 styles.css**

- [ ] **Step 2: 删除旧文件**

```bash
cd C:/Users/Tengm/AppData/Local/Temp/obsidian-ai-terminal
git rm src/PtyProcess.ts
git rm src/TerminalView.ts
git rm src/acpLayer.ts
git rm src/contextPipeServer.ts
git rm src/contextSync.ts
git rm src/deployRegistry.ts
git rm src/hubGenerator.ts
git rm src/logWriter.ts
git rm src/otCommand.ts
git rm src/ruleSync.ts
git rm src/scheduler.ts
git rm src/vaultIndexer.ts
git rm src/vaultQuery.ts
git rm src/watchdog.ts
git rm src/RoadmapView.ts
git rm src/SchemaMapView.ts
git rm src/presets.ts
```

- [ ] **Step 3: 替换入口文件**

删除旧 main.ts 和 settings.ts，将临时文件重命名：

```bash
git rm src/main.ts
git rm src/settings.ts
git mv src/main_v2.ts src/main.ts
git mv src/settings_v2.ts src/settings.ts
```

- [ ] **Step 4: 编译验证**

```bash
npm run build
```

- [ ] **Step 5: 提交**

```bash
git add styles.css src/main.ts src/settings.ts
git rm src/PtyProcess.ts src/TerminalView.ts src/acpLayer.ts src/contextPipeServer.ts src/contextSync.ts src/deployRegistry.ts src/hubGenerator.ts src/logWriter.ts src/otCommand.ts src/ruleSync.ts src/scheduler.ts src/vaultIndexer.ts src/vaultQuery.ts src/watchdog.ts src/RoadmapView.ts src/SchemaMapView.ts src/presets.ts
git commit -m "refactor: replace all old code with v2 implementation"
```

---

## Spec Coverage 检查

| Spec 章节 | 覆盖 Task |
|---|---|
| 3.1 EventBus | Task 2 |
| 3.2 PTY 抽象层 | Task 1, Task 3 |
| 3.3 终端实例层 | Task 4 |
| 3.4 Tab/Split 状态机 | Task 6, Task 7 |
| 3.5 Pipe 服务器层 | Task 8 |
| 3.6 设置层 | Task 5 |
| 3.7 Obsidian 视图层 | Task 9 |
| 4 UI 设计 | Task 7, Task 10 |
| 5 目录结构 | 所有 Task |
| 6 技术风险 | Task 1 (node-pty), Task 4 (WebGL fallback), Task 8 (pipe) |
| 7 构建部署 | Task 1 |
| 8 启动顺序 | Task 9 (mainV2.ts) |

所有 spec 要求均有对应 Task。无遗漏。
