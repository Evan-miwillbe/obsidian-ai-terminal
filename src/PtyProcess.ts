import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

export class PtyProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _cols: number = 80;
  private _rows: number = 24;
  private helperPath: string;

  constructor(
    private shell: string,
    private cwd: string,
    private pluginDir: string,
    private env: Record<string, string> = {}
  ) {
    super();
    this.helperPath = path.join(pluginDir, "pty-helper.py");
  }

  start(): void {
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      ...this.env,
    };

    // Python3 pty 헬퍼로 진짜 PTY 할당
    this.process = spawn(
      "python3",
      [
        this.helperPath,
        String(this._cols),
        String(this._rows),
        this.cwd,
        this.shell,
      ],
      {
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

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
      // 커스텀 이스케이프 시퀀스로 resize 신호 전달
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
          this.process.kill("SIGTERM");
        }
      }, 500);
    }
  }

  destroy(): void {
    if (this.process) {
      this.process.kill("SIGKILL");
      this.process = null;
    }
  }
}
