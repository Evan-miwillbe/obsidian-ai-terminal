# wmux × obsidian-ai-terminal Named Pipe 통합 프롬프트

## 배경

obsidian-ai-terminal (Obsidian 플러그인)과 wmux (Windows Terminal 오케스트레이터)를 Named Pipe로 양방향 연결하려 한다.

### 왜 필요한가

Claude Code의 `claude -p` 헤드리스 모드는 타임아웃, 컨텍스트 제한, 불안정해서 실제 운용에 부적합하다. 대신 **실제 Claude Code TUI 세션에 sendKeys**하는 방식이 필요하다. sendKeys가 되려면 PTY를 소유한 프로세스가 있어야 하고, 그게 wmux다.

### 합의된 아키텍처

```
Obsidian (데이터 허브)                wmux (터미널 허브)
\\.\pipe\obsidian-ai-terminal        \\.\pipe\wmux-daemon
┌──────────────────┐                 ┌──────────────────────┐
│ Named Pipe 서버   │                 │ Named Pipe 서버       │
│                  │                 │                      │
│ 볼트 컨텍스트 제공 │◀───연결────────▶│ 터미널 세션 관리       │
│ context/get      │                 │ session.send         │
│ vault/read       │                 │ session.send_key     │
│ vault/write      │                 │ session.list         │
│ obsidian/openNote│                 │ session.create       │
│                  │                 │                      │
│ 스케줄/허브/로그  │                 │ PTY 소유 (ConPTY)     │
│ ACP 에이전트 호출 │                 │ Agent Observability   │
└──────────────────┘                 └──────────────────────┘
```

핵심 흐름: Obsidian에서 "paint-recipe 프로젝트 테스트 돌려줘" → Obsidian이 wmux 파이프에 `session.send` → wmux가 해당 PTY stdin에 write → Claude Code TUI가 받아서 실행 → 결과는 PTY stdout으로 나옴

---

## obsidian-ai-terminal 현재 상태 (2026-04-09)

### Named Pipe 서버: `\\.\pipe\obsidian-ai-terminal`

JSON-RPC 2.0 over Named Pipe. Obsidian 플러그인 시작 시 자동 실행.

**구현된 메서드:**

| 메서드 | 방향 | 설명 |
|--------|------|------|
| `context/get` | 읽기 | 볼트 전체 컨텍스트 (활성 노트, 최근 수정, 허브 목록, 통계) |
| `context/activeNote` | 읽기 | 현재 열린 노트의 프론트매터, 태그, 링크, 백링크 |
| `context/hubs` | 읽기 | 프로젝트 허브노트 목록 |
| `context/recent` | 읽기 | 최근 수정된 노트 경로 (10개) |
| `vault/read` | 읽기 | 특정 노트 내용 읽기 |
| `vault/write` | 쓰기 | 노트 생성/수정 |
| `obsidian/openNote` | 제어 | Obsidian에서 특정 노트 열기 |
| `obsidian/executeCommand` | 제어 | Obsidian 커맨드 실행 |
| `obsidian/listCommands` | 읽기 | 사용 가능한 Obsidian 커맨드 목록 |
| `terminal/sendKeys` | 제어 | Obsidian 내장 터미널 PTY에 키 입력 |
| `terminal/output` | 제어 | Obsidian 내장 터미널 화면에 텍스트 출력 |
| `agent/list` | ACP | 등록된 에이전트 목록 (claude, codex, gemini) |
| `agent/invoke` | ACP | 에이전트에 프롬프트 전달 |
| `agent/status` | ACP | 실행 중인 호출 상태 |
| `agent/cancel` | ACP | 실행 중인 호출 취소 |
| `ping` | 진단 | 서버 응답 확인 |

**테스트 (독립 PowerShell에서 확인됨):**
```javascript
const net = require('net');
const c = net.connect('//./pipe/obsidian-ai-terminal', () => {
  c.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"context/get",params:{}}) + "\n");
});
c.on('data', d => console.log(JSON.parse(d.toString())));
```

### 플러그인 구성 (389KB, 의존성 추가 zero)

