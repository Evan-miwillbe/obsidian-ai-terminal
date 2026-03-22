# Obsidian AI Terminal

An Obsidian plugin that embeds a **fully functional terminal** inside Obsidian — designed for running AI CLI tools like **Claude Code** and **Gemini CLI** directly within your vault.

> No native modules. No WebSocket. No external dependencies (besides Python 3, which ships with macOS).

![macOS](https://img.shields.io/badge/platform-macOS-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)
![License](https://img.shields.io/badge/license-MIT-green)

## Why?

Existing Obsidian terminal plugins either:
- Depend on **node-pty** (native C++ module) — fragile across Electron versions
- Only support simple command execution — no TUI app support

This plugin uses **Python's built-in `pty` module** to allocate a real pseudo-terminal, enabling full TUI support (colors, cursor movement, interactive input) without any native module compilation.

## Features

- **Full terminal emulation** — powered by [xterm.js](https://xtermjs.org/)
- **AI CLI presets** — one-click launch for Claude Code, Gemini CLI, or any CLI tool
- **Vault-aware** — automatically sets working directory to your vault root
- **Login shell** — loads your `.zprofile`/`.zshrc`, so nvm, homebrew, etc. just work
- **Resizable** — terminal auto-fits to panel size with proper PTY resize signals
- **Customizable** — font size, font family, shell path, custom presets
- **No native modules** — works across Obsidian updates without recompilation

## How It Works

```
xterm.js (UI) ←→ stdin/stdout pipe ←→ pty-helper.py (PTY) ←→ shell/CLI
```

The plugin spawns a lightweight Python 3 script (`pty-helper.py`) that:
1. Creates a real PTY via `pty.openpty()`
2. Forks and runs your shell (or AI CLI) inside the PTY
3. Relays I/O between Obsidian (pipes) and the PTY (real terminal)

This gives you a genuine terminal experience — including full TUI support for apps like Claude Code — without the pain of native Node.js modules.

## Installation

### Manual Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`, `pty-helper.py`)
2. Create folder: `<your-vault>/.obsidian/plugins/obsidian-ai-terminal/`
3. Copy the 4 files into that folder
4. Restart Obsidian → Settings → Community Plugins → Enable "AI Terminal"

### From Source

```bash
git clone https://github.com/theco/obsidian-ai-terminal.git
cd obsidian-ai-terminal
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, `styles.css`, and `src/pty-helper.py` to your vault's plugin folder.

## Usage

### Open a terminal
- **Command palette**: `AI Terminal: Open terminal`
- **Ribbon icon**: Click the terminal icon in the left sidebar

### Open with AI preset
- **Command palette**: `AI Terminal: Open Claude Code`
- **Command palette**: `AI Terminal: Open Gemini CLI`

### Custom presets
Go to **Settings → AI Terminal → Presets** to add your own:

| Name | Command |
|------|---------|
| Claude Code | `claude` |
| Gemini CLI | `gemini` |
| Aider | `aider` |
| Shell | *(empty = default shell)* |

## Requirements

- **macOS** (uses Python 3 `pty` module; Python 3 ships with macOS)
- **Obsidian 1.0+** (Desktop only)
- AI CLI tools installed separately (e.g., `npm install -g @anthropic-ai/claude-code`)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Default shell | `/bin/zsh` | Shell to launch |
| Working directory | Vault root | Override with custom path |
| Font size | 14 | Terminal font size (10–24) |
| Font family | MesloLGS NF, Menlo, ... | CSS font-family |
| Presets | Shell, Claude Code, Gemini CLI | Customizable CLI presets |

## Architecture

```
src/
├── main.ts           # Plugin entry point — commands, ribbon, settings tab
├── TerminalView.ts   # xterm.js terminal view (Obsidian ItemView)
├── PtyProcess.ts     # Python PTY process manager
├── pty-helper.py     # Python 3 PTY allocator + I/O relay
├── presets.ts        # Default AI CLI presets
└── settings.ts       # Plugin settings & UI
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| Python PTY over node-pty | No native module compilation; works across Electron versions |
| Python PTY over `script` | `script` fails with piped stdio (`tcgetattr` error) |
| Login shell (`-l`) | Loads user's PATH config (nvm, homebrew, etc.) |
| Custom resize escape sequence | `\x1b]resize;cols;rows\x07` parsed by pty-helper for SIGWINCH |

## Roadmap

- [ ] Linux support (Python PTY works on Linux too — just needs testing)
- [ ] Windows support (ConPTY bridge binary)
- [ ] Multiple terminal tabs
- [ ] Session persistence across Obsidian restarts
- [ ] Obsidian theme-aware terminal colors

## License

MIT

## Credits

- [xterm.js](https://xtermjs.org/) — Terminal UI rendering
- Built with [Claude Code](https://claude.ai/claude-code)
