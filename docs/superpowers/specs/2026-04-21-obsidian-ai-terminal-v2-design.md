# Obsidian AI Terminal v2 — 完整产品设计规格

**日期：** 2026-04-21  
**版本：** 2.0（最终产品，非 MVP）  
**状态：** 设计中

---

## 1. 项目概述

### 1.1 问题陈述

现有的 obsidian-ai-terminal 插件底层代码基于韩国开源作者的作品构建，源码经过编译压缩，难以修改 UI 和架构。在 Obsidian 的 Electron 环境中，逆向工程导致编译链断裂，Obsidian 无法识别修改后的插件。

### 1.2 目标

从零编写一个完整的 Obsidian 嵌入式终端插件：
- 代码 100% 自有，无逆向工程
- 完全适配 Obsidian 的编译链和插件体系
- 多 tab 终端 + 二叉树分栏 + Obsidian 主题适配
- 内置 Named Pipe JSON-RPC 服务器，暴露 Vault 上下文
- 作为"最终产品"交付，非 MVP 原型

### 1.3 核心场景

用户在 Obsidian 中打开终端，以 Vault 为工作目录运行 Claude Code / Gemini CLI / 任意 shell 命令，完成知识库整理等任务。终端内能通过 Pipe 查询当前笔记路径和 Vault 搜索，让 AI 工具感知上下文。

---

## 2. 架构分层

```
┌─────────────────────────────────────┐
│         Obsidian 视图层              │  TerminalView, Plugin
│         (注册/生命周期/ribbon)        │
├─────────────────────────────────────┤
│         Tab/Split 状态机             │  LayoutTree, OperationQueue
│         (UI 状态 + 操作队列)          │
├─────────────────────────────────────┤
│         终端实例层                   │  TerminalInstance
│         (xterm.js 生命周期封装)       │
├──────────────┬──────────────────────┤
│  PTY 抽象层  │    Pipe 服务器层       │  PtyProcess, PipeServer
│  (node-pty)  │    (JSON-RPC)          │
├──────────────┴──────────────────────┤
│         设置层                      │  Settings
│         (配置管理)                   │
└─────────────────────────────────────┘
         ↑
    EventBus (层间通信，单向依赖)
```

**依赖方向：** 上层订阅下层事件，下层不引用上层代码。

---

## 3. 模块详细设计

### 3.1 EventBus（事件总线）

**职责：** 层间通信的统一通道，typed EventEmitter。

**设计：**
```typescript
type EventBusEvents = {
  'pty:data': (tabId: string, data: string) => void;
  'pty:exit': (tabId: string, code: number | null) => void;
  'pty:error': (tabId: string, err: Error) => void;
  'pty:ready': (tabId: string) => void;
  'tab:created': (tabId: string, name: string) => void;
  'tab:closed': (tabId: string) => void;
  'tab:activated': (tabId: string) => void;
  'tab:renamed': (tabId: string, newName: string) => void;
  'split:created': (tabId: string) => void;
  'split:restored': (tabId: string) => void;
  'split:closed': (tabId: string) => void;
  'theme:changed': (isDark: boolean) => void;
  'activeNote:changed': (file: TFile | null) => void;
  'pipe:started': () => void;
  'pipe:stopped': () => void;
};
```

**实现要点：**
- 继承 Node.js EventEmitter
- 泛型 `emit<K extends keyof EventBusEvents>(event, ...args)` 编译时类型检查
- 不支持跨模块直接调用，所有交互走事件

---

### 3.2 PTY 抽象层 (`src/pty/`)

**职责：** 进程管理，平台差异隔离。

**核心接口：**
```typescript
interface PtyProcess {
  start(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;  // returns unsubscribe
  onExit(cb: (code: number | null) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  readonly isRunning: boolean;
  readonly pid: number | undefined;
}
```

**实现：** `NodePtyProcess` 封装 `node-pty`。

**P0 验证项 — Electron 适配：**
- node-pty 包含 native C++ addon，需要与 Obsidian 的 Electron Node 版本匹配
- 构建时需用 `electron-rebuild` 或设置 `--runtime=electron` 重编译
- 插件启动时做 capability check：尝试 require('node-pty')，失败时弹窗提示用户并禁用功能
- 错误信息明确：指出是 node-pty 兼容性问题，附带修复指引

**降级策略：**
- capability check 失败 → 显示错误 UI，不创建 tab，不崩溃
- 运行时进程异常退出 → 发 `pty:exit` 事件，UI 显示 "[Process exited]"

---

### 3.3 终端实例层 (`src/terminal/`)

**职责：** xterm.js + FitAddon + Renderer 生命周期封装，对上层屏蔽终端渲染细节。

**核心接口：**
```typescript
interface TerminalInstance {
  readonly id: string;
  readonly element: HTMLElement;
  attachTo(container: HTMLElement): void;
  detach(): void;
  fit(): void;
  write(data: string): void;
  focus(): void;
  dispose(): void;
  onResize(cb: (cols: number, rows: number) => void): () => void;
}
```