```
src/
├── main.ts              — 플러그인 엔트리 (커맨드 등록, 서브시스템 초기화)
├── TerminalView.ts      — xterm.js + PTY (Obsidian 내장 터미널)
├── PtyProcess.ts        — PTY 래퍼 (Win ConPTY / Mac/Linux Python PTY)
├── watchdog.ts          — 볼트 변경 감지 → ContextIndex 실시간 갱신
├── contextPipeServer.ts — Named Pipe 서버 (JSON-RPC 2.0)
├── acpLayer.ts          — ACP 멀티 에이전트 (invoke, cancel, parallel)
├── scheduler.ts         — cron 스케줄러 (claude -p 실행)
├── otCommand.ts         — /ot 자연어 스케줄 모달
├── vaultQuery.ts        — /search, /backlinks, /links
├── logWriter.ts         — _logs 폴더 append-only 로그
├── hubGenerator.ts      — 허브 생성 엔진 (progressive summary)
├── SchemaMapView.ts     — 스키마 맵 SVG (디멘션→허브→배포)
├── RoadmapView.ts       — 로드맵 간트 차트
├── deployRegistry.ts    — 배포 레지스트리 (심링크/복사 관리)
├── ruleSync.ts          — 규칙 동기화 (Harness→LLM configs)
├── vaultIndexer.ts      — 볼트 메타데이터 JSON 덤프
├── contextSync.ts       — 컨텍스트 동기화 스크립트 생성
└── settings.ts          — 설정 UI
```

---

## wmux 현재 상태 (확인된 것)

- **Phase 1-1 완료**: Daemon + SQLite + send+enter E2E 검증됨
- **3-프로세스 아키텍처**: CLI(wmux.exe) → Daemon(wmux-daemon.exe) → GUI(Wmux.App.exe)
- **Named Pipe 2개**: `wmux-daemon` (CLI↔Daemon), `wmux-gui` (Daemon↔GUI)
- **JSON-RPC 2.0**: `session.send`, `session.send_key`, `session.list`, `session.create` 등
- **SQLite**: sessions, agent_events, context_attachments, session_metrics 테이블
- **기술 스택**: C# .NET 8 + WPF + EasyWindowsTerminalControl + WebView2 + SQLite

---

## 요청사항: wmux에 Obsidian Named Pipe 클라이언트 추가

### 목표

wmux Daemon이 Obsidian의 Named Pipe(`\\.\pipe\obsidian-ai-terminal`)에 **클라이언트로 연결**하여:

1. **볼트 컨텍스트를 읽어와** 터미널 세션에 주입
2. Obsidian에서 **wmux 세션에 sendKeys** 가능하게 중계
3. 양방향: wmux에서도 Obsidian을 제어 (노트 열기, 볼트 쓰기)

### 구현 범위

#### 1. Obsidian Pipe 클라이언트 (`Wmux.Core/Pipe/ObsidianPipeClient.cs`)

```
\\.\pipe\obsidian-ai-terminal에 연결
├── 연결 시: context/get 호출 → 현재 볼트 상태 캐시
├── vault/changed 알림 구독 → 볼트 변경 시 인덱스 갱신
├── 세션 시작 시: context/activeNote 호출 → 세션 컨텍스트에 주입
└── 연결 끊김 시: 재연결 (Obsidian 재시작 대응)
```

#### 2. Obsidian ↔ wmux 브릿지 메서드 (Daemon MethodRouter에 추가)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `obsidian.context` | CLI→Daemon→Obsidian Pipe | 볼트 컨텍스트 조회 (프록시) |
| `obsidian.openNote` | CLI→Daemon→Obsidian Pipe | Obsidian에서 노트 열기 |
| `obsidian.read` | CLI→Daemon→Obsidian Pipe | 노트 내용 읽기 |
| `obsidian.write` | CLI→Daemon→Obsidian Pipe | 노트 생성/수정 |

CLI 사용:
```bash
wmux obsidian context                    # 볼트 상태
wmux obsidian open "10_Project/..."      # 노트 열기
wmux obsidian read "10_Project/..."      # 노트 읽기
```

