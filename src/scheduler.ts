import { App, Notice } from "obsidian";
import { spawn } from "child_process";
import * as path from "path";

// ── 스케줄 테이블 스키마 ──

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;          // "분 시 일 월 요일" (5필드)
  output: "daily-note" | "notice" | "none";
  enabled: boolean;
  lastRun: string | null; // ISO 8601
  createdAt: string;
  // 프롬프트는 schedules/{id}.md 파일에 별도 저장
}

export interface ScheduleTable {
  version: number;
  schedules: ScheduleEntry[];
}

const EMPTY_TABLE: ScheduleTable = { version: 1, schedules: [] };

// ── Cron 파서 (라이브러리 없음) ──

function matchCronField(field: string, value: number, max: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    // */n  step
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (!isNaN(step) && step > 0 && value % step === 0) return true;
      continue;
    }
    // n-m  range
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    // exact
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

/** 현재 시각(분 단위 절삭)이 cron 표현식과 매칭되는지 */
export function matchesCron(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    matchCronField(minute, now.getMinutes(), 59) &&
    matchCronField(hour, now.getHours(), 23) &&
    matchCronField(dayOfMonth, now.getDate(), 31) &&
    matchCronField(month, now.getMonth() + 1, 12) &&
    matchCronField(dayOfWeek, now.getDay(), 6)
  );
}

// ── Scheduler 본체 ──

export class Scheduler {
  private table: ScheduleTable = EMPTY_TABLE;
  private intervalId: number | null = null;
  private running = new Set<string>(); // 중복 실행 방지

  constructor(
    private app: App,
    private pluginDir: string,
    private dailyNotePath: string, // e.g. "00_Area/01_시간축/일일_노트"
  ) {}

  get schedulesPath(): string {
    return path.join(this.pluginDir, "schedules.json");
  }

  // ── 테이블 I/O ──

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(
        this.relPath("schedules.json"),
      );
      this.table = JSON.parse(raw) as ScheduleTable;
    } catch {
      this.table = { ...EMPTY_TABLE };
    }
  }

  async save(): Promise<void> {
    const json = JSON.stringify(this.table, null, 2);
    await this.app.vault.adapter.write(this.relPath("schedules.json"), json);
  }

  private relPath(file: string): string {
    return `.obsidian/plugins/obsidian-ai-terminal/${file}`;
  }

  get entries(): ScheduleEntry[] {
    return this.table.schedules;
  }

  /** schedules/{id}.md 에서 프롬프트 읽기 */
  async loadPrompt(id: string): Promise<string> {
    const promptPath = this.relPath(`schedules/${id}.md`);
    try {
      return await this.app.vault.adapter.read(promptPath);
    } catch {
      throw new Error(`Prompt file not found: schedules/${id}.md`);
    }
  }

  /** schedules/ 폴더 초기화 + 템플릿 생성 */
  async ensureSchedulesDir(): Promise<void> {
    const dir = this.relPath("schedules");
    const exists = await this.app.vault.adapter.exists(dir);
    if (!exists) {
      await this.app.vault.adapter.mkdir(dir);
    }
    // 템플릿 파일
    const tmplPath = this.relPath("schedules/_template.md");
    const tmplExists = await this.app.vault.adapter.exists(tmplPath);
    if (!tmplExists) {
      await this.app.vault.adapter.write(tmplPath, PROMPT_TEMPLATE);
    }
  }

  // ── Lifecycle ──

  start(pollMs: number): void {
    this.ensureSchedulesDir();
    this.load();
    this.intervalId = window.setInterval(() => this.tick(), pollMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // ── Tick: 매분 cron 매칭 ──

  private async tick(): Promise<void> {
    await this.load(); // 외부 변경(Claude Code 스킬) 반영

    const now = new Date();

    for (const entry of this.table.schedules) {
      if (!entry.enabled) continue;
      if (this.running.has(entry.id)) continue;

      // 같은 분에 중복 실행 방지
      if (entry.lastRun) {
        const last = new Date(entry.lastRun);
        if (
          last.getFullYear() === now.getFullYear() &&
          last.getMonth() === now.getMonth() &&
          last.getDate() === now.getDate() &&
          last.getHours() === now.getHours() &&
          last.getMinutes() === now.getMinutes()
        ) {
          continue;
        }
      }

      if (matchesCron(entry.cron, now)) {
        this.execute(entry, now);
      }
    }
  }

  // ── 실행 ──

  async execute(entry: ScheduleEntry, now?: Date): Promise<string> {
    const ts = now ?? new Date();
    this.running.add(entry.id);

    try {
      const prompt = await this.loadPrompt(entry.id);
      const result = await this.runClaude(prompt);

      // lastRun 갱신
      entry.lastRun = ts.toISOString();
      await this.save();

      // 결과 출력
      await this.writeResult(entry, result, ts);

      new Notice(`Schedule "${entry.name}" completed`);
      return result;
    } catch (err: any) {
      new Notice(`Schedule "${entry.name}" failed: ${err.message}`);
      return `Error: ${err.message}`;
    } finally {
      this.running.delete(entry.id);
    }
  }

  private runClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const child = spawn("claude", ["-p", prompt], {
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

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        }
      });

      // 10분 타임아웃
      setTimeout(() => {
        child.kill();
        reject(new Error("claude -p timed out (10min)"));
      }, 600_000);
    });
  }

  // ── 결과 기록 ──

  private async writeResult(
    entry: ScheduleEntry,
    result: string,
    ts: Date,
  ): Promise<void> {
    if (entry.output === "none") return;

    if (entry.output === "notice") {
      new Notice(result.slice(0, 500), 10_000);
      return;
    }

    // daily-note
    const dateStr = this.formatDate(ts);
    const notePath = `${this.dailyNotePath}/${dateStr}.md`;
    const timeStr = ts.toTimeString().slice(0, 5); // HH:MM

    const section = [
      "",
      `## 🤖 ${entry.name} (${timeStr})`,
      "",
      result,
      "",
      "---",
    ].join("\n");

    const exists = await this.app.vault.adapter.exists(notePath);
    if (exists) {
      const content = await this.app.vault.adapter.read(notePath);
      await this.app.vault.adapter.write(notePath, content + "\n" + section);
    } else {
      // 일일노트가 없으면 최소 프론트매터로 생성
      const header = [
        "---",
        `created: ${dateStr}`,
        `updated: ${dateStr}`,
        `tags: [일일노트]`,
        "---",
        "",
        `# ${dateStr}`,
      ].join("\n");
      await this.app.vault.adapter.write(notePath, header + "\n" + section);
    }
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}

// ── 프롬프트 템플릿 ──

const PROMPT_TEMPLATE = `# Schedule Prompt Template
#
# 이 파일을 복사하여 스케줄 ID와 동일한 이름으로 저장하세요.
# 예: briefing-001.md
#
# 파일 전체 내용이 claude -p의 프롬프트로 전달됩니다.
# 마크다운 형식 자유롭게 사용 가능합니다.

## Role
당신은 옵시디언 볼트의 AI 어시스턴트입니다.

## Task
<!-- 여기에 구체적인 지시사항을 작성하세요 -->

## Output Format
- 한국어로 응답
- 마크다운 형식
- 핵심 내용 위주로 간결하게

## Context
<!-- 필요 시 추가 컨텍스트 -->
`;

