import { App, Modal, Notice, Setting } from "obsidian";
import { Scheduler, type ScheduleEntry, type ScheduleAction } from "./scheduler";
import { spawn } from "child_process";

// ── /ot 모달: 자연어 → cron 스케줄 등록 ──

interface ParsedSchedule {
  name: string;
  cron: string;
  action: ScheduleAction;
  prompt: string; // claude-prompt 액션일 때 사용
  output: "daily-note" | "notice" | "none";
}

/** claude -p로 자연어를 구조화된 스케줄로 파싱 */
function parseWithClaude(input: string, vaultPath: string): Promise<ParsedSchedule> {
  const systemPrompt = `당신은 자연어 스케줄 요청을 JSON으로 변환하는 파서입니다.

입력: 사용자의 자연어 스케줄 요청
출력: 정확히 아래 JSON만 출력 (마크다운 코드블록 없이, 순수 JSON만)

{
  "name": "스케줄 이름 (한국어, 간결하게)",
  "cron": "분 시 일 월 요일",
  "action": "claude-prompt",
  "prompt": "claude -p에 전달할 프롬프트 (한국어, 구체적으로)",
  "output": "daily-note"
}

규칙:
- cron은 5필드 (분 시 일 월 요일)
- "매일 아침 7시" → "0 7 * * *"
- "평일 아침 9시" → "0 9 * * 1-5"
- "매주 월요일 8시" → "0 8 * * 1"
- "매월 1일 7시" → "0 7 1 * *"
- action은 항상 "claude-prompt" (다른 액션은 사용자가 직접 설정)
- output은 기본 "daily-note"
- prompt는 사용자 요청을 구체적인 AI 지시문으로 변환
- JSON만 출력. 설명 텍스트 없음.`;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", `${systemPrompt}\n\n사용자 입력: ${input}`], {
      cwd: vaultPath,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", () =>
      reject(new Error("claude CLI를 찾을 수 없습니다. Claude Code가 설치되어 있는지 확인하세요."))
    );

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }

      try {
        // JSON 추출 (마크다운 코드블록이 올 수도 있음)
        let jsonStr = stdout.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];

        const parsed = JSON.parse(jsonStr) as ParsedSchedule;

        // 필수 필드 검증
        if (!parsed.name || !parsed.cron || !parsed.prompt) {
          reject(new Error("파싱 결과에 필수 필드가 누락되었습니다"));
          return;
        }

        parsed.action = parsed.action || "claude-prompt";
        parsed.output = parsed.output || "daily-note";
        resolve(parsed);
      } catch (e) {
        reject(new Error(`JSON 파싱 실패: ${stdout.trim().slice(0, 200)}`));
      }
    });

    // 30초 타임아웃
    setTimeout(() => {
      child.kill();
      reject(new Error("claude -p 파싱 타임아웃 (30초)"));
    }, 30_000);
  });
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `ot-${ts}-${rand}`;
}

// ── OT 모달 ──

export class OtModal extends Modal {
  private scheduler: Scheduler;
  private vaultPath: string;
  private inputEl: HTMLTextAreaElement | null = null;

