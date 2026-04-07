# MCP 작업로그 동기화 설계

## 설계 결정사항

| 항목 | 결정 | 비고 |
|------|------|------|
| MCP 범위 | **cron 제어 전용** (schedule CRUD) | 로그/허브는 플러그인 내부 처리 |
| LLM 호출 우선순위 | 1) `claude -p` (구독 인증) → 2) API → 3) 터미널 UI 수동 | scheduler.ts의 runClaude() 재활용 |
| 스케줄 DB | 기존 scheduler와 공유 (schedules.json) | ScheduleEntry 확장, settings 토글은 독립 |
| 멀티PC 동기화 | host별 폴더 분리 (`_logs/{host}/{agent}/`) | 쓰기 경로 분리로 충돌 원천 차단 |
| 컨텍스트 전달 | 허브노트 symlink → 각 LLM 컨텍스트 디렉토리 | MCP 불필요, 셸 스크립트로 충분 |
| 컨텍스트 누적 | progressive summarization (daily→weekly→monthly) | 허브 생성 시 depth로 범위 제한 |
| 하네스 vs 로그 | 역할 분리: 하네스=규칙 배포(outbound), 로그=활동 추적(inbound) | 허브는 사실만 기록, 규칙 제안 금지 |
| 에이전트 협업 | 이연 (현 단계 범위 밖) | 태스크 큐, vault/request_create 등 |

---

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────────┐
│  Obsidian Vault                                         │
│                                                         │
│  _logs/{host}/{agent}/{date}.md   ← 각 PC/LLM이 쓰기   │
│  허브_{project}.md                ← cron이 읽기 전용 생성│
│                                                         │
│  ┌──────────────────────────────┐                       │
│  │  AI Terminal Plugin          │                       │
│  │  ├─ Log Writer (내부 I/O)    │  ← MCP 아님           │
│  │  ├─ Hub Generator (claude -p)│  ← MCP 아님           │
│  │  ├─ Scheduler (cron)         │  ← 기존 유지           │
│  │  └─ MCP Server               │  ← schedule CRUD만    │
│  └──────────────────────────────┘                       │
└───────────┬─────────────────────┬───────────────────────┘
            │                     │
       symlink                MCP Protocol
            │                     │
   ┌────────┴────────┐    ┌──────┴──────┐
   │ LLM 컨텍스트     │    │ Claude Code │
   │ CLAUDE.md        │    │ (cron 제어)  │
   │ AGENTS.md        │    └─────────────┘
   │ .gemini.md       │
   └─────────────────┘
```

**핵심:** MCP는 cron 스케줄 CRUD에만 사용. 로그 쓰기, 허브 생성, 컨텍스트 전달은 모두 플러그인 내부 + 파일시스템으로 처리.

---

## Part 1. MCP Tool 스키마 (cron 제어 전용)

MCP Server가 노출하는 Tool은 스케줄 관리 3개뿐.

---

### Tool 1: `schedule/set` — 스케줄 등록/수정

```json
{
  "name": "schedule/set",
  "description": "반복 작업을 cron 스케줄로 등록한다.",
  "inputSchema": {
    "type": "object",
    "required": ["name", "cron", "action"],
    "properties": {
      "name": {
        "type": "string",
        "description": "스케줄 식별 이름",
        "examples": ["아침브리핑", "하네스팩토리_허브갱신", "주간요약"]
      },
      "cron": {
        "type": "string",
        "description": "cron 표현식 (5필드: 분 시 일 월 요일)",
        "examples": ["0 8 * * *", "0 9 * * 1-5", "0 7 * * 1"]
      },
      "action": {
        "type": "string",
        "enum": ["claude-prompt", "hub-generate", "weekly-summary", "monthly-summary"],
        "description": "실행할 내부 액션. claude-prompt=claude -p 실행, hub-generate=허브노트 갱신, weekly/monthly-summary=요약 생성"
      },
      "actionInput": {
        "type": "object",
        "description": "액션에 전달할 파라미터. hub-generate면 {project, depth}, claude-prompt면 {promptId}",
        "examples": [
          {"project": "하네스팩토리", "depth": "daily"},
          {"promptId": "briefing-001"}
        ]
      },
      "enabled": {
        "type": "boolean",
        "default": true
      }
    }
  }
}
```

### Tool 2: `schedule/list` — 스케줄 조회

```json
{
  "name": "schedule/list",
  "description": "등록된 스케줄 목록을 반환한다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "enabled_only": {
        "type": "boolean",
        "default": false,
        "description": "활성 스케줄만 조회"
      }
    }
  }
}
```

### Tool 3: `schedule/delete` — 스케줄 삭제

```json
{
  "name": "schedule/delete",
  "description": "스케줄을 삭제한다.",
  "inputSchema": {
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": {
        "type": "string",
        "description": "삭제할 스케줄 이름"
      }
    }
  }
}
```

---

### 스케줄 DB (기존 scheduler와 공유)

저장 경로: `.obsidian/plugins/obsidian-ai-terminal/schedules.json`

```typescript
// scheduler.ts ScheduleEntry 확장
interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  output: "daily-note" | "notice" | "none";
  enabled: boolean;
  lastRun: string | null;
  createdAt: string;
  // ── 확장 (optional) ──
  source?: "cli" | "mcp";              // 생성 주체
  action?: string;                      // 내부 액션 (없으면 기존 claude -p)
  actionInput?: Record<string, any>;    // 액션 파라미터
}
```

**실행 분기 (scheduler.ts execute):**
- `action` 없음 → 기존 `claude -p` (promptId.md 기반)
- `action: "hub-generate"` → 플러그인 내부 허브 생성 로직 호출
- `action: "weekly-summary"` → 주간 요약 생성 로직 호출
- `action: "monthly-summary"` → 월간 요약 생성 로직 호출

**안전장치:** 스케줄 항목 삭제 ≠ MCP 기능 off. MCP 서버 on/off는 settings의 독립 토글이 관장.

---

## Part 2. 로그 시스템 (플러그인 내부, MCP 아님)

### 폴더 구조

```
10_Project/{project}/_logs/
├── {host1}/
│   ├── claude-code/
│   │   ├── 2026-03-31.md
│   │   └── 2026-03-30.md
│   └── codex/
│       └── 2026-03-31.md
├── {host2}/
│   └── claude-code/
│       └── 2026-03-31.md
└── _summaries/
    ├── _weekly/
    │   └── 2026-W14.md
    └── _monthly/
        └── 2026-03.md
