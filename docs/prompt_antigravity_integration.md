---
용도: obsidian-ai-terminal 프로젝트에 Antigravity 대화 추출 기능을 통합하기 위한 프롬프트
작성일: 2026-04-03
컨텍스트: Antigravity 역공학 완료, 추출기 PoC 검증 완료
---

# 프롬프트: Antigravity 대화 추출 → obsidian-ai-terminal 통합

아래 프롬프트를 새 Claude Code 세션에서 사용하세요.

---

```
당신은 obsidian-ai-terminal 플러그인 개발자다.

## 배경

Antigravity(Google의 코딩 에이전트 데스크톱 앱)의 로컬 대화 저장소를 역공학한 결과,
Go Language Server의 gRPC API를 통해 암호화된 .pb 파일에서 전문 transcript를
추출할 수 있음이 확인되었다.

역공학 상세 결과: docs/obsidian_symlink/Antigravity_역공학_분석결과.md
기존 정책 문서: docs/obsidian_symlink/대화원본_참조정책_설계.md
PoC 추출기: scripts/antigravity_extract.py

## 확인된 사실 요약

1. Antigravity의 conversations/*.pb는 AES-256-GCM으로 암호화된 protobuf
2. Go Language Server (language_server_windows_x64.exe)가 복호화를 담당
3. gRPC/Connect API: `GetCascadeTrajectory` (HTTPS, localhost)
   - 엔드포인트: /exa.language_server_pb.LanguageServerService/GetCascadeTrajectory
   - 인증: x-codeium-csrf-token 헤더 (LS 프로세스 --csrf_token에서 자동 추출)
   - 요청: {"cascadeId": "{uuid}"}
   - 응답: 전체 trajectory JSON (user/assistant/thinking/code_action/metadata)
4. 25/25 대화 100% 추출 성공, JSON 37.8MB + MD 0.6MB
5. LS 포트/CSRF는 PowerShell로 프로세스 커맨드라인에서 자동 탐지

## 현재 상태

- 대화원본_참조정책_설계.md에서 Antigravity 상태: reference_only → extractable로 변경됨
- scripts/antigravity_extract.py가 독립 실행형 PoC로 동작 확인 완료
- 아직 obsidian-ai-terminal 플러그인 코드에는 통합되지 않음

## 요청 작업

### 1단계: contextSync에 Antigravity 어댑터 추가

src/contextSync.ts (또는 새 파일)에 Antigravity 대화 소스를 추가하라.
기존 Claude Code, Gemini CLI, Codex 어댑터와 동일한 패턴으로:

- LS 자동 탐지 (프로세스 목록 → 포트/CSRF 추출)
- GetCascadeTrajectory API 호출
- 응답에서 transcript 추출 (userResponse, plannerResponse.response, createdAt)
- 표준 로그 포맷으로 변환

제약조건:
- Antigravity 앱이 실행 중이 아니면 graceful skip (에러 아님)
- LS 포트/CSRF는 매번 동적으로 탐지 (하드코딩 금지)
- conversations/*.pb 파일 자체는 절대 수정하지 않음
- HTTPS 자기서명 인증서 무시 필요 (localhost)

### 2단계: 로그 경로 규칙 반영

CLAUDE.md의 MCP & Log Architecture 규칙에 따라:
- 로그 경로: 10_Project/{project}/_logs/{host}/antigravity/{YYYY-MM-DD}.md
- 허브노트에 Antigravity 대화 링크 추가
- 허브 = view, 원본 수정 금지

### 3단계: 스케줄러 통합 (선택)

기존 cron 스케줄러에 Antigravity 추출 주기를 추가할 수 있으면 추가하라.
단, MCP scope은 cron schedule CRUD만이므로, 실제 추출은 plugin-internal.

## 참조 파일

반드시 아래 파일을 읽고 시작하라:
1. docs/obsidian_symlink/Antigravity_역공학_분석결과.md — 전체 역공학 결과
2. docs/obsidian_symlink/대화원본_참조정책_설계.md — 원본 참조 정책
3. scripts/antigravity_extract.py — PoC 추출기 (Python, 동작 확인 완료)
4. src/contextSync.ts — 기존 컨텍스트 동기화 코드
5. CLAUDE.md — 프로젝트 규칙 및 MCP/Log 아키텍처

## 성공 기준

- Antigravity 앱 실행 중: 대화 transcript가 vault 로그에 자동 기록됨
- Antigravity 앱 미실행: 조용히 스킵, 다른 소스 정상 동작
- 기존 Claude Code / Gemini CLI / Codex 추출에 영향 없음
```
