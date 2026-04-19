# Obsidian AI Terminal

An Obsidian plugin that embeds a **fully functional terminal** inside Obsidian — designed for running AI CLI tools like **Claude Code** and **Gemini CLI** directly within your vault.

> No native Node.js modules. No WebSocket. Cross-platform (macOS + Windows).

![macOS](https://img.shields.io/badge/platform-macOS-blue)
![Windows](https://img.shields.io/badge/platform-Windows-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)
![License](https://img.shields.io/badge/license-MIT-green)

## Why?

Existing Obsidian terminal plugins either:
- Depend on **node-pty** (native C++ module) — fragile across Electron versions
- Only support simple command execution — no TUI app support

This plugin uses **platform-native PTY** allocation without any native Node.js modules:
- **macOS/Linux**: Python 3 `pty` module (ships with the OS)
- **Windows**: Rust ConPTY bridge binary (~400KB, bundled)

Full TUI support — colors, cursor movement, interactive input — for apps like Claude Code.

## Features

### Terminal (Phase 1)
- **Full terminal emulation** — powered by [xterm.js](https://xtermjs.org/)
- **Cross-platform** — macOS (Python PTY) + Windows (ConPTY)
- **AI CLI presets** — one-click launch for Claude Code, Gemini CLI, or any CLI tool
- **Vault-aware** — automatically sets working directory to your vault root
- **No native modules** — works across Obsidian updates without recompilation
- **Multi-tab** — tab bar with "+" button, switch between terminals within one panel
- **Split panes** — drag a tab down to pin it as a bottom split pane; resizable divider to adjust height ratio
- **Close confirmation** — prevents accidental terminal closure
- **Theme-aware UI** — transparent background, colors adapt to your Obsidian theme

### Vault Intelligence (Phase 2)
- **Vault search** — `/search tag:keyword`, `/backlinks`, `/links` with ANSI terminal output
- **Natural language scheduling** (`/ot`) — "매일 아침 8시에 노트 요약해줘" → cron auto-registration
- **MCP Server** — schedule CRUD via stdio (Claude Code integration)
- **Log system** — `_logs/{host}/{agent}/{date}.md` append-only per PC/agent
- **Hub generator** — progressive summarization (daily → weekly → monthly) via `claude -p`

### Schema Map (Phase 3)
- **Dimension → Hub → Deploy** visual editor (SVG)
- **Hub build engine** — merge dimension .md files into `HUB_{project}.md`
- **Change detection** — dimension edits turn connection lines yellow (stale)

### Roadmap View (Phase 4)
- **SVG Gantt chart** — scans `node_type` frontmatter from vault .md files
- **Depth grouping** — project → phase → epic → task → subtask
- **Progress bars** + dependency arrows

### Named Pipe + ACP (Phase 5)
- **Context Pipe Server** — `\\.\pipe\obsidian-ai-terminal` (JSON-RPC 2.0)
- **Vault read/write, note control, terminal sendKeys** from any local process
- **ACP multi-agent** — invoke Claude Code, Codex, Gemini CLI in parallel
- **wmux integration** — bidirectional Named Pipe for terminal session control (planned)

## How It Works

```
                  macOS/Linux                          Windows
xterm.js ←→ pipe ←→ pty-helper.py (PTY) ←→ shell    xterm.js ←→ pipe ←→ conpty-bridge.exe (ConPTY) ←→ shell
```

Both backends use the same protocol:
- stdin/stdout pipes for I/O relay
- Custom escape sequence `\x1b]resize;cols;rows\x07` for terminal resize

## Installation

### macOS / Linux

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`, `pty-helper.py`)
2. Create folder: `<your-vault>/.obsidian/plugins/obsidian-ai-terminal/`
3. Copy the 4 files into that folder
4. Restart Obsidian → Settings → Community Plugins → Enable "AI Terminal"

**Requirements**:
- Python 3 (ships with macOS; install via `sudo apt install python3` on Linux)
- **Linux**: Obsidian **AppImage** recommended (Snap/Flatpak may sandbox `child_process`)

### Windows

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`, `conpty-bridge.exe`)
2. Create folder: `<your-vault>\.obsidian\plugins\obsidian-ai-terminal\`
3. Copy the 4 files into that folder
4. Restart Obsidian → Settings → Community Plugins → Enable "AI Terminal"

**Requirement**: Windows 10 version 1809 or later (for ConPTY support)

### From Source

```bash
git clone https://github.com/Evan-miwillbe/obsidian-ai-terminal.git
cd obsidian-ai-terminal
npm install
npm run build
```

For the Windows ConPTY bridge:
```bash
cd conpty-bridge
cargo build --release
# Output: target/release/conpty-bridge.exe
```

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

## Settings

| Setting | macOS/Linux Default | Windows Default | Description |
|---------|-------------------|-----------------|-------------|
| Default shell | `$SHELL` or `/bin/zsh` | `powershell.exe` | Shell to launch |
| Working directory | Vault root | Vault root | Override with custom path |
| Font size | 14 | 14 | Terminal font size (10–24) |
| Font family | Cascadia Code, Consolas, ... | Cascadia Code, Consolas, ... | CSS font-family |
| Presets | Shell, Claude Code, Gemini CLI | Shell, Claude Code, Gemini CLI | Customizable CLI presets |

## Architecture

```
src/
├── main.ts              # Plugin entry — commands, subsystem init, lifecycle
├── TerminalView.ts      # xterm.js terminal (Obsidian ItemView)
├── PtyProcess.ts        # Platform-aware PTY process manager
├── pty-helper.py        # macOS/Linux: Python 3 PTY allocator + I/O relay
├── presets.ts           # Default AI CLI presets
├── settings.ts          # Plugin settings & UI
├── watchdog.ts          # Vault change detection → ContextIndex
├── contextPipeServer.ts # Named Pipe server (JSON-RPC 2.0)
├── acpLayer.ts          # ACP multi-agent (invoke, cancel, parallel)
├── otCommand.ts         # /ot natural language schedule modal
├── vaultQuery.ts        # /search, /backlinks, /links
├── logWriter.ts         # _logs folder append-only log writer
├── hubGenerator.ts      # Hub generation engine (progressive summary)
├── scheduler.ts         # Cron scheduler (claude -p execution)
├── SchemaMapView.ts     # Schema map SVG (dimension → hub → deploy)
├── RoadmapView.ts       # Roadmap Gantt chart (SVG)
├── deployRegistry.ts    # Deploy registry (symlink/copy management)
├── ruleSync.ts          # Rule sync (Harness → LLM configs)
├── vaultIndexer.ts      # Vault metadata JSON dump
└── contextSync.ts       # Context sync script generator

scripts/
├── mcp-schedule-server.mjs  # Standalone MCP stdio server (schedule CRUD)
└── antigravity_extract.py   # Antigravity conversation extractor

conpty-bridge/               # Windows: Rust ConPTY bridge
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| Python PTY (macOS/Linux) | No native modules; `pty` module ships with the OS |
| Rust ConPTY bridge (Windows) | Single static binary (~400KB); no Python/runtime dependency |
| Same resize protocol | `\x1b]resize;cols;rows\x07` — platform-agnostic, parsed by both backends |
| Login shell (`-l`) on macOS | Loads user's PATH config (nvm, homebrew, etc.) |
| Job Object on Windows | Ensures child processes are killed when bridge exits |

## Roadmap

- [x] Phase 1: macOS + Windows + Linux terminal
- [x] Phase 2: Vault intelligence (/ot, MCP, queries, logs, hub generator)
- [x] Phase 3: Schema map (dimension → hub build → deploy)
- [x] Phase 4: Roadmap view (SVG Gantt chart)
- [x] Phase 5-A: Named Pipe context server + injector
- [x] Phase 5-B: ACP multi-agent orchestration
- [x] Phase 5-C: Multiple terminal tabs, split panes, close confirmation, theme-aware UI
- [ ] wmux integration (bidirectional Named Pipe terminal control)
- [ ] Linux Obsidian GUI test (community plugin registration blocker)
- [ ] Community plugin store registration

## Building the ConPTY Bridge (Windows)

The ConPTY bridge must be compiled on Windows (or cross-compiled):

```bash
# On Windows:
cd conpty-bridge
cargo build --release
# → target\release\conpty-bridge.exe (~400KB)

# Copy to plugin folder:
copy target\release\conpty-bridge.exe <vault>\.obsidian\plugins\obsidian-ai-terminal\
```

## License

MIT

## Credits

- [xterm.js](https://xtermjs.org/) — Terminal UI rendering
- [windows-rs](https://github.com/microsoft/windows-rs) — Rust Windows API bindings
- Built with [Claude Code](https://claude.ai/claude-code)