**实现要点：**
- 构造函数创建 `Terminal` + `FitAddon`
- `attachTo()` 时才 `terminal.open(el)`
- Renderer 降级：先尝试 `WebglAddon`，try-catch 包裹，失败时自动 fallback 到内置 Canvas renderer
- 主题色从 CSS 变量实时读取，不硬编码颜色值
- `dispose()` 清理所有 addon、timer、事件监听

---

### 3.4 Tab/Split 状态机 (`src/ui/`)

**职责：** 管理 tab bar 和分栏布局状态，通过操作队列串行化所有变更。

**LayoutTree（二叉树）：**

用二叉树表达嵌套分栏，每个节点是 `Leaf`（包含 tabId）或 `Split`（方向 + 子节点 + 比例）：

```typescript
type LayoutNode =
  | { type: 'leaf'; tabId: string }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; first: LayoutNode; second: LayoutNode; ratio: number };
```

- `horizontal` = 上下分栏，`vertical` = 左右分栏（为将来预留）
- `ratio` = 第一子节点占比 (0-1)
- 初始状态：单叶节点 `Leaf(tabId)`
- 拖拽 tab 到 split → 当前节点变成 `Split(old, new)`
- 关闭 split → 父节点替换为兄弟节点

**操作队列：**

所有布局变更操作串行执行，防止竞态：

```typescript
private operationQueue: Array<() => void> = [];
private isProcessing = false;

private enqueue(op: () => void): void {
  this.operationQueue.push(op);
  if (!this.isProcessing) this.processQueue();
}

private processQueue(): void {
  this.isProcessing = true;
  while (this.operationQueue.length > 0) {
    this.operationQueue.shift()!();
  }
  this.isProcessing = false;
}
```

**操作类型：**
- `createTab()` → 创建新 tab，加入 tree 为活跃叶
- `closeTab(tabId)` → 从 tree 移除，激活相邻 tab
- `activateTab(tabId)` → 切换活跃 tab
- `splitOut(tabId, direction)` → 将 tab 从 tree 取出，创建分栏
- `restoreToMain(tabId)` → 将分栏还原
- `renameTab(tabId, newName)` → 更新名称

**DOM 渲染：**
- 每次操作完成后，遍历 tree 重新渲染布局（reactive 模式）
- 或者增量更新——只操作变化的 DOM 节点
- 所有 DOM 操作做 null check，使用可选链

---

### 3.5 Pipe 服务器层 (`src/pipe/`)

**职责：** 通过 Windows Named Pipe / Unix Socket 暴露 Vault 上下文，供外部工具（Claude Code 等）查询。

**传输协议：** JSON-RPC 2.0 over Named Pipe。

**接口定义：**

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `context/get` | 无 | `{ activeNote, recentNotes[], vaultPath }` | 获取完整上下文 |
| `context/activeNote` | 无 | `{ path, content }` 或 null | 当前打开笔记 |
| `vault/search` | `{ query: string }` | `[{ path, title, snippet }]` | Vault 搜索 |
| `vault/read` | `{ path: string }` | `{ content, frontmatter }` | 读取笔记内容 |
| `obsidian/openNote` | `{ path: string }` | `{ ok: boolean }` | 在 Obsidian 打开笔记 |
| `terminal/sendKeys` | `{ tabId?, keys: string }` | `{ ok: boolean }` | 向终端发送按键 |

**实现要点：**
- Named Pipe 路径：`\\.\pipe\obsidian-ai-terminal` (Win) / `/tmp/obsidian-ai-terminal.sock` (Mac/Linux)
- JSON-RPC 请求/响应格式标准
- 设置面板开关控制启停
- 错误处理：pipe 被占用时自动清理旧 pipe 后重试
- 安全：只读操作，不接受修改 vault 内容的写入请求（除了 openNote 这种 UI 操作）

---

### 3.6 设置层 (`src/settings/`)

**职责：** 插件配置管理，Obsidian SettingTab 渲染。

