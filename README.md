# Obsidian AI Terminal

在 Obsidian 中嵌入**完整功能终端**的插件 — 直接在 Vault 内运行任意 shell 命令。

> 无需原生 Node.js 模块，跨平台支持（macOS + Windows + Linux）。
> UI 适配 Obsidian 风格，本地 PTY 运行，零 API 依赖。

![macOS](https://img.shields.io/badge/platform-macOS-blue)
![Windows](https://img.shields.io/badge/platform-Windows-blue)
![Linux](https://img.shields.io/badge/platform-Linux-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.3.0-green)

## 为什么做这个插件？

AI 工具（如 Claudian）集成在 Obsidian 中时，稍复杂的任务就需要调用子代理和外部 API，响应慢且容易卡顿。知识库整理等日常工作需要一个**随时可用、不依赖网络**的本地终端。

本插件把真正的 PTY 终端嵌入 Obsidian：
- **本地运行**，不调用任何 AI API，即时响应
- **UI 适配 Obsidian 风格**，标签栏、分栏、主题自适应
- **完整 TUI 支持** — 颜色、光标、交互式输入

## 功能特性

### 终端 UI

```
┌──────────────────────────────────────────────────────┐
│ [Terminal 1 ×] [Git ×] [+] [📄]                      │  ← 标签栏
│ ───────────────────────────────────────────────────  │
│ PS D:\Knowledge-Vault> █                             │  ← 主面板
│                                                      │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━            │  ← 可拖动分割线
│ Git  [↑]                          [📄] [×]           │  ← 分栏 Header
│ ───────────────────────────────────────────────────  │
│ PS D:\Knowledge-Vault> git status                    │  ← 分栏终端
│ PS D:\Knowledge-Vault> █                             │
└──────────────────────────────────────────────────────┘
```

| 功能 | 说明 |
|------|------|
| **多标签页** | 标签栏 + "+" 按钮，快速创建/切换终端 |
| **标签重命名** | 悬停时 ✎ 按钮，或右键重命名 |
| **关闭确认** | × 按钮弹出确认弹窗，关闭不留空白 |
| **分栏面板** | 拖拽标签到下方创建分栏，支持多个分栏纵向堆叠 |
| **↑ 还原** | 分栏中的终端一键还原回标签栏 |
| **可拖动分割线** | 鼠标拖动调整主面板与分栏高度比例 |
| **📄 复制路径** | 一键复制当前活跃笔记的绝对路径 |
| **主题自适应** | 自动跟随 Obsidian 深色/浅色模式 |
| **紫色光标** | 光标颜色使用 Obsidian accent 色 |
| **字体缩放** | Ctrl + 滚轮调整终端字体大小 |
| **WebGL 加速** | GPU 渲染，context loss 时自动 fallback |
| **写入缓冲** | rAF 缓冲输出，64KB 阈值，防止渲染卡顿 |

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Enter` | 插入换行 |
| `Ctrl+C`（有选区） | 复制选区到剪贴板 |
| `Ctrl+C`（无选区） | 发送 SIGINT（中断当前命令） |
| `Ctrl+V` | 粘贴剪贴板内容 |
| `Ctrl+滚轮` | 缩放字体 |

### 预设终端

| 名称 | 命令 |
|------|------|
| Shell | *（留空 = 默认 shell）* |
| Claude Code | `claude` |
| Gemini CLI | `gemini` |
| Aider | `aider` |

### 后端架构

| 平台 | PTY 后端 |
|------|----------|
| macOS/Linux | Python 3 `pty` 模块（系统自带） |
| Windows | Rust ConPTY 桥接（~400KB，随插件打包） |

## 安装

### macOS / Linux

1. 下载最新发布版（`main.js`、`manifest.json`、`styles.css`、`pty-helper.py`）
2. 创建文件夹：`<你的vault>/.obsidian/plugins/obsidian-ai-terminal/`
3. 将 4 个文件复制到该文件夹
4. 重启 Obsidian → 设置 → 社区插件 → 启用 "AI Terminal"

**依赖**：
- Python 3（macOS 自带；Linux 可通过 `sudo apt install python3` 安装）

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

## 使用方法

- **命令面板**：`AI Terminal: Open terminal`
- **侧边栏图标**：点击左侧边栏的终端图标
- **预设终端**：`AI Terminal: Open Claude Code` 等

## 许可证

MIT

## 致谢

- 本插件基于 [Deok-ho/obsidian-ai-terminal](https://github.com/Deok-hu/obsidian-ai-terminal) 的开源项目开发。PTY 跨平台架构（Python pty-helper.py、Rust conpty-bridge）的核心逻辑参考原作者实现。本仓库在此基础上进行了 UI 重新设计和功能扩展。
- [xterm.js](https://xtermjs.org/) — 终端渲染
- [windows-rs](https://github.com/microsoft/windows-rs) — Rust Windows API 绑定