#### 3. Obsidian → wmux sendKeys 경로

Obsidian 플러그인의 Named Pipe 서버에 `wmux/sendKeys` 메서드를 추가하는 대신, **Obsidian이 wmux의 파이프에 직접 연결**하는 구조:

```
Obsidian 플러그인
└── wmuxPipeClient (\\.\pipe\wmux-daemon에 연결)
    ├── session.list → wmux 세션 목록
    ├── session.send → 특정 세션에 텍스트 전달
    └── session.send_key → 특정 세션에 키 전달
```

이 부분은 obsidian-ai-terminal 쪽에서 구현할 것. wmux Daemon의 기존 `session.send`, `session.send_key` 메서드가 외부 Named Pipe 클라이언트에서도 동작하는지 확인 필요.

#### 4. 세션 시작 시 컨텍스트 자동 주입

wmux에서 새 터미널 세션 시작 시:
1. Obsidian Pipe에 `context/activeNote` 요청
2. 결과를 환경변수로 주입: `OBSIDIAN_CONTEXT_PIPE`, `OBSIDIAN_VAULT_PATH`, `OBSIDIAN_ACTIVE_NOTE`
3. 기존 MD 컨텍스트 상속과 병합 (context_attachments)

---

## 시나리오

### A. Obsidian에서 wmux 세션에 명령 보내기

```
사용자: Obsidian에서 Ctrl+P → "Send to wmux session"
  ↓
모달: wmux 세션 목록 표시 (wmux pipe session.list)
  ↓
선택: "paint-recipe" 세션
  ↓
입력: "npm test"
  ↓
실행: wmux pipe session.send({target:"paint-recipe", text:"npm test\n"})
  ↓
결과: paint-recipe 터미널의 Claude Code가 "npm test" 입력을 받음
```

### B. wmux CLI에서 볼트 컨텍스트 읽기

```bash
wmux obsidian context
# → Active: obsidian-ai-terminal.md
# → Recent: 5개
# → Vault: 3069 notes, 107 tags

wmux obsidian read "10_Project/하네스팩토리/아키텍처_설계.md"
# → 노트 내용 출력
```

### C. Claude Code가 MCP로 다른 세션 제어

```
Claude Code (retention 프로젝트에서 실행 중):
  → MCP tool: wmux_session_list()
    ← ["paint-recipe", "retention", "myarchive"]

  → MCP tool: wmux_session_send("paint-recipe", "unit test 돌리고 결과 알려줘\n")
    ← (sent: true)
```

이 MCP 서버는 별도 구현 필요: `scripts/mcp-wmux-bridge.mjs` (wmux pipe에 연결하는 stdio MCP 서버)

---

## 우선순위

1. **wmux Daemon이 외부 pipe 클라이언트의 session.send를 수락하는지 확인** (이미 되면 다음으로)
2. **ObsidianPipeClient 추가** (Wmux.Core) — Obsidian 파이프 연결 + context 읽기
3. **Daemon MethodRouter에 obsidian.* 브릿지 추가**
4. **CLI에 `wmux obsidian` 서브커맨드 추가**
5. **obsidian-ai-terminal에 wmuxPipeClient 추가** (역방향 — Obsidian → wmux)
6. **MCP 브릿지 스크립트** (Claude Code에서 wmux 세션 제어)

---

## 참고 경로

| 항목 | 경로 |
|------|------|
| obsidian-ai-terminal | `C:\dev\personal\obsidian-ai-terminal\` |
| wmux | `C:\dev\personal\wmux_windows-terminal-multiplexer\` |
| Obsidian Pipe 서버 코드 | `src/contextPipeServer.ts` |
| Obsidian Watchdog | `src/watchdog.ts` |
| wmux Daemon Pipe | `src/Wmux.Daemon/` |
| wmux Core Pipe | `src/Wmux.Core/Pipe/` |
| wmux Daemon 아키텍처 | `docs/wmux_daemon_architecture.md` |
| Obsidian 볼트 | `C:\MyArchive\MyArchive\` |
