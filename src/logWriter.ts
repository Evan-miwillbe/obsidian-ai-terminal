import { App } from "obsidian";
import * as os from "os";

// ── 日志条目 Schema ──

export interface LogEntry {
  sessionId: string;
  timestamp: string; // ISO 8601
  workItems: string[];
  changedFiles?: { path: string; action: string; summary: string }[];
  openItems?: string[];
  tags?: string[];
}

// ── LogWriter: _logs/{host}/{agent}/{date}.md append-only ──

export class LogWriter {
  private hostName: string;

  constructor(
    private app: App,
    private projectPath: string, // Vault 内项目路径 (e.g., "10_Project/하네스팩토리")
    hostName?: string,
  ) {
    this.hostName = hostName || os.hostname();
  }

  /** 今日日期的日志文件路径 */
  private logPath(agent: string, date?: Date): string {
    const d = date ?? new Date();
    const dateStr = this.formatDate(d);
    return `${this.projectPath}/_logs/${this.hostName}/${agent}/${dateStr}.md`;
  }

  /** 追加日志条目 (append-only) */
  async append(agent: string, entry: LogEntry): Promise<string> {
    const logPath = this.logPath(agent);

    // 确保目录存在
    const dir = logPath.substring(0, logPath.lastIndexOf("/"));
    await this.ensureDir(dir);

    // 读取已有内容
    let content = "";
    let entryCount = 0;
    const exists = await this.app.vault.adapter.exists(logPath);

    if (exists) {
      content = await this.app.vault.adapter.read(logPath);
      // 统计已有条目数
      const matches = content.match(/^## #\d+/gm);
      entryCount = matches ? matches.length : 0;
    } else {
      // 新文件: 生成 frontmatter
      const date = new Date();
      content = [
        "---",
        `agent: ${agent}`,
        `host: ${this.hostName}`,
        `date: ${this.formatDate(date)}`,
        `repo: ${this.projectPath.split("/").pop() ?? "unknown"}`,
        `entry_count: 0`,
        "---",
        "",
      ].join("\n");
    }

    entryCount++;
    const time = new Date(entry.timestamp).toTimeString().slice(0, 5);

    // 条目格式
    const section: string[] = [
      `## #${entryCount} | ${entry.sessionId} | ${time}`,
      "",
      "### 工作记录",
    ];

    for (const item of entry.workItems) {
      section.push(`- ${item}`);
    }

    if (entry.changedFiles && entry.changedFiles.length > 0) {
      section.push("");
      section.push("### 变更文件");
      for (const f of entry.changedFiles) {
        section.push(`- \`${f.path}\` [${f.action}] — ${f.summary}`);
      }
    }

    if (entry.openItems && entry.openItems.length > 0) {
      section.push("");
      section.push("### 待办事项");
      for (const item of entry.openItems) {
        section.push(`- [ ] ${item}`);
      }
    }

    if (entry.tags && entry.tags.length > 0) {
      section.push("");
      section.push(`\`tags: ${entry.tags.join(", ")}\``);
    }

    section.push("");
    section.push("---");
    section.push("");

    // 更新 entry_count
    content = content.replace(/entry_count: \d+/, `entry_count: ${entryCount}`);

    // append
    content += section.join("\n");
    await this.app.vault.adapter.write(logPath, content);

    return logPath;
  }

  /** 返回指定时间段的日志文件列表 */
  async listLogs(agent: string, since: Date, until: Date): Promise<string[]> {
    const logDir = `${this.projectPath}/_logs/${this.hostName}/${agent}`;
    const paths: string[] = [];

    const dirExists = await this.app.vault.adapter.exists(logDir);
    if (!dirExists) return paths;

    const listing = await this.app.vault.adapter.list(logDir);
    for (const file of listing.files) {
      const match = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) continue;
      const fileDate = new Date(match[1]);
      if (fileDate >= since && fileDate <= until) {
        paths.push(file);
      }
    }

    return paths.sort();
  }

  /** 收集所有 host/agent 的日志 */
  async collectAllLogs(since: Date, until: Date): Promise<string[]> {
    const logsDir = `${this.projectPath}/_logs`;
    const allPaths: string[] = [];

    const logsExists = await this.app.vault.adapter.exists(logsDir);
    if (!logsExists) return allPaths;

    // 遍历 _logs/{host}/
    const hostListing = await this.app.vault.adapter.list(logsDir);
    for (const hostDir of hostListing.folders) {
      if (hostDir.endsWith("/_summaries")) continue;

      // 遍历 _logs/{host}/{agent}/
      const agentListing = await this.app.vault.adapter.list(hostDir);
      for (const agentDir of agentListing.folders) {
        const fileListing = await this.app.vault.adapter.list(agentDir);
        for (const file of fileListing.files) {
          const match = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
          if (!match) continue;
          const fileDate = new Date(match[1]);
          if (fileDate >= since && fileDate <= until) {
            allPaths.push(file);
          }
        }
      }
    }

    return allPaths.sort();
  }

  // ── Utility ──

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
