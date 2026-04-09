import { App, Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import { ContextPipeServer } from "./contextPipeServer";
import { Watchdog } from "./watchdog";

// ── ACP (Agent Communication Protocol) 레이어 ──
// Named Pipe 서버 위에 에이전트 간 통신을 구현.
// 오케스트레이터로서 여러 에이전트(Claude Code, Codex, Gemini CLI)에게
// 작업을 위임하고 결과를 수집한다.
//
// 프로토콜: JSON-RPC 2.0 over Named Pipe (contextPipeServer 확장)
// 추가 메서드:
//   agent/list    — 등록된 에이전트 목록
//   agent/invoke  — 에이전트에 프롬프트 전달 → 결과 반환
//   agent/status  — 실행 중인 에이전트 상태
//   agent/cancel  — 실행 중인 에이전트 취소

// ── 에이전트 정의 ──

export interface AgentDef {
  id: string;
  name: string;
  command: string;           // CLI 명령어 (e.g., "claude", "codex", "gemini")
  args: string[];            // 기본 인자 (e.g., ["-p"])
  available: boolean;        // 설치 확인
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

// ── 기본 에이전트 목록 ──

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: ["-p"],
    available: false,
    description: "Anthropic Claude Code CLI — 코드 생성, 리뷰, 리팩토링",
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    args: ["--quiet", "--prompt"],
    available: false,
    description: "OpenAI Codex CLI — 코드 생성, 테스트",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    command: "gemini",
    args: ["-p"],
    available: false,
    description: "Google Gemini CLI — 문서 생성, 분석",
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

  /** 에이전트 CLI 설치 여부 확인 */
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
      // 5초 타임아웃
      setTimeout(() => { child.kill(); resolve(false); }, 5000);
    });
  }

  /** 등록된 에이전트 목록 */
  getAgents(): AgentDef[] {
    return this.agents;
  }

  /** 에이전트에 프롬프트 전달 → 결과 반환 */
  async invoke(agentId: string, prompt: string, cwd?: string): Promise<AgentInvocation> {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`에이전트 없음: ${agentId}`);
    if (!agent.available) throw new Error(`${agent.name}이 설치되어 있지 않습니다`);

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

    // 컨텍스트 프리픽스: 현재 볼트 상태 요약
    const context = this.watchdog.currentIndex;
    const contextPrefix = context.activeNote
      ? `[현재 노트: ${context.activeNote.basename}] `
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

      // 10분 타임아웃
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

  /** 병렬 에이전트 호출 — 같은 프롬프트를 여러 에이전트에 동시 전달 */
  async invokeParallel(
    agentIds: string[],
    prompt: string,
    cwd?: string,
  ): Promise<AgentInvocation[]> {
    const promises = agentIds.map((id) => this.invoke(id, prompt, cwd));
    return Promise.all(promises);
  }

  /** 실행 중인 호출 상태 */
  getInvocation(invocationId: string): AgentInvocation | null {
    return this.invocations.get(invocationId) ?? null;
  }

  /** 실행 중인 호출 취소 */
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

  /** 모든 호출 히스토리 */
  getAllInvocations(): AgentInvocation[] {
    return [...this.invocations.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  /** 완료된 호출 정리 (메모리 관리) */
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
