import { App, Notice } from "obsidian";
import { spawn } from "child_process";
import { LogWriter } from "./logWriter";

// ── Hub 生成引擎 ──
// cron 触发 → 日志收集 → 去重预处理 → claude -p 摘要 → Hub 笔记更新

export type HubDepth = "daily" | "weekly" | "full";

export interface HubGenerateInput {
  project: string;     // vault 内项目路径（e.g., "10_Project/하네스팩토리"）
  depth: HubDepth;
}

export class HubGenerator {
  constructor(
    private app: App,
    private hostName: string,
  ) {}

  /** Hub 笔记路径 */
  private hubPath(project: string): string {
    const projectName = project.split("/").pop() ?? project;
    return `${project}/허브_${projectName}.md`;
  }

  /** 摘要保存路径 */
  private summaryPath(project: string, type: "weekly" | "monthly", label: string): string {
    return `${project}/_logs/_summaries/_${type}/${label}.md`;
  }

  // ── 主生成流程 ──

  async generate(input: HubGenerateInput): Promise<string> {
    const { project, depth } = input;

    // 1. 日志收集
    const logWriter = new LogWriter(this.app, project, this.hostName);
    const { since, until } = this.getDateRange(depth);
    const logPaths = await logWriter.collectAllLogs(since, until);

    if (logPaths.length === 0) {
      return `[hub-generate] 无日志 (${project}, ${this.formatDate(since)} ~ ${this.formatDate(until)})`;
    }

    // 2. 日志内容收集
    const logContents: string[] = [];
    for (const p of logPaths) {
      try {
        const content = await this.app.vault.adapter.read(p);
        logContents.push(content);
      } catch { /* skip unreadable */ }
    }

    // 3. 读取之前的 Hub 摘要
    const hubFile = this.hubPath(project);
    let previousSummary = "";
    const hubExists = await this.app.vault.adapter.exists(hubFile);
    if (hubExists) {
      const hubContent = await this.app.vault.adapter.read(hubFile);
      // 提取 "## 最近摘要" 区段
      const summaryMatch = hubContent.match(/## 最近摘要[\s\S]*?(?=\n## |$)/);
      if (summaryMatch) previousSummary = summaryMatch[0];
    }

    // 4. 构造 prompt
    const projectName = project.split("/").pop() ?? project;
    const prompt = this.buildPrompt(projectName, since, until, previousSummary, logContents);

    // 5. 执行 claude -p
    const result = await this.runClaude(prompt);

    // 6. 更新 Hub 笔记
    await this.updateHub(hubFile, projectName, result);

    return result;
  }

  /** 生成周摘要: 上周的 daily → _summaries/_weekly/ */
  async generateWeeklySummary(project: string): Promise<string> {
    const logWriter = new LogWriter(this.app, project, this.hostName);

    // 上周范围（周一~周日）
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
      return `[weekly-summary] 上周无日志`;
    }

    const logContents: string[] = [];
    for (const p of logPaths) {
      try {
        logContents.push(await this.app.vault.adapter.read(p));
      } catch { /* skip */ }
    }

    const projectName = project.split("/").pop() ?? project;
    const prompt = [
      `请生成项目 "${projectName}" 的周摘要。`,
      `时间范围: ${this.formatDate(lastMonday)} ~ ${this.formatDate(lastSunday)}`,
      "",
      "分析以下日志后输出:",
      "1. 主要进展（3~5行）",
      "2. 已完成的工作列表",
      "3. 未决事项（标注已解决的）",
      "4. 下周优先级建议",
      "",
      "---",
      "",
      ...logContents,
    ].join("\n");

    const result = await this.runClaude(prompt);

    // 计算周号
    const weekNum = this.getISOWeek(lastMonday);
    const label = `${lastMonday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    const summaryPath = this.summaryPath(project, "weekly", label);

    // 确保目录存在 + 保存
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

  /** 生成月摘要: 上月的 weekly → _summaries/_monthly/ */
  async generateMonthlySummary(project: string): Promise<string> {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const label = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;

    // 收集上月的 weekly summaries
    const weeklyDir = `${project}/_logs/_summaries/_weekly`;
    const weeklySummaries: string[] = [];

    const dirExists = await this.app.vault.adapter.exists(weeklyDir);
    if (dirExists) {
      const listing = await this.app.vault.adapter.list(weeklyDir);
      for (const file of listing.files) {
        try {
          const content = await this.app.vault.adapter.read(file);
          // 仅筛选属于上月的周摘要
          if (content.includes(`${lastMonth.getFullYear()}-`)) {
            weeklySummaries.push(content);
          }
        } catch { /* skip */ }
      }
    }

    // 若无 weekly 则直接收集 daily 日志
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
      return `[monthly-summary] 上月无数据`;
    }

    const projectName = project.split("/").pop() ?? project;
    const prompt = [
      `请生成项目 "${projectName}" 的月摘要。`,
      `时间范围: ${label}`,
      "",
      "综合以下周摘要后输出:",
      "1. 月度亮点（3行）",
      "2. 已完成的里程碑",
      "3. 累计未决事项（含经过天数）",
      "4. 下月方向",
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

  // ── Prompt 构建器 ──

  private buildPrompt(
    projectName: string,
    since: Date,
    until: Date,
    previousSummary: string,
    logContents: string[],
  ): string {
    const systemInstructions = `你是一个分析项目工作日志并生成 Hub 笔记的策展人。

## 绝对规则
1. 原文保留: 不修改原始日志。Hub 只是"视图"。
2. 仅记录事实: 禁止"进展顺利"等主观解读。
3. 每条语句标注来源: (agent@host, session_id)
4. 3行以内概括整体状况
5. 未决事项须全部收集

## 输出格式

## 最近摘要 (YYYY-MM-DD 更新)
{3行以内的摘要}

## 活跃触发器
| 状态 | 内容 | 来源 | 首次注册 | 经过时间 |
|------|------|------|----------|------|

## 本期工作 Timeline
- 🔵 MM-DD HH:MM | agent@host | 1行摘要

Agent 图标: 🔵 claude-code, 🟢 codex, 🟡 claude-chat, 🔴 gpt, 🟣 gemini`;

    return [
      systemInstructions,
      "",
      "---",
      "",
      `## Hub 笔记更新请求`,
      `**项目**: ${projectName}`,
      `**时间范围**: ${this.formatDate(since)} ~ ${this.formatDate(until)}`,
      "",
      previousSummary
        ? `**之前的 Hub 摘要**:\n${previousSummary}`
        : "**之前的 Hub 摘要**: （无 — 首次生成）",
      "",
      "---",
      "",
      "## 新增日志数据",
      "",
      ...logContents,
    ].join("\n");
  }

  // ── Hub 笔记更新 ──

  private async updateHub(hubPath: string, projectName: string, newContent: string): Promise<void> {
    const hubExists = await this.app.vault.adapter.exists(hubPath);

    if (!hubExists) {
      // 创建新 Hub 笔记
      const content = [
        "---",
        `created: ${this.formatDate(new Date())}`,
        `updated: ${this.formatDate(new Date())}`,
        `tags: [Hub笔记, ${projectName}]`,
        "---",
        "",
        `# Hub: ${projectName}`,
        "",
        newContent,
      ].join("\n");

      // 确保目录存在
      await this.ensureDir(hubPath.substring(0, hubPath.lastIndexOf("/")));
      await this.app.vault.adapter.write(hubPath, content);
      return;
    }

    // 更新已有 Hub 笔记: 替换 "## 最近摘要" 之后的内容
    let existing = await this.app.vault.adapter.read(hubPath);

    // 更新 updated 日期
    existing = existing.replace(/updated: \d{4}-\d{2}-\d{2}/, `updated: ${this.formatDate(new Date())}`);

    // 替换 "## 最近摘要" 之后的内容
    const summaryIdx = existing.indexOf("## 最近摘要");
    if (summaryIdx >= 0) {
      existing = existing.substring(0, summaryIdx) + newContent;
    } else {
      existing += "\n\n" + newContent;
    }

    await this.app.vault.adapter.write(hubPath, existing);
  }

  // ── 执行 claude -p ──

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
        reject(new Error("找不到 claude CLI"))
      );
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      // 10分钟超时
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
