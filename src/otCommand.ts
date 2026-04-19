import { App, Modal, Notice, Setting } from "obsidian";
import { Scheduler, type ScheduleEntry, type ScheduleAction } from "./scheduler";
import { spawn } from "child_process";

// ── /ot 模态框: 自然语言 → cron 计划注册 ──

interface ParsedSchedule {
  name: string;
  cron: string;
  action: ScheduleAction;
  prompt: string; // claude-prompt 动作时使用
  output: "daily-note" | "notice" | "none";
}

/** 通过 claude -p 将自然语言解析为结构化计划 */
function parseWithClaude(input: string, vaultPath: string): Promise<ParsedSchedule> {
  const systemPrompt = `你是一个将自然语言计划请求转换为 JSON 的解析器。

输入: 用户的自然语言计划请求
输出: 仅输出以下 JSON (无 markdown 代码块, 纯 JSON)

{
  "name": "计划名称 (中文, 简洁)",
  "cron": "分 时 日 月 星期",
  "action": "claude-prompt",
  "prompt": "传递给 claude -p 的 prompt (中文, 具体明确)",
  "output": "daily-note"
}

规则:
- cron 为 5 个字段 (分 时 日 月 星期)
- "每天早上 7 点" → "0 7 * * *"
- "工作日早上 9 点" → "0 9 * * 1-5"
- "每周一 8 点" → "0 8 * * 1"
- "每月 1 号 7 点" → "0 7 1 * *"
- action 始终为 "claude-prompt" (其他动作由用户自行设置)
- output 默认为 "daily-note"
- prompt 应将用户请求转换为具体的 AI 指令
- 仅输出 JSON, 无解释文本。`;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", `${systemPrompt}\n\n用户输入: ${input}`], {
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
      reject(new Error("找不到 claude CLI, 请确认已安装 Claude Code。"))
    );

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }

      try {
        // 提取 JSON (可能包含 markdown 代码块)
        let jsonStr = stdout.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];

        const parsed = JSON.parse(jsonStr) as ParsedSchedule;

        // 必填字段验证
        if (!parsed.name || !parsed.cron || !parsed.prompt) {
          reject(new Error("解析结果中缺少必填字段"));
          return;
        }

        parsed.action = parsed.action || "claude-prompt";
        parsed.output = parsed.output || "daily-note";
        resolve(parsed);
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${stdout.trim().slice(0, 200)}`));
      }
    });

    // 30 秒超时
    setTimeout(() => {
      child.kill();
      reject(new Error("claude -p 解析超时 (30秒)"));
    }, 30_000);
  });
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `ot-${ts}-${rand}`;
}

// ── OT 模态框 ──

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

    contentEl.createEl("h2", { text: "注册计划 (/ot)" });
    contentEl.createEl("p", {
      text: "用自然语言描述计划, AI 将自动转换为 cron 表达式并注册。",
      cls: "setting-item-description",
    });

    // 输入区域
    const inputContainer = contentEl.createDiv({ cls: "ot-input-container" });
    this.inputEl = inputContainer.createEl("textarea", {
      cls: "ot-input",
      attr: {
        placeholder: "例如: 每天早上 7 点总结昨天修改的笔记\n例如: 工作日 9 点进行项目进度简报\n例如: 每周一整理上周工作",
        rows: "4",
      },
    });
    this.inputEl.style.width = "100%";
    this.inputEl.style.resize = "vertical";
    this.inputEl.style.fontFamily = "inherit";
    this.inputEl.style.fontSize = "14px";
    this.inputEl.style.padding = "8px";

    // 示例按钮
    const examples = contentEl.createDiv({ cls: "ot-examples" });
    examples.style.marginBottom = "12px";
    examples.style.display = "flex";
    examples.style.gap = "6px";
    examples.style.flexWrap = "wrap";

    const exampleTexts = [
      "每天早上 8 点总结昨天修改的笔记",
      "工作日 9 点进行项目简报",
      "每周一 7 点整理上周工作",
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

    // 结果预览区域
    const previewEl = contentEl.createDiv({ cls: "ot-preview" });
    previewEl.style.display = "none";

    // 状态显示
    const statusEl = contentEl.createDiv({ cls: "ot-status" });
    statusEl.style.marginTop = "8px";
    statusEl.style.fontSize = "12px";
    statusEl.style.color = "var(--text-muted)";

    // 按钮区域
    const buttonContainer = contentEl.createDiv({ cls: "ot-buttons" });
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.marginTop = "16px";

    // 解析按钮
    const parseBtn = buttonContainer.createEl("button", {
      text: "解析",
      cls: "mod-cta",
    });

    // 注册按钮 (解析后显示)
    const registerBtn = buttonContainer.createEl("button", {
      text: "注册",
      cls: "mod-cta",
    });
    registerBtn.style.display = "none";

    // 立即测试按钮
    const testBtn = buttonContainer.createEl("button", { text: "测试运行" });
    testBtn.style.display = "none";

    let parsed: ParsedSchedule | null = null;

    parseBtn.addEventListener("click", async () => {
      const input = this.inputEl?.value.trim();
      if (!input) {
        new Notice("请输入计划内容");
        return;
      }

      statusEl.textContent = "AI 正在解析...";
      statusEl.style.color = "var(--text-accent)";
      parseBtn.disabled = true;

      try {
        parsed = await parseWithClaude(input, this.vaultPath);

        // 显示预览
        previewEl.style.display = "block";
        previewEl.empty();
        previewEl.createEl("h4", { text: "解析结果" });

        const table = previewEl.createEl("table");
        table.style.width = "100%";
        table.style.fontSize = "13px";

        const rows: [string, string][] = [
          ["名称", parsed.name],
          ["Cron", `${parsed.cron} (${describeCron(parsed.cron)})`],
          ["动作", parsed.action],
          ["输出", parsed.output],
          ["Prompt", parsed.prompt.slice(0, 100) + (parsed.prompt.length > 100 ? "..." : "")],
        ];

        for (const [label, value] of rows) {
          const tr = table.createEl("tr");
          const td1 = tr.createEl("td", { text: label });
          td1.style.fontWeight = "bold";
          td1.style.padding = "4px 8px";
          td1.style.whiteSpace = "nowrap";
          tr.createEl("td", { text: value }).style.padding = "4px 8px";
        }

        statusEl.textContent = "解析完成, 确认后点击注册。";
        statusEl.style.color = "var(--text-success)";

        registerBtn.style.display = "inline-block";
        testBtn.style.display = "inline-block";
      } catch (err: any) {
        statusEl.textContent = `解析失败: ${err.message}`;
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

      new Notice(`计划注册成功: "${parsed.name}" [${parsed.cron}]`);
      this.close();
    });

    testBtn.addEventListener("click", async () => {
      if (!parsed) return;

      statusEl.textContent = "正在测试运行...";
      statusEl.style.color = "var(--text-accent)";
      testBtn.setAttribute("disabled", "true");

      try {
        // 使用临时条目立即执行
        const tempEntry: ScheduleEntry = {
          id: `test-${Date.now()}`,
          name: parsed.name,
          cron: parsed.cron,
          output: "notice", // 测试使用 notice 输出
          enabled: true,
          lastRun: null,
          createdAt: new Date().toISOString(),
          source: "ot",
          action: parsed.action,
        };

        // 临时保存测试用 prompt
        if (parsed.action === "claude-prompt") {
          await this.scheduler.ensureSchedulesDir();
          const promptPath = `.obsidian/plugins/obsidian-ai-terminal/schedules/${tempEntry.id}.md`;
          await this.app.vault.adapter.write(promptPath, parsed.prompt);

          const result = await this.scheduler.execute(tempEntry);

          // 清理临时文件
          await this.app.vault.adapter.remove(promptPath);

          statusEl.textContent = `测试完成: ${result.slice(0, 100)}`;
          statusEl.style.color = "var(--text-success)";
        } else {
          const result = await this.scheduler.execute(tempEntry);
          statusEl.textContent = `测试完成: ${result}`;
          statusEl.style.color = "var(--text-success)";
        }
      } catch (err: any) {
        statusEl.textContent = `测试失败: ${err.message}`;
        statusEl.style.color = "var(--text-error)";
      } finally {
        testBtn.removeAttribute("disabled");
      }
    });

    // Enter 触发解析 (Shift+Enter 换行)
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        parseBtn.click();
      }
    });

    // 聚焦
    setTimeout(() => this.inputEl?.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 将 cron 表达式转换为人类可读的中文描述 */
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dom, month, dow] = parts;

  const dowNames: Record<string, string> = {
    "0": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六",
    "1-5": "工作日", "0,6": "周末",
  };

  let desc = "";

  // 星期
  if (dow === "*") {
    if (dom === "*" && month === "*") {
      desc = "每天";
    } else if (dom !== "*" && month === "*") {
      desc = `每月 ${dom} 日`;
    }
  } else if (dowNames[dow]) {
    desc = `每周${dowNames[dow]}`;
  } else {
    desc = `星期(${dow})`;
  }

  // 时间
  if (hour !== "*" && minute !== "*") {
    desc += ` ${hour}点 ${minute === "0" ? "" : minute + "分"}`.trimEnd();
  }

  return desc || cron;
}