**配置项：**

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultShell` | string | powershell.exe / zsh | 默认 shell |
| `defaultCwd` | string | (vault root) | 默认工作目录 |
| `fontSize` | number | 14 | 终端字号 |
| `fontFamily` | string | Cascadia Code 等 | 终端字体 |
| `presets` | Preset[] | [{name:"Terminal", command:""}] | 预设列表 |
| `enableWebGL` | boolean | true | 启用 WebGL 加速 |
| `pipeServerEnabled` | boolean | true | 启用 Pipe 服务器 |

---

### 3.7 Obsidian 视图层 (`src/view/`)

**职责：** Obsidian 集成入口。

**组件：**
- `AITerminalPlugin extends Plugin` —— 插件入口，编排各层初始化顺序
- `TerminalView extends ItemView` —— Obsidian 视图，挂载 UI 层

**初始化顺序（严格）：**
1. Settings 加载
2. EventBus 初始化
3. PTY capability check → 失败则终止
4. TerminalInstance 工厂注册到 EventBus
5. LayoutTree + OperationQueue 初始化
6. TerminalView 注册到 Obsidian workspace
7. Pipe Server 启动（若启用）
8. Ribbon 图标 + 命令注册

---

## 4. UI 设计

UI 沿用 PRD（`PRD.md`）中的设计稿，包括：
- 标签栏：多 tab + 重命名 + 关闭确认 + 新建按钮
- 主面板：全屏终端显示
- 分割线：可拖拽调整高度
- 分栏面板：Header（名称 + 还原 + 复制路径 + 关闭）+ 终端内容
- 深色/浅色主题自动适配
- 快捷键：Ctrl+Enter 换行、Ctrl+C/V 复制粘贴、Ctrl+滚轮缩放
- 复制按钮（📄）：复制当前打开笔记的绝对路径

---

## 5. 项目目录结构

```
obsidian-ai-terminal/
├── manifest.json              # Obsidian 插件清单
├── package.json               # 依赖：node-pty, @xterm/xterm, esbuild
├── tsconfig.json              # TypeScript 配置
├── esbuild.config.mjs         # 构建配置（含 electron-rebuild）
├── styles.css                 # Obsidian 主题适配样式
├── src/
│   ├── main.ts                # 插件入口（视图层）
│   ├── settings.ts            # 设置层 + SettingTab
│   ├── eventbus.ts            # EventBus 类型定义 + 实现
│   ├── pty/
│   │   ├── types.ts           # PtyProcess 接口
│   │   ├── NodePtyProcess.ts  # node-pty 实现
│   │   └── capability.ts      # 启动时 capability check
│   ├── terminal/
│   │   ├── TerminalInstance.ts  # xterm.js 封装
│   │   └── theme.ts             # 主题色提取
│   ├── ui/
│   │   ├── LayoutTree.ts      # 二叉树状态模型
│   │   ├── OperationQueue.ts  # 操作队列
│   │   ├── TabBar.ts          # 标签栏渲染
│   │   └── SplitRenderer.ts   # 分栏渲染
│   ├── pipe/
│   │   ├── PipeServer.ts      # JSON-RPC 服务器
│   │   ├── protocol.ts        # JSON-RPC 方法定义
│   │   └── vaultContext.ts    # vault 上下文查询
│   └── view/
│       └── TerminalView.ts    # Obsidian ItemView
└── docs/
    ├── superpowers/specs/
    │   └── 2026-04-21-obsidian-ai-terminal-v2-design.md  # 本文件
    └── ...
```

---

## 6. 技术风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| node-pty native binding 与 Electron 不兼容 | P0 崩溃 | electron-rebuild + capability check + 明确错误提示 |
| WebGL renderer GPU 驱动报错 | 终端无法渲染 | try-catch 包裹，fallback 到 Canvas |
| Named Pipe 权限/占用 | Pipe 服务启动失败 | 自动清理旧 pipe + 优雅降级（不影响终端） |
| Obsidian 升级导致 Electron 版本变化 | node-pty 失效 | capability check 在每次插件加载时执行 |
| LayoutTree 递归渲染性能 | 大量 split 时卡顿 | 单棵树深度限制 + 增量 DOM 更新 |

---

## 7. 构建与部署

### 7.1 构建流程

```bash
# 安装依赖（含 native addon 重编译）
npm install
npx electron-rebuild -f -w node-pty  # 适配 Obsidian Electron

# 开发模式
npm run dev    # esbuild watch

# 生产构建
npm run build  # esbuild production + 压缩
```

### 7.2 部署目标

```
{vault}/.obsidian/plugins/obsidian-ai-terminal/
├── main.js          # esbuild 输出
├── styles.css       # 样式
└── manifest.json    # 清单
```

node-pty 的 `.node` native addon 需一并复制到插件目录，或通过 esbuild 的 `external` 配置让 Electron 在运行时加载。

### 7.3 验证流程

1. 先验证 node-pty 能否在 Obsidian 中正常 require
2. 再验证 Terminal 能否创建并显示
3. 再验证 Tab/Split 交互
4. 最后验证 Pipe 服务器

---

## 8. 模块启动顺序

```
Plugin.onload()
  ├── 1. loadSettings()
  ├── 2. new EventBus()
  ├── 3. checkPtyCapability() → fail: Notice + return
  ├── 4. registerView(TerminalView)
  ├── 5. TerminalView.onOpen()
  │     ├── new LayoutTree()
  │     ├── new OperationQueue()
  │     ├── new TabBar()
  │     └── LayoutTree.createTab() → new TerminalInstance() → new PtyProcess()
  ├── 6. addRibbonIcon() + addCommand()
  └── 7. if (pipeServerEnabled) startPipeServer()
```

**销毁顺序（逆序）：**
```
Plugin.onunload()
  ├── stopPipeServer()
  ├── LayoutTree.dispose() → 所有 TerminalInstance.dispose() → 所有 PtyProcess.kill()
  ├── EventBus.removeAllListeners()
  └── detachLeaves()
```