```

**쓰기 규칙:**
- 각 PC는 자기 `{host}/` 폴더에만 쓴다 → 동기화 충돌 불가
- host는 `os.hostname()` 자동 결정
- 하루 1파일, append-only

**읽기 규칙 (LLM 세션 시작 시):**
1. 자기 로컬: `_logs/{myHost}/{myAgent}/*` (자기가 쓴 것)
2. 볼트 동기화: `_logs/{otherHost}/**/*` (다른 PC/LLM 것)
3. 허브노트: `허브_{project}.md` (symlink로 접근)

### 로그 엔트리 스키마

```markdown
---
agent: claude-code
host: pc1
date: 2026-03-31
repo: harness-factory
entry_count: 2
---

## #1 | cc-pc1-20260331-a1b2 | 14:30

### 작업 내역
- DAG 노드 실행 순서 버그 수정 (topological sort 로직)

### 변경 파일
- `src/dag/executor.py` [modified] — sort 로직 변경

### 미결 사항
- [ ] 타임아웃 시 재시도 로직 미구현

`tags: DAG설계, 버그수정`

---

## #2 | cc-pc1-20260331-c5d6 | 17:15

### 작업 내역
- Atom 모델 Group 5 스키마 정의

`tags: Atom모델, 스키마`
```

---

## Part 3. 허브노트 + Symlink (컨텍스트 전달)

### 허브노트 역할

허브노트는 **읽기 전용 집계 뷰**. 사람과 LLM 모두가 프로젝트 현황을 한눈에 보는 용도.

```
10_Project/{project}/허브_{project}.md
```

### Symlink로 LLM 컨텍스트 전달

각 LLM이 세션 시작 시 자동으로 읽는 위치에 허브노트를 symlink:

```bash
# Claude Code — 프로젝트 CLAUDE.md에서 참조하거나 직접 symlink
ln -s /vault/10_Project/하네스팩토리/허브_하네스팩토리.md \
      /repo/harness-factory/.claude/hub-context.md

# Codex — AGENTS.md에서 참조
ln -s /vault/10_Project/하네스팩토리/허브_하네스팩토리.md \
      /repo/harness-factory/AGENTS-context.md

# Gemini — .gemini/ 디렉토리에 배치
ln -s /vault/10_Project/하네스팩토리/허브_하네스팩토리.md \
      ~/.gemini/context/하네스팩토리.md
```

### Symlink 셋업 스크립트

AI Terminal에서 실행 가능한 셸 스크립트:

```bash
#!/bin/bash
# setup-context-links.sh
# 사용법: ./setup-context-links.sh <vault-path> <project> <repo-path>

VAULT="$1"
PROJECT="$2"
REPO="$3"
HUB="${VAULT}/10_Project/${PROJECT}/허브_${PROJECT}.md"

if [ ! -f "$HUB" ]; then
  echo "허브노트 없음: $HUB"
  exit 1
fi

