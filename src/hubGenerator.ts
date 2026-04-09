import { App, Notice } from "obsidian";
import { spawn } from "child_process";
import { LogWriter } from "./logWriter";

// ── 허브 생성 엔진 ──
// cron 트리거 → 로그 수집 → 중복 전처리 → claude -p 요약 → 허브노트 갱신

export type HubDepth = "daily" | "weekly" | "full";

export interface HubGenerateInput {
  project: string;     // 볼트 내 프로젝트 경로 (e.g., "10_Project/하네스팩토리")
  depth: HubDepth;
}

export class HubGenerator {
  constructor(
    private app: App,
    private hostName: string,
  ) {}

  /** 허브노트 경로 */
  private hubPath(project: string): string {
    const projectName = project.split("/").pop() ?? project;
    return `${project}/허브_${projectName}.md`;
  }

  /** 요약 저장 경로 */
  private summaryPath(project: string, type: "weekly" | "monthly", label: string): string {
    return `${project}/_logs/_summaries/_${type}/${label}.md`;
  }

  // ── 메인 생성 흐름 ──

  async generate(input: HubGenerateInput): Promise<string> {
    const { project, depth } = input;

    // 1. 로그 수집
    const logWriter = new LogWriter(this.app, project, this.hostName);
    const { since, until } = this.getDateRange(depth);
    const logPaths = await logWriter.collectAllLogs(since, until);

    if (logPaths.length === 0) {
      return `[hub-generate] 로그 없음 (${project}, ${this.formatDate(since)} ~ ${this.formatDate(until)})`;
    }

    // 2. 로그 내용 수집
    const logContents: string[] = [];
    for (const p of logPaths) {
      try {
        const content = await this.app.vault.adapter.read(p);
        logContents.push(content);
      } catch { /* skip unreadable */ }
    }

    // 3. 이전 허브 요약 읽기
    const hubFile = this.hubPath(project);
    let previousSummary = "";
    const hubExists = await this.app.vault.adapter.exists(hubFile);
    if (hubExists) {
      const hubContent = await this.app.vault.adapter.read(hubFile);
      // "## 최근 요약" 섹션 추출
      const summaryMatch = hubContent.match(/## 최근 요약[\s\S]*?(?=\n## |$)/);
      if (summaryMatch) previousSummary = summaryMatch[0];
    }

    // 4. 프롬프트 구성
    const projectName = project.split("/").pop() ?? project;
    const prompt = this.buildPrompt(projectName, since, until, previousSummary, logContents);

    // 5. claude -p 실행
    const result = await this.runClaude(prompt);

    // 6. 허브노트 갱신
    await this.updateHub(hubFile, projectName, result);

    return result;
  }

  /** 주간 요약 생성: 지난주 daily → _summaries/_weekly/ */
  async generateWeeklySummary(project: string): Promise<string> {
    const logWriter = new LogWriter(this.app, project, this.hostName);

    // 지난 주 범위 (월~일)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const lastMonday = new Date(now);
    lastMonday.setDate(now.getDate() - dayOfWeek - 6);
    lastMonday.setHours(0, 0, 0, 0);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    lastSunday.setHours(23, 59, 59, 999);

    const logPaths = await logWriter.collectAllLogs(lastMonday, lastSunday);
    if (logPaths.length === 0) {
      return `[weekly-summary] 지난주 로그 없음`;
    }

    const logContents: string[] = [];
    for (const p of logPaths) {
      try {
        logContents.push(await this.app.vault.adapter.read(p));
      } catch { /* skip */ }
    }

    const projectName = project.split("/").pop() ?? project;
    const prompt = [
      `프로젝트 "${projectName}" 주간 요약을 생성하세요.`,
      `기간: ${this.formatDate(lastMonday)} ~ ${this.formatDate(lastSunday)}`,
      "",
      "아래 로그를 분석하여:",
      "1. 주요 진행사항 (3~5줄)",
      "2. 완료된 작업 목록",
      "3. 미결 사항 (해결된 것 표시)",
      "4. 다음 주 우선순위 제안",
      "",
      "---",
      "",
      ...logContents,
    ].join("\n");

    const result = await this.runClaude(prompt);

    // 주간 번호 계산
    const weekNum = this.getISOWeek(lastMonday);
    const label = `${lastMonday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    const summaryPath = this.summaryPath(project, "weekly", label);

    // 디렉토리 확보 + 저장
    await this.ensureDir(summaryPath.substring(0, summaryPath.lastIndexOf("/")));
    const content = [
      "---",
      `type: weekly-summary`,
      `project: ${projectName}`,
      `period: ${this.formatDate(lastMonday)} ~ ${this.formatDate(lastSunday)}`,
      `generated: ${new Date().toISOString()}`,
      "---",
      "",
      result,
    ].join("\n");
    await this.app.vault.adapter.write(summaryPath, content);

    return result;
  }

  /** 월간 요약 생성: 지난달 weekly → _summaries/_monthly/ */
  async generateMonthlySummary(project: string): Promise<string> {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const label = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;

    // 지난달의 weekly summaries 수집
    const weeklyDir = `${project}/_logs/_summaries/_weekly`;
    const weeklySummaries: string[] = [];

    const dirExists = await this.app.vault.adapter.exists(weeklyDir);
    if (dirExists) {
      const listing = await this.app.vault.adapter.list(weeklyDir);
      for (const file of listing.files) {
        try {
          const content = await this.app.vault.adapter.read(file);
          // 지난달에 해당하는 주간 요약만 필터
          if (content.includes(`${lastMonth.getFullYear()}-`)) {
            weeklySummaries.push(content);
          }
        } catch { /* skip */ }
      }
    }

    // weekly가 없으면 daily 로그 직접 수집
    if (weeklySummaries.length === 0) {
      const logWriter = new LogWriter(this.app, project, this.hostName);
      const logPaths = await logWriter.collectAllLogs(lastMonth, lastMonthEnd);
      for (const p of logPaths) {
        try {
          weeklySummaries.push(await this.app.vault.adapter.read(p));
        } catch { /* skip */ }
      }
    }

    if (weeklySummaries.length === 0) {
      return `[monthly-summary] 지난달 데이터 없음`;
    }

    const projectName = project.split("/").pop() ?? project;
    const prompt = [
      `프로젝트 "${projectName}" 월간 요약을 생성하세요.`,
      `기간: ${label}`,
      "",
      "아래 주간 요약들을 종합하여:",
      "1. 월간 하이라이트 (3줄)",
      "2. 완료된 마일스톤",
      "3. 누적 미결 사항 (경과일수 포함)",
      "4. 다음 달 방향성",
      "",
      "---",
      "",
      ...weeklySummaries,
    ].join("\n");

    const result = await this.runClaude(prompt);

    const summaryPath = this.summaryPath(project, "monthly", label);
    await this.ensureDir(summaryPath.substring(0, summaryPath.lastIndexOf("/")));
    const content = [
      "---",
      `type: monthly-summary`,
      `project: ${projectName}`,
      `period: ${label}`,
      `generated: ${new Date().toISOString()}`,
      "---",
      "",
      result,
    ].join("\n");
    await this.app.vault.adapter.write(summaryPath, content);

    return result;
  }

  // ── 프롬프트 빌더 ──

  private buildPrompt(
    projectName: string,
    since: Date,
    until: Date,
    previousSummary: string,
    logContents: string[],
  ): string {
    const systemInstructions = `당신은 프로젝트 작업 로그를 분석하여 허브노트를 생성하는 큐레이터입니다.

## 절대 규칙
1. 원본 보존: 원본 로그는 수정하지 않는다. 허브는 "뷰"일 뿐이다.
2. 사실만 기록: "잘 진행되고 있다" 같은 해석 금지.
3. 각 문장에 출처 표시: (agent@host, session_id)
4. 3줄 이내로 전체 상황 요약
5. 미결 사항은 빠짐없이 수집

## 출력 형식

## 최근 요약 (YYYY-MM-DD 갱신)
{3줄 이내 요약}

## 활성 트리거
| 상태 | 내용 | 출처 | 최초 등록 | 경과 |
|------|------|------|----------|------|

## 이번 기간 작업 타임라인
- 🔵 MM-DD HH:MM | agent@host | 1줄 요약

에이전트 이모지: 🔵 claude-code, 🟢 codex, 🟡 claude-chat, 🔴 gpt, 🟣 gemini`;

    return [
      systemInstructions,
      "",
      "---",
      "",
      `## 허브노트 갱신 요청`,
      `**프로젝트**: ${projectName}`,
      `**기간**: ${this.formatDate(since)} ~ ${this.formatDate(until)}`,
      "",
      previousSummary
        ? `**이전 허브 요약**:\n${previousSummary}`
        : "**이전 허브 요약**: (없음 — 최초 생성)",
      "",
      "---",
      "",
      "## 신규 로그 데이터",
      "",
      ...logContents,
    ].join("\n");
  }

