import { spawn, ChildProcess, execFileSync } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

function findPython(): string {
  if (isWindows) return "python3"; // Windows上不使用
  // 优先尝试 python3，回退到 python（部分 Linux 发行版）
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return "python3";
  } catch {
    return "python";
  }
}

export class PtyProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _cols: number = 80;
  private _rows: number = 24;

  constructor(
    private shell: string,
    private cwd: string,
    private pluginDir: string,
    private env: Record<string, string> = {}
  ) {
    super();
  }

  start(): void {
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...this.env,
    };

    if (!isWindows) {
      // 若已有 LANG 则保留，否则设置 UTF-8（部分 Linux 发行版未安装 en_US.UTF-8）
      if (!mergedEnv.LANG) {
        mergedEnv.LANG = "C.UTF-8";
      }
    }

    const args = [
      String(this._cols),
      String(this._rows),
      this.cwd,
      this.shell,
    ];

    if (isWindows) {
      // Windows: ConPTY 桥接二进制
      const bridgePath = path.join(this.pluginDir, "conpty-bridge.exe");
      this.process = spawn(bridgePath, args, {
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // macOS/Linux: Python PTY 辅助程序
      const helperPath = path.join(this.pluginDir, "pty-helper.py");
      const pythonCmd = findPython();
      this.process = spawn(pythonCmd, [helperPath, ...args], {
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    this.process.stdout?.on("data", (data: Buffer) => {
      this.emit("data", data.toString("utf-8"));
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.emit("data", data.toString("utf-8"));
    });

    this.process.on("exit", (code: number | null) => {
      this.emit("exit", code);
      this.process = null;
    });

    this.process.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  write(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(`\x1b]resize;${cols};${rows}\x07`);
    }
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  kill(): void {
    if (this.process) {
      this.write("exit\n");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill();
        }
      }, 500);
    }
  }

  destroy(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
