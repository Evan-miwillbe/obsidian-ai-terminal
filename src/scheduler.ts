import { App, Notice } from "obsidian";
import { spawn } from "child_process";
import * as path from "path";
import { HubGenerator, type HubDepth } from "./hubGenerator";

// ── 调度表模式定义 ──

export type ScheduleAction =
  | "claude-prompt"
  | "hub-generate"
  | "weekly-summary"
  | "monthly-summary";

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;          // "分 时 日 月 星期"（5字段）
  output: "daily-note" | "notice" | "none";
  enabled: boolean;
  lastRun: string | null; // ISO 8601
  createdAt: string;
  // prompt 单独保存在 schedules/{id}.md 文件中
  // ── 扩展字段 ──
  source?: "cli" | "mcp" | "ot";
  action?: ScheduleAction;
  actionInput?: Record<string, any>;
}

export interface ScheduleTable {
  version: number;
  schedules: ScheduleEntry[];
}

const EMPTY_TABLE: ScheduleTable = { version: 1, schedules: [] };

// ── Cron 解析器（无外部依赖） ──

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

/** 当前时刻（截断到分钟）是否匹配 cron 表达式 */
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

// ── Scheduler 主逻辑 ──

export class Scheduler {
  private table: ScheduleTable = EMPTY_TABLE;
  private intervalId: number | null = null;
  private running = new Set<string>(); // 防止重复执行
  hostName: string;

  constructor(
    private app: App,
    private pluginDir: string,
    private dailyNotePath: string, // e.g. "00_Area/01_时间轴/每日笔记"
    hostName?: string,
  ) {
    this.hostName = hostName || (typeof require !== "undefined" ? require("os").hostname() : "unknown");
  }

  get schedulesPath(): string {
    return path.join(this.pluginDir, "schedules.json");
  }

  // ── 表读写 ──

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

  /** 从 schedules/{id}.md 读取 prompt */
  async loadPrompt(id: string): Promise<string> {
    const promptPath = this.relPath(`schedules/${id}.md`);
    try {
      return await this.app.vault.adapter.read(promptPath);
    } catch {
      throw new Error(`Prompt file not found: schedules/${id}.md`);
    }
  }

  /** 初始化 schedules/ 目录并生成模板 */
  async ensureSchedulesDir(): Promise<void> {
    const dir = this.relPath("schedules");
    const exists = await this.app.vault.adapter.exists(dir);
    if (!exists) {
      await this.app.vault.adapter.mkdir(dir);
    }
    // 模板文件
    const tmplPath = this.relPath("schedules/_template.md");
    const tmplExists = await this.app.vault.adapter.exists(tmplPath);
    if (!tmplExists) {
      await this.app.vault.adapter.write(tmplPath, PROMPT_TEMPLATE);
    }
  }

  // ── CRUD ──

  async addEntry(entry: ScheduleEntry, promptContent?: string): Promise<void> {
    await this.load();
    // 相同 id 则覆盖
    const idx = this.table.schedules.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.table.schedules[idx] = entry;
    } else {
      this.table.schedules.push(entry);
    }
    await this.save();

    // 保存 prompt 文件（claude-prompt 操作时）
    if (promptContent) {
      await this.ensureSchedulesDir();
      const promptPath = this.relPath(`schedules/${entry.id}.md`);
      await this.app.vault.adapter.write(promptPath, promptContent);
    }
  }

  async removeEntry(idOrName: string): Promise<boolean> {
    await this.load();
    const idx = this.table.schedules.findIndex(
      (e) => e.id === idOrName || e.name === idOrName,
    );
    if (idx < 0) return false;

    const entry = this.table.schedules[idx];
    this.table.schedules.splice(idx, 1);
    await this.save();

    // 同时尝试删除 prompt 文件
    try {
      const promptPath = this.relPath(`schedules/${entry.id}.md`);
      if (await this.app.vault.adapter.exists(promptPath)) {
        await this.app.vault.adapter.remove(promptPath);
      }
    } catch { /* ignore */ }

    return true;
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

  // ── Tick: 每分钟 cron 匹配 ──

  private async tick(): Promise<void> {
    await this.load(); // 反映外部变更（Claude Code skill）

    const now = new Date();

    for (const entry of this.table.schedules) {
      if (!entry.enabled) continue;
      if (this.running.has(entry.id)) continue;

      // 防止同一分钟内重复执行
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

  // ── 执行 ──

  async execute(entry: ScheduleEntry, now?: Date): Promise<string> {
    const ts = now ?? new Date();
    this.running.add(entry.id);

    try {
      let result: string;

      switch (entry.action) {
        case "hub-generate": {
          const project = entry.actionInput?.project as string;
          const depth = (entry.actionInput?.depth as HubDepth) || "daily";
          if (!project) {
            result = `[hub-generate] 需要 actionInput.project`;
            break;
          }
          const hubGen = new HubGenerator(this.app, this.hostName);
          result = await hubGen.generate({ project, depth });
          break;
        }
        case "weekly-summary": {
          const project = entry.actionInput?.project as string;
          if (!project) {
            result = `[weekly-summary] 需要 actionInput.project`;
            break;
          }
          const hubGen = new HubGenerator(this.app, this.hostName);
          result = await hubGen.generateWeeklySummary(project);
          break;
        }
        case "monthly-summary": {
          const project = entry.actionInput?.project as string;
          if (!project) {
            result = `[monthly-summary] 需要 actionInput.project`;
            break;
          }
          const hubGen = new HubGenerator(this.app, this.hostName);
          result = await hubGen.generateMonthlySummary(project);
          break;
        }
        case "claude-prompt":
        default: {
          // 默认行为：加载 schedules/{id}.md prompt 后执行 claude -p
          const prompt = await this.loadPrompt(entry.id);
          result = await this.runClaude(prompt);
          break;
        }
      }

      // 更新 lastRun
      entry.lastRun = ts.toISOString();
      await this.save();

      // 输出结果
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

      // 10分钟超时
      setTimeout(() => {
        child.kill();
        reject(new Error("claude -p timed out (10min)"));
      }, 600_000);
    });
  }

  // ── 记录结果 ──

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
      // 若每日笔记不存在，则用最小 frontmatter 创建
      const header = [
        "---",
        `created: ${dateStr}`,
        `updated: ${dateStr}`,
        `tags: [每日笔记]`,
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

// ── Prompt 模板 ──

const PROMPT_TEMPLATE = `# Schedule Prompt Template
#
# 复制此文件并以调度 ID 同名保存。
# 例如：briefing-001.md
#
# 文件全部内容将作为 claude -p 的 prompt 传入。
# 可自由使用 Markdown 格式。

## Role
你是 Obsidian Vault 的 AI 助手。

## Task
<!-- 在此编写具体指令 -->

## Output Format
- 用中文回复
- Markdown 格式
- 简洁为主，聚焦核心内容

## Context
<!-- 按需补充上下文 -->
`;