  // ── 허브노트 갱신 ──

  private async updateHub(hubPath: string, projectName: string, newContent: string): Promise<void> {
    const hubExists = await this.app.vault.adapter.exists(hubPath);

    if (!hubExists) {
      // 새 허브노트 생성
      const content = [
        "---",
        `created: ${this.formatDate(new Date())}`,
        `updated: ${this.formatDate(new Date())}`,
        `tags: [허브노트, ${projectName}]`,
        "---",
        "",
        `# 허브: ${projectName}`,
        "",
        newContent,
      ].join("\n");

      // 디렉토리 확보
      await this.ensureDir(hubPath.substring(0, hubPath.lastIndexOf("/")));
      await this.app.vault.adapter.write(hubPath, content);
      return;
    }

    // 기존 허브노트 갱신: "## 최근 요약" 이후를 교체
    let existing = await this.app.vault.adapter.read(hubPath);

    // updated 날짜 갱신
    existing = existing.replace(/updated: \d{4}-\d{2}-\d{2}/, `updated: ${this.formatDate(new Date())}`);

    // "## 최근 요약" 이후 교체
    const summaryIdx = existing.indexOf("## 최근 요약");
    if (summaryIdx >= 0) {
      existing = existing.substring(0, summaryIdx) + newContent;
    } else {
      existing += "\n\n" + newContent;
    }

    await this.app.vault.adapter.write(hubPath, existing);
  }

  // ── claude -p 실행 ──

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

      child.on("error", () =>
        reject(new Error("claude CLI를 찾을 수 없습니다"))
      );
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      // 10분 타임아웃
      setTimeout(() => {
        child.kill();
        reject(new Error("hub generation timed out (10min)"));
      }, 600_000);
    });
  }

  // ── Utility ──

  private getDateRange(depth: HubDepth): { since: Date; until: Date } {
    const now = new Date();
    const until = new Date(now);
    until.setHours(23, 59, 59, 999);

    let since: Date;
    switch (depth) {
      case "daily":
        since = new Date(now);
        since.setDate(now.getDate() - 3);
        since.setHours(0, 0, 0, 0);
        break;
      case "weekly":
        since = new Date(now);
        since.setDate(now.getDate() - 7);
        since.setHours(0, 0, 0, 0);
        break;
      case "full":
        since = new Date(now);
        since.setDate(now.getDate() - 31);
        since.setHours(0, 0, 0, 0);
        break;
    }

    return { since, until };
  }

  private getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    const parts = dirPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }
}