# Claude Code
mkdir -p "${REPO}/.claude"
ln -sf "$HUB" "${REPO}/.claude/hub-context.md"
echo "Claude Code symlink 생성: ${REPO}/.claude/hub-context.md"

# CLAUDE.md에 참조 추가 (없으면)
if ! grep -q "hub-context.md" "${REPO}/CLAUDE.md" 2>/dev/null; then
  echo "" >> "${REPO}/CLAUDE.md"
  echo "## Project Context" >> "${REPO}/CLAUDE.md"
  echo "See [hub-context.md](.claude/hub-context.md) for cross-PC/cross-agent activity summary." >> "${REPO}/CLAUDE.md"
  echo "CLAUDE.md에 참조 추가됨"
fi

echo "완료: ${PROJECT} → ${REPO}"
```

---

## Part 4. 허브 생성 (cron + claude -p)

### 생성 흐름

```
[cron 트리거] → scheduler.execute()
      │
      ├─ action: "hub-generate"
      │     │
      │     ▼
      │  1. _logs/*/{agent}/ 하위 로그 수집 (depth에 따라)
      │  2. 중복 판별 전처리
      │  3. claude -p로 요약 생성 (1순위)
      │  4. 허브노트 섹션 교체
      │
      ├─ action: "weekly-summary"
      │     │
      │     ▼
      │  _logs/{host}/{agent}/ 지난주 daily → _summaries/_weekly/
      │
      └─ action: "monthly-summary"
            │
            ▼
         _summaries/_weekly/ 지난달 → _summaries/_monthly/
```

### LLM 호출 우선순위

1. **cli (1순위):** `claude -p` — 기존 scheduler.runClaude() 재활용, 구독 인증
2. **api (2순위):** Anthropic API 직접 호출 — 구독 불가 환경
3. **manual (3순위):** 터미널 UI에 프롬프트 표시, 사용자가 수동 보정

### Progressive Summarization

| depth | 허브가 읽는 범위 | 용도 |
|-------|----------------|------|
| daily | 최근 3일 원본 | 일일 갱신 (기본) |
| weekly | 이번 주 daily + 지난주 _weekly/ | 주간 리뷰 |
| full | 이번 달 weekly + 이전 _monthly/ | 월초/분기 리뷰 |

요약 생성 cron:
- 매주 월요일 07:00 → 지난주 daily → `_summaries/_weekly/{YYYY}-W{ww}.md`
- 매월 1일 07:00 → 지난달 weekly → `_summaries/_monthly/{YYYY}-{MM}.md`

원본은 절대 삭제하지 않음. 회계 비유: 일계표 → 월계표 → 연간 총괄표.

### 중복 판별 (플러그인 내부 전처리)

```
입력: _logs/**/ 에서 수집된 entries[]

Step 1: 동일 작업 클러스터링
  같은 파일에 대한 같은 작업 → 최신 1건만 active

Step 2: 교차 작업 감지
  같은 path를 다른 agent 또는 다른 host가 수정 → 🔀 경고

Step 3: 미결 사항 통합
  반복 미결 → 최초 등록일 + 경과일수, 1건으로 통합

Step 4: 해결 확인
  이전 미결과 매칭되는 work_item 존재 → ✅ 마킹
```

---

## Part 5. 허브 생성 프롬프트

허브 생성 시 `claude -p`에 전달되는 프롬프트.

### System Prompt

```
당신은 프로젝트 작업 로그를 분석하여 허브노트를 생성하는 큐레이터입니다.

## 역할
- 여러 에이전트(claude-code, codex, claude-chat 등)의 작업 로그를 읽고
- 중복을 제거하고, 핵심만 추출하여
- 프로젝트 상황을 한눈에 파악할 수 있는 허브노트를 생성합니다.

## 절대 규칙

### 1. 원본 보존
- 원본 로그는 절대 수정하지 않습니다.
- 허브는 "뷰"일 뿐, 원장을 고치는 것이 아닙니다.

### 2. 중복 제거 기준
- 동일 작업: 같은 파일에 대한 같은 종류의 작업이 복수 엔트리에 있으면 → 최신 1건만 요약에 포함
- 교차 작업: 같은 파일/모듈을 서로 다른 에이전트/호스트가 다뤘으면 → "교차 작업" 표시로 충돌 가능성 알림
- 미결 반복: 동일 미결 사항이 여러 날에 걸쳐 반복되면 → 최초 등록일 + 경과일수 표시, 1건으로 통합

### 3. 요약 원칙
- 사실만 기록. "잘 진행되고 있다" 같은 해석 금지.
- 각 문장에 출처 표시: (agent@host, session_id)
- 3줄 이내로 전체 상황 요약
- 미결 사항은 빠짐없이 수집
```

### User Prompt 템플릿

```
## 허브노트 갱신 요청

