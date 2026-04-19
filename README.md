# Obsidian AI Terminal

在 Obsidian 中嵌入**完整功能终端**的插件 — 专为直接在 Vault 内运行 **Claude Code**、**Gemini CLI** 等 AI CLI 工具而设计。

> 无需原生 Node.js 模块，无需 WebSocket，跨平台支持（macOS + Windows + Linux）。

![macOS](https://img.shields.io/badge/platform-macOS-blue)
![Windows](https://img.shields.io/badge/platform-Windows-blue)
![Linux](https://img.shields.io/badge/platform-Linux-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)
![License](https://img.shields.io/badge/license-MIT-green)

## 为什么做这个插件？

现有的 Obsidian 终端插件要么：
- 依赖 **node-pty**（原生 C++ 模块）— 在不同 Electron 版本间容易出问题
- 只支持简单的命令执行 — 不支持 TUI 应用

本插件使用**平台原生 PTY** 分配，无需任何原生 Node.js 模块：
- **macOS/Linux**：Python 3 `pty` 模块（系统自带）
- **Windows**：Rust ConPTY 桥接二进制（~400KB，随插件打包）

完整 TUI 支持 — 颜色、光标移动、交互式输入 — 适用于 Claude Code 等应用。

## 功能特性

### 终端（Phase 1）
- **完整终端模拟** — 基于 [xterm.js](https://xtermjs.org/) + WebGL 硬件加速渲染
- **跨平台** — macOS（Python PTY）+ Windows（ConPTY）+ Linux
- **AI CLI 预设** — 一键启动 Claude Code、Gemini CLI 或任意 CLI 工具
- **Vault 感知** — 自动将工作目录设为 Vault 根目录
- **无原生模块** — Obsidian 更新后无需重新编译
- **多标签页** — 标签栏 + "+" 按钮，在一个面板内切换多个终端
- **分栏面板** — 拖拽标签到底部固定为分栏；可拖拽分割线调整高度
- **关闭确认** — 防止误关终端
- **主题自适应** — 透明背景，颜色随 Obsidian 主题变化
- **字体缩放** — Ctrl + 滚轮调整终端字体大小
- **标签重命名** — 自定义终端标签名称

### Vault 智能功能（Phase 2）
- **Vault 搜索** — `/search tag:关键词`、`/backlinks`、`/links`，ANSI 终端输出
- **自然语言调度**（`/ot`）— "每天早上8点总结笔记" → 自动注册 cron 任务
- **MCP Server** — 通过 stdio 进行 schedule CRUD（Claude Code 集成）
- **日志系统** — `_logs/{host}/{agent}/{date}.md` 按 PC/Agent 追加写入
- **Hub 生成器** — 渐进式摘要（日 → 周 → 月），通过 `claude -p` 生成

### Schema Map（Phase 3）
- **维度 → Hub → 部署**可视化编辑器（SVG）
- **Hub 构建引擎** — 合并维度 .md 文件为 `HUB_{project}.md`
- **变更检测** — 维度编辑后连接线变黄（标记为过期）

### Roadmap 视图（Phase 4）
- **SVG 甘特图** — 扫描 Vault .md 文件的 `node_type` frontmatter
- **深度分组** — 项目 → 阶段 → 史诗 → 任务 → 子任务
- **进度条** + 依赖箭头

### Named Pipe + ACP（Phase 5）
- **Context Pipe Server** — `\\.\pipe\obsidian-ai-terminal`（JSON-RPC 2.0）
- **Vault 读写、笔记控制、终端 sendKeys** — 任意本地进程可调用
- **ACP 多 Agent** — 并行调用 Claude Code、Codex、Gemini CLI
- **wmux 集成** — 双向 Named Pipe 终端会话控制（计划中）

## 工作原理

```
              macOS/Linux                            Windows
xterm.js ←→ pipe ←→ pty-helper.py (PTY) ←→ shell    xterm.js ←→ pipe ←→ conpty-bridge.exe (ConPTY) ←→ shell
```

两个后端使用相同的协议：
- stdin/stdout 管道进行 I/O 中继
- 自定义转义序列 `\x1b]resize;cols;rows\x07` 进行终端缩放

## 安装

### macOS / Linux

1. 下载最新发布版（`main.js`、`manifest.json`、`styles.css`、`pty-helper.py`）
2. 创建文件夹：`<你的vault>/.obsidian/plugins/obsidian-ai-terminal/`
3. 将 4 个文件复制到该文件夹
4. 重启 Obsidian → 设置 → 社区插件 → 启用 "AI Terminal"

**依赖**：
- Python 3（macOS 自带；Linux 可通过 `sudo apt install python3` 安装）
- **Linux**：推荐使用 Obsidian **AppImage**（Snap/Flatpak 可能会沙箱化 `child_process`）

### Windows

1. 下载最新发布版（`main.js`、`manifest.json`、`styles.css`、`conpty-bridge.exe`）
2. 创建文件夹：`<你的vault>\.obsidian\plugins\obsidian-ai-terminal\`
3. 将 4 个文件复制到该文件夹
4. 重启 Obsidian → 设置 → 社区插件 → 启用 "AI Terminal"

**依赖**：Windows 10 1809 或更高版本（ConPTY 支持）

### 从源码构建

```bash
git clone https://github.com/Evan-miwillbe/obsidian-ai-terminal.git
cd obsidian-ai-terminal
npm install
npm run build
```

Windows ConPTY 桥接：
```bash
cd conpty-bridge
cargo build --release
# 输出：target/release/conpty-bridge.exe
```

## 使用方法

### 打开终端
- **命令面板**：`AI Terminal: Open terminal`
- **侧边栏图标**：点击左侧边栏的终端图标

### 使用 AI 预设打开
- **命令面板**：`AI Terminal: Open Claude Code`
- **命令面板**：`AI Terminal: Open Gemini CLI`

### 自定义预设
前往 **设置 → AI Terminal → 预设** 添加你自己的：

| 名称 | 命令 |
|------|------|
| Claude Code | `claude` |
| Gemini CLI | `gemini` |
| Aider | `aider` |
| Shell | *（留空 = 默认 shell）* |

## 设置

| 设置项 | macOS/Linux 默认值 | Windows 默认值 | 说明 |
|--------|-------------------|---------------|------|
| 默认 Shell | `$SHELL` 或 `/bin/zsh` | `powershell.exe` | 启动的 Shell |
| 工作目录 | Vault 根目录 | Vault 根目录 | 可自定义路径 |
| 字体大小 | 14 | 14 | 终端字体大小（10-24） |
| 字体族 | Cascadia Code, Consolas, ... | Cascadia Code, Consolas, ... | CSS font-family |
| 预设 | Shell, Claude Code, Gemini CLI | Shell, Claude Code, Gemini CLI | 可自定义 CLI 预设 |

## 架构

```
src/
├── main.ts              # 插件入口 — 命令、子系统初始化、生命周期
├── TerminalView.ts      # xterm.js 终端（Obsidian ItemView）
├── PtyProcess.ts        # 跨平台 PTY 进程管理器
├── pty-helper.py        # macOS/Linux: Python 3 PTY 分配器 + I/O 中继
├── presets.ts           # 默认 AI CLI 预设
├── settings.ts          # 插件设置 & UI
├── watchdog.ts          # Vault 变更检测 → ContextIndex
├── contextPipeServer.ts # Named Pipe 服务器（JSON-RPC 2.0）
├── acpLayer.ts          # ACP 多 Agent（调用、取消、并行）
├── otCommand.ts         # /ot 自然语言调度模态框
├── vaultQuery.ts        # /search、/backlinks、/links
├── logWriter.ts         # _logs 文件夹追加写入日志
├── hubGenerator.ts      # Hub 生成引擎（渐进式摘要）
├── scheduler.ts         # Cron 调度器（claude -p 执行）
├── SchemaMapView.ts     # Schema Map SVG（维度 → Hub → 部署）
├── RoadmapView.ts       # Roadmap 甘特图（SVG）
├── deployRegistry.ts    # 部署注册表（符号链接/复制管理）
├── ruleSync.ts          # 规则同步（Harness → LLM 配置）
├── vaultIndexer.ts      # Vault 元数据 JSON 导出
└── contextSync.ts       # Context 同步脚本生成器

scripts/
├── mcp-schedule-server.mjs  # 独立 MCP stdio 服务器（schedule CRUD）
└── antigravity_extract.py   # Antigravity 对话提取器

conpty-bridge/               # Windows: Rust ConPTY 桥接
```

### 关键设计决策

| 决策 | 原因 |
|------|------|
| Python PTY（macOS/Linux） | 无原生模块；`pty` 模块系统自带 |
| Rust ConPTY 桥接（Windows） | 单个静态二进制（~400KB）；无 Python/运行时依赖 |
| 统一的 resize 协议 | `\x1b]resize;cols;rows\x07` — 跨平台通用，两个后端都能解析 |
| macOS 使用登录 Shell（`-l`） | 加载用户的 PATH 配置（nvm、homebrew 等） |
| Windows 使用 Job Object | 确保桥接退出时子进程也被终止 |

## 路线图

- [x] Phase 1: macOS + Windows + Linux 终端
- [x] Phase 2: Vault 智能功能（/ot、MCP、查询、日志、Hub 生成器）
- [x] Phase 3: Schema Map（维度 → Hub 构建 → 部署）
- [x] Phase 4: Roadmap 视图（SVG 甘特图）
- [x] Phase 5-A: Named Pipe Context Server + 注入器
- [x] Phase 5-B: ACP 多 Agent 编排
- [x] Phase 5-C: 多终端标签、分栏面板、关闭确认、主题自适应 UI
- [ ] wmux 集成（双向 Named Pipe 终端控制）
- [ ] Linux Obsidian GUI 测试（社区插件注册的前置条件）
- [ ] 社区插件商店注册

## 构建 ConPTY 桥接（Windows）

ConPTY 桥接必须在 Windows 上编译（或交叉编译）：

```bash
# 在 Windows 上：
cd conpty-bridge
cargo build --release
# → target\release\conpty-bridge.exe (~400KB)

# 复制到插件文件夹：
copy target\release\conpty-bridge.exe <vault>\.obsidian\plugins\obsidian-ai-terminal\
```

## 许可证

MIT

## 致谢

- [xterm.js](https://xtermjs.org/) — 终端 UI 渲染
- [windows-rs](https://github.com/microsoft/windows-rs) — Rust Windows API 绑定
- 使用 [Claude Code](https://claude.ai/claude-code) 构建