  constructor(app: App, scheduler: Scheduler) {
    super(app);
    this.scheduler = scheduler;
    this.vaultPath = (this.app.vault.adapter as any).basePath as string;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ot-modal");

    contentEl.createEl("h2", { text: "스케줄 등록 (/ot)" });
    contentEl.createEl("p", {
      text: "자연어로 스케줄을 설명하면, AI가 cron 표현식으로 변환하여 등록합니다.",
      cls: "setting-item-description",
    });

    // 입력 영역
    const inputContainer = contentEl.createDiv({ cls: "ot-input-container" });
    this.inputEl = inputContainer.createEl("textarea", {
      cls: "ot-input",
      attr: {
        placeholder: "예: 매일 아침 7시에 어제 수정된 노트 요약해줘\n예: 평일 9시에 프로젝트 진행상황 브리핑\n예: 매주 월요일에 지난주 작업 정리",
        rows: "4",
      },
    });
    this.inputEl.style.width = "100%";
    this.inputEl.style.resize = "vertical";
    this.inputEl.style.fontFamily = "inherit";
    this.inputEl.style.fontSize = "14px";
    this.inputEl.style.padding = "8px";

    // 예시 버튼들
    const examples = contentEl.createDiv({ cls: "ot-examples" });
    examples.style.marginBottom = "12px";
    examples.style.display = "flex";
    examples.style.gap = "6px";
    examples.style.flexWrap = "wrap";

    const exampleTexts = [
      "매일 아침 8시에 어제 수정된 노트 요약",
      "평일 9시에 프로젝트 브리핑",
      "매주 월요일 7시에 주간 작업 정리",
    ];

    for (const ex of exampleTexts) {
      const btn = examples.createEl("button", { text: ex, cls: "ot-example-btn" });
      btn.style.fontSize = "11px";
      btn.style.padding = "2px 8px";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", () => {
        if (this.inputEl) this.inputEl.value = ex;
      });
    }

    // 결과 미리보기 영역
    const previewEl = contentEl.createDiv({ cls: "ot-preview" });
    previewEl.style.display = "none";

    // 상태 표시
    const statusEl = contentEl.createDiv({ cls: "ot-status" });
    statusEl.style.marginTop = "8px";
    statusEl.style.fontSize = "12px";
    statusEl.style.color = "var(--text-muted)";

    // 버튼들
    const buttonContainer = contentEl.createDiv({ cls: "ot-buttons" });
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.marginTop = "16px";

    // 파싱 버튼
    const parseBtn = buttonContainer.createEl("button", {
      text: "파싱",
      cls: "mod-cta",
    });

    // 등록 버튼 (파싱 후 표시)
    const registerBtn = buttonContainer.createEl("button", {
      text: "등록",
      cls: "mod-cta",
    });
    registerBtn.style.display = "none";

    // 즉시 테스트 버튼
    const testBtn = buttonContainer.createEl("button", { text: "테스트 실행" });
    testBtn.style.display = "none";

    let parsed: ParsedSchedule | null = null;

    parseBtn.addEventListener("click", async () => {
      const input = this.inputEl?.value.trim();
      if (!input) {
        new Notice("스케줄 내용을 입력하세요");
        return;
      }

      statusEl.textContent = "AI가 파싱 중...";
      statusEl.style.color = "var(--text-accent)";
      parseBtn.disabled = true;

      try {
        parsed = await parseWithClaude(input, this.vaultPath);

        // 미리보기 표시
        previewEl.style.display = "block";
        previewEl.empty();
        previewEl.createEl("h4", { text: "파싱 결과" });

        const table = previewEl.createEl("table");
        table.style.width = "100%";
        table.style.fontSize = "13px";

        const rows: [string, string][] = [
          ["이름", parsed.name],
          ["Cron", `${parsed.cron} (${describeCron(parsed.cron)})`],
          ["액션", parsed.action],
          ["출력", parsed.output],
          ["프롬프트", parsed.prompt.slice(0, 100) + (parsed.prompt.length > 100 ? "..." : "")],
        ];

        for (const [label, value] of rows) {
          const tr = table.createEl("tr");
          const td1 = tr.createEl("td", { text: label });
          td1.style.fontWeight = "bold";
          td1.style.padding = "4px 8px";
          td1.style.whiteSpace = "nowrap";
          tr.createEl("td", { text: value }).style.padding = "4px 8px";
        }

        statusEl.textContent = "파싱 완료. 확인 후 등록하세요.";
        statusEl.style.color = "var(--text-success)";

        registerBtn.style.display = "inline-block";
        testBtn.style.display = "inline-block";
      } catch (err: any) {
        statusEl.textContent = `파싱 실패: ${err.message}`;
        statusEl.style.color = "var(--text-error)";
        parsed = null;
      } finally {
        parseBtn.disabled = false;
      }
    });

    registerBtn.addEventListener("click", async () => {
      if (!parsed) return;

      const id = generateId();
      const entry: ScheduleEntry = {
        id,
        name: parsed.name,
        cron: parsed.cron,
        output: parsed.output,
        enabled: true,
        lastRun: null,
        createdAt: new Date().toISOString(),
        source: "ot",
        action: parsed.action,
      };

      const promptContent = parsed.action === "claude-prompt" ? parsed.prompt : undefined;
      await this.scheduler.addEntry(entry, promptContent);

      new Notice(`스케줄 등록 완료: "${parsed.name}" [${parsed.cron}]`);
      this.close();
    });

    testBtn.addEventListener("click", async () => {
      if (!parsed) return;

      statusEl.textContent = "테스트 실행 중...";
      statusEl.style.color = "var(--text-accent)";
      testBtn.setAttribute("disabled", "true");

      try {
        // 임시 엔트리로 즉시 실행
        const tempEntry: ScheduleEntry = {
          id: `test-${Date.now()}`,
          name: parsed.name,
          cron: parsed.cron,
          output: "notice", // 테스트는 notice로
          enabled: true,
          lastRun: null,
          createdAt: new Date().toISOString(),
          source: "ot",
          action: parsed.action,
        };

        // 테스트용 프롬프트 임시 저장
        if (parsed.action === "claude-prompt") {
          await this.scheduler.ensureSchedulesDir();
          const promptPath = `.obsidian/plugins/obsidian-ai-terminal/schedules/${tempEntry.id}.md`;
          await this.app.vault.adapter.write(promptPath, parsed.prompt);

          const result = await this.scheduler.execute(tempEntry);

          // 임시 파일 정리
          await this.app.vault.adapter.remove(promptPath);

          statusEl.textContent = `테스트 완료: ${result.slice(0, 100)}`;
          statusEl.style.color = "var(--text-success)";
        } else {
          const result = await this.scheduler.execute(tempEntry);
          statusEl.textContent = `테스트 완료: ${result}`;
          statusEl.style.color = "var(--text-success)";
        }
      } catch (err: any) {
        statusEl.textContent = `테스트 실패: ${err.message}`;
        statusEl.style.color = "var(--text-error)";
      } finally {
        testBtn.removeAttribute("disabled");
      }
    });

    // Enter로 파싱 트리거 (Shift+Enter로 줄바꿈)
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        parseBtn.click();
      }
    });

    // 포커스
    setTimeout(() => this.inputEl?.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** cron 표현식을 사람이 읽을 수 있는 한국어로 변환 */
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dom, month, dow] = parts;

  const dowNames: Record<string, string> = {
    "0": "일", "1": "월", "2": "화", "3": "수", "4": "목", "5": "금", "6": "토",
    "1-5": "평일", "0,6": "주말",
  };

  let desc = "";

  // 요일
  if (dow === "*") {
    if (dom === "*" && month === "*") {
      desc = "매일";
    } else if (dom !== "*" && month === "*") {
      desc = `매월 ${dom}일`;
    }
  } else if (dowNames[dow]) {
    desc = `매주 ${dowNames[dow]}요일`;
  } else {
    desc = `요일(${dow})`;
  }

  // 시간
  if (hour !== "*" && minute !== "*") {
    desc += ` ${hour}시 ${minute === "0" ? "" : minute + "분"}`.trimEnd();
  }

  return desc || cron;
}
