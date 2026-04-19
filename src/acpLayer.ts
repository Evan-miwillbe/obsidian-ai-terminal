import { App, Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import { ContextPipeServer } from "./contextPipeServer";
import { Watchdog } from "./watchdog";

// ── ACP (Agent Communication Protocol) 层 ──
// 在 Named Pipe 服务器之上实现代理间通信。
// 作为编排器向多个代理(Claude Code, Codex, Gemini CLI)
// 委派任务并收集结果。
//
// 协议: JSON-RPC 2.0 over Named Pipe (contextPipeServer 扩展)
// 额外方法:
//   agent/list    — 已注册的代理列表
//   agent/invoke  — 向代理传递 prompt → 返回结果
//   agent/status  — 正在运行的代理状态
//   agent/cancel  — 取消正在运行的代理

// ── 代理定义 ──

export interface AgentDef {
  id: string;
  name: string;
  command: string;           // CLI 命令 (e.g., "claude", "codex", "gemini")
  args: string[];            // 默认参数 (e.g., ["-p"])
  available: boolean;        // 是否已安装
  description: string;
}

export interface AgentInvocation {
  id: string;
  agentId: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  process: ChildProcess | null;
}

// ── 默认代理列表 ──

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: ["-p"],
    available: false,
    description: "Anthropic Claude Code CLI — 代码生成、审查、重构",
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    args: ["--quiet", "--prompt"],
    available: false,
    description: "OpenAI Codex CLI — 代码生成、测试",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    command: "gemini",
    args: ["-p"],
    available: false,
    description: "Google Gemini CLI — 文档生成、分析",
  },
];

// ── ACP Layer ──

export class AcpLayer {
  private agents: AgentDef[];
  private invocations = new Map<string, AgentInvocation>();

  constructor(
    private app: App,
    private watchdog: Watchdog,
  ) {
    this.agents = DEFAULT_AGENTS.map((a) => ({ ...a }));
  }

  /** 确认代理 CLI 是否已安装 */
  async checkAvailability(): Promise<void> {
    for (const agent of this.agents) {
      agent.available = await this.isCommandAvailable(agent.command);
    }
  }

  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const which = process.platform === "win32" ? "where" : "which";
      const child = spawn(which, [command], { stdio: "pipe" });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
      // 5 秒超时
      setTimeout(() => { child.kill(); resolve(false); }, 5000);
    });
  }

  /** 已注册的代理列表 */
  getAgents(): AgentDef[] {
    return this.agents;
  }

  /** 向代理传递 prompt → 返回结果 */
  async invoke(agentId: string, prompt: string, cwd?: string): Promise<AgentInvocation> {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`代理不存在: ${agentId}`);
    if (!agent.available) throw new Error(`${agent.name} 尚未安装`);

    const invocationId = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const vaultPath = (this.app.vault.adapter as any).basePath as string;

    const invocation: AgentInvocation = {
      id: invocationId,
      agentId,
      prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
      process: null,
    };

    this.invocations.set(invocationId, invocation);

    // 上下文前缀: 当前仓库状态摘要
    const context = this.watchdog.currentIndex;
    const contextPrefix = context.activeNote
      ? `[当前笔记: ${context.activeNote.basename}] `
      : "";

    const fullPrompt = contextPrefix + prompt;

    return new Promise((resolve) => {
      const child = spawn(agent.command, [...agent.args, fullPrompt], {
        cwd: cwd || vaultPath,
        env: {
          ...process.env,
          OBSIDIAN_CONTEXT_PIPE: process.platform === "win32"
            ? "\\\\.\\pipe\\obsidian-ai-terminal"
            : "/tmp/obsidian-ai-terminal.sock",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      invocation.process = child;

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      child.on("error", (err) => {
        invocation.status = "failed";
        invocation.error = err.message;
        invocation.completedAt = new Date().toISOString();
        invocation.process = null;
        resolve(invocation);
      });

      child.on("close", (code) => {
        invocation.process = null;
        invocation.completedAt = new Date().toISOString();

        if (invocation.status === "cancelled") {
          resolve(invocation);
          return;
        }

        if (code === 0) {
          invocation.status = "completed";
          invocation.result = stdout.trim();
        } else {
          invocation.status = "failed";
          invocation.error = stderr.trim() || `exit code ${code}`;
        }
        resolve(invocation);
      });

      // 10 分钟超时
      setTimeout(() => {
        if (invocation.status === "running") {
          child.kill();
          invocation.status = "failed";
          invocation.error = "timeout (10min)";
          invocation.completedAt = new Date().toISOString();
          invocation.process = null;
          resolve(invocation);
        }
      }, 600_000);
    });
  }

  /** 并行代理调用 — 将相同 prompt 同时传递给多个代理 */
  async invokeParallel(
    agentIds: string[],
    prompt: string,
    cwd?: string,
  ): Promise<AgentInvocation[]> {
    const promises = agentIds.map((id) => this.invoke(id, prompt, cwd));
    return Promise.all(promises);
  }

  /** 获取正在运行的调用状态 */
  getInvocation(invocationId: string): AgentInvocation | null {
    return this.invocations.get(invocationId) ?? null;
  }

  /** 取消正在运行的调用 */
  cancel(invocationId: string): boolean {
    const inv = this.invocations.get(invocationId);
    if (!inv || inv.status !== "running") return false;

    inv.status = "cancelled";
    inv.completedAt = new Date().toISOString();
    if (inv.process && !inv.process.killed) {
      inv.process.kill();
    }
    inv.process = null;
    return true;
  }

  /** 所有调用历史记录 */
  getAllInvocations(): AgentInvocation[] {
    return [...this.invocations.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  /** 清理已完成的调用 (内存管理) */
  pruneCompleted(): number {
    let pruned = 0;
    for (const [id, inv] of this.invocations) {
      if (inv.status !== "running") {
        this.invocations.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