**프로젝트**: {{project}}
**기간**: {{since}} ~ {{until}}
**이전 허브 요약**:
{{previous_summary}}

---

## 신규 로그 데이터

{{#each entries}}
### [{{agent}}@{{host}}] {{session_id}} | {{timestamp}}
**작업 내역:**
{{#each work_items}}
- {{this}}
{{/each}}

{{#if changed_files}}
**변경 파일:**
{{#each changed_files}}
- `{{path}}` [{{action}}] — {{summary}}
{{/each}}
{{/if}}

{{#if open_items}}
**미결 사항:**
{{#each open_items}}
- [ ] {{this}}
{{/each}}
{{/if}}

`tags: {{join tags ", "}}`

---
{{/each}}

## 기존 미결 사항 (이전 허브에서)

{{#each previous_open_items}}
- [ ] {{text}} (최초: {{first_seen}}, {{days_elapsed}}일 경과) — 출처: {{agent}}@{{host}}
{{/each}}

---

## 요청

위 로그를 분석하여 아래 형식의 허브노트 컨텐츠를 생성하세요.
```

### 출력 포맷

```
## 최근 요약 ({{today}} 갱신)

{3줄 이내. 각 문장 끝에 (agent@host, session_id) 출처 표시}

## 활성 트리거

| 상태 | 내용 | 출처 | 최초 등록 | 경과 |
|------|------|------|----------|------|
| ⚠️ | {내용} | {agent@host} | {날짜} | {N}일 |
| 🔄 | {내용} | {agent@host} | {날짜} | {N}일 |
| 🔀 | {교차 작업 경고} | {agent1@host1, agent2@host2} | {날짜} | - |

상태 아이콘:
- ⚠️ 미결 (3일 이상 경과)
- 🔄 미결 (3일 미만)
- 🔀 교차 작업 (복수 에이전트/호스트가 같은 파일 작업)
- ✅ 이번 기간에 해결됨 (1회만 표시 후 다음 갱신에서 제거)

## 에이전트별 로그

| 에이전트 | 호스트 | 최근 로그 | 마지막 활동 요약 |
|---------|-------|----------|----------------|
| {agent} | {host} | [[{날짜}]] | {1줄 요약} |

## 이번 기간 작업 타임라인

- 🔵 03-31 14:30 | claude-code@pc1 | {1줄 요약}
- 🟢 03-31 15:00 | codex@pc1 | {1줄 요약}
- 🔵 03-31 16:00 | claude-code@macstudio | {1줄 요약}

에이전트 이모지: 🔵 claude-code, 🟢 codex, 🟡 claude-chat, 🔴 gpt, 🟣 gemini
```

---

## Part 6. 통합 시나리오

### 시나리오 A: 매일 아침 자동 브리핑

```
[cron: 0 8 * * *]
     │
     ├─→ hub-generate(project="하네스팩토리", depth="daily")
     ├─→ hub-generate(project="공업사스토어_챗봇", depth="daily")
     │
     ▼
[허브노트 갱신] → symlink로 각 LLM 컨텍스트에 자동 반영
     │
     ▼
[일일노트 업데이트]
  ## 아침 브리핑
  ### [[허브_하네스팩토리]]
  - DAG 버그 수정됨, 타임아웃 재시도 미결 (3일차)
```

### 시나리오 B: PC 이동 시 컨텍스트 연속성

```
[PC1에서 작업]
  claude-code → _logs/pc1/claude-code/2026-03-31.md 기록
     │
     ▼
[볼트 동기화 (iCloud/Obsidian Sync)]
     │
     ▼
[PC2에서 세션 시작]
  claude-code가 읽는 것:
  1. CLAUDE.md → hub-context.md symlink → 허브노트 (최신 요약)
  2. _logs/pc1/claude-code/* (볼트 동기화로 도착한 PC1 로그)
  3. _logs/pc2/claude-code/* (자기가 쓴 것)
     │
     ▼
  "PC1에서 DAG 버그 수정하고 타임아웃 재시도가 미결이군"
  → 이어서 작업 가능, 사용자 설명 불필요
```

### 시나리오 C: Claude Code가 MCP로 cron 등록

```
[Claude Code 세션 중]
  "매일 아침 8시에 허브 갱신해줘"
     │
     ▼
[MCP 호출: schedule/set]
  name: "하네스팩토리_허브갱신"
  cron: "0 8 * * *"
  action: "hub-generate"
  actionInput: { project: "하네스팩토리", depth: "daily" }
     │
     ▼
[schedules.json에 저장]
     │
     ▼
[다음 날 08:00 — scheduler가 자동 실행]
```
