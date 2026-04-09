import * as net from "net";
import * as fs from "fs";
import { App, TFile } from "obsidian";
import { Watchdog, type ContextIndex } from "./watchdog";
import type { AcpLayer } from "./acpLayer";
import type { TerminalView } from "./TerminalView";

// ── Named Pipe / Unix Socket 서버 ──
// 터미널 세션 및 외부 에이전트가 연결하여 볼트 컨텍스트를 받아가는 서버
//
// 프로토콜: 줄 단위 JSON-RPC 2.0 (MCP 호환 형식)
// Windows: \\.\pipe\obsidian-ai-terminal
// Unix:    /tmp/obsidian-ai-terminal.sock

const isWindows = process.platform === "win32";

export function getPipePath(): string {
  return isWindows
    ? "\\\\.\\pipe\\obsidian-ai-terminal"
    : "/tmp/obsidian-ai-terminal.sock";
}

// ── JSON-RPC 요청/응답 ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

// ── ContextPipeServer ──

export class ContextPipeServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private unsubscribe: (() => void) | null = null;
  private acpLayer: AcpLayer | null = null;
  private app: App;
  private getTerminalView: (() => TerminalView | null) | null = null;

  constructor(private watchdog: Watchdog, app: App) {
    this.app = app;
  }

  /** ACP 레이어 연결 */
  setAcpLayer(acp: AcpLayer): void {
    this.acpLayer = acp;
  }

  /** 터미널 뷰 접근 콜백 설정 */
  setTerminalViewGetter(getter: () => TerminalView | null): void {
    this.getTerminalView = getter;
  }

  get pipePath(): string {
    return getPipePath();
  }

  /** 서버 시작 */
  start(): void {
    if (this.server) return;

    // Unix: 기존 소켓 파일 제거
    if (!isWindows) {
      try { fs.unlinkSync(this.pipePath); } catch { /* ignore */ }
    }

    this.server = net.createServer((socket) => {
      this.clients.add(socket);

      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString("utf-8");

        // 줄 단위로 파싱
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line) continue;
          try {
            const request = JSON.parse(line) as JsonRpcRequest;
            const response = this.handleRequest(request, socket);
            if (response) {
              socket.write(JSON.stringify(response) + "\n");
            }
          } catch {
            socket.write(JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            } as JsonRpcResponse) + "\n");
          }
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.pipePath, () => {
      // Named Pipe 서버 시작됨
    });

    this.server.on("error", (err) => {
      console.error("ContextPipeServer error:", err);
    });

    // watchdog 변경 시 구독 중인 클라이언트에 알림
    this.unsubscribe = this.watchdog.onIndexChange((index) => {
      this.broadcastNotification("vault/changed", {
        timestamp: index.timestamp,
        activeNote: index.activeNote?.path ?? null,
        recentCount: index.recentNotes.length,
      });
    });
  }

  /** 서버 정지 */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const client of this.clients) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Unix: 소켓 파일 정리
    if (!isWindows) {
      try { fs.unlinkSync(this.pipePath); } catch { /* ignore */ }
    }
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  // ── 요청 핸들러 ──

  private handleRequest(request: JsonRpcRequest, socket: net.Socket): JsonRpcResponse | null {
    const { method, id, params } = request;

    switch (method) {
      // 초기화
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              notifications: ["vault/changed"],
            },
            serverInfo: {
              name: "obsidian-ai-terminal-context",
              version: "0.1.0",
            },
          },
        };

      // 현재 컨텍스트 전체 가져오기
      case "context/get":
        return {
          jsonrpc: "2.0", id,
          result: this.watchdog.currentIndex,
        };

      // 활성 노트 컨텍스트만
      case "context/activeNote":
        return {
          jsonrpc: "2.0", id,
          result: this.watchdog.currentIndex.activeNote,
        };

      // 프로젝트 허브 목록
      case "context/hubs":
        return {
          jsonrpc: "2.0", id,
          result: this.watchdog.currentIndex.projectHubs,
        };

      // 최근 수정 노트
      case "context/recent":
        return {
          jsonrpc: "2.0", id,
          result: this.watchdog.currentIndex.recentNotes,
        };

      // 특정 노트 읽기
      case "vault/read": {
        const notePath = params?.path;
        if (!notePath) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "path 필수" } };
        }
        // 비동기 응답은 직접 socket에 씀
        this.handleVaultRead(id, notePath, socket);
        return null; // 비동기 처리
      }

      // 변경 알림 구독 (연결이 유지되는 동안 자동 알림)
      case "notifications/initialized":
        return null; // 알림은 응답 없음

      // ── Obsidian 제어 메서드 ──

      case "obsidian/openNote": {
        const notePath = params?.path;
        if (!notePath) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "path 필수" } };
        }
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!file || !(file instanceof TFile)) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: `파일 없음: ${notePath}` } };
        }
        this.app.workspace.getLeaf(false).openFile(file);
        return { jsonrpc: "2.0", id, result: { opened: notePath } };
      }

      case "obsidian/executeCommand": {
        const commandId = params?.id;
        if (!commandId) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "id 필수" } };
        }
        try {
          (this.app as any).commands.executeCommandById(commandId);
          return { jsonrpc: "2.0", id, result: { executed: commandId } };
        } catch (err: any) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: err.message } };
        }
      }

      case "obsidian/listCommands": {
        const commands = Object.keys((this.app as any).commands?.commands ?? {});
        return { jsonrpc: "2.0", id, result: { commands } };
      }

      case "vault/write": {
        const writePath = params?.path;
        const content = params?.content;
        if (!writePath || content === undefined) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "path, content 필수" } };
        }
        this.handleVaultWrite(id, writePath, content, socket);
        return null; // 비동기
      }

      case "terminal/sendKeys": {
        const keys = params?.keys;
        if (!keys) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "keys 필수" } };
        }
        const tv = this.getTerminalView?.();
        if (!tv) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "터미널 뷰가 열려있지 않음" } };
        }
        tv.sendKeys(keys);
        return { jsonrpc: "2.0", id, result: { sent: true, length: keys.length } };
      }

      case "terminal/output": {
        const text = params?.text;
        if (!text) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "text 필수" } };
        }
        const termView = this.getTerminalView?.();
        if (!termView) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "터미널 뷰가 열려있지 않음" } };
        }
        termView.writeOutput(text);
        return { jsonrpc: "2.0", id, result: { written: true } };
      }

      // ── ACP: 에이전트 관련 메서드 ──

      case "agent/list":
        if (!this.acpLayer) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "ACP not initialized" } };
        }
        return {
          jsonrpc: "2.0", id,
          result: this.acpLayer.getAgents().map((a) => ({
            id: a.id, name: a.name, available: a.available, description: a.description,
          })),
        };

      case "agent/invoke": {
        if (!this.acpLayer) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "ACP not initialized" } };
        }
        const { agentId, prompt, cwd } = params || {};
        if (!agentId || !prompt) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "agentId, prompt 필수" } };
        }
        // 비동기 처리
        this.handleAgentInvoke(id, agentId, prompt, cwd, socket);
        return null;
      }

      case "agent/status": {
        if (!this.acpLayer) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "ACP not initialized" } };
        }
        const invId = params?.invocationId;
        if (invId) {
          const inv = this.acpLayer.getInvocation(invId);
          return { jsonrpc: "2.0", id, result: inv ? { id: inv.id, status: inv.status, agentId: inv.agentId } : null };
        }
        return {
          jsonrpc: "2.0", id,
          result: this.acpLayer.getAllInvocations().map((inv) => ({
            id: inv.id, agentId: inv.agentId, status: inv.status, startedAt: inv.startedAt,
          })),
        };
      }

      case "agent/cancel": {
        if (!this.acpLayer) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "ACP not initialized" } };
        }
        const cancelId = params?.invocationId;
        if (!cancelId) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "invocationId 필수" } };
        }
        const cancelled = this.acpLayer.cancel(cancelId);
        return { jsonrpc: "2.0", id, result: { cancelled } };
      }

      // ping
      case "ping":
        return { jsonrpc: "2.0", id, result: { pong: true, timestamp: new Date().toISOString() } };

      default:
        return {
          jsonrpc: "2.0", id,
          error: { code: -32601, message: `Unknown method: ${method}` },
        };
    }
  }

  private async handleVaultRead(
    id: number | string | null,
    notePath: string,
    socket: net.Socket,
  ): Promise<void> {
    try {
      const app = this.watchdog["app"]; // Watchdog의 app 접근
      const content = await app.vault.adapter.read(notePath);
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        result: { path: notePath, content },
      };
      socket.write(JSON.stringify(response) + "\n");
    } catch (err: any) {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        error: { code: -32000, message: `읽기 실패: ${err.message}` },
      };
      socket.write(JSON.stringify(response) + "\n");
    }
  }

  private async handleVaultWrite(
    id: number | string | null,
    filePath: string,
    content: string,
    socket: net.Socket,
  ): Promise<void> {
    try {
      // 디렉토리 확보
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) {
        const dirExists = await this.app.vault.adapter.exists(dir);
        if (!dirExists) await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(filePath, content);
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        result: { written: filePath },
      };
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    } catch (err: any) {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        error: { code: -32000, message: err.message },
      };
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    }
  }

  private async handleAgentInvoke(
    id: number | string | null,
    agentId: string,
    prompt: string,
    cwd: string | undefined,
    socket: net.Socket,
  ): Promise<void> {
    try {
      const result = await this.acpLayer!.invoke(agentId, prompt, cwd);
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        result: {
          invocationId: result.id,
          agentId: result.agentId,
          status: result.status,
          result: result.result,
          error: result.error,
        },
      };
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    } catch (err: any) {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0", id,
        error: { code: -32000, message: err.message },
      };
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    }
  }

  // ── 브로드캐스트 ──

  private broadcastNotification(method: string, params: any): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n";

    for (const client of this.clients) {
      try {
        if (!client.destroyed) client.write(message);
      } catch { /* ignore dead sockets */ }
    }
  }
}
