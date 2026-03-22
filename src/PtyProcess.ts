import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

export class PtyProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _cols: number = 80;
  private _rows: number = 24;

  constructor(
    private shell: string,
    private cwd: string,
    private env: Record<string, string> = {}
  ) {
    super();
  }

  start(): void {
    const mergedEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      COLUMNS: String(this._cols),
      LINES: String(this._rows),
      ...this.env,
    };

    // macOS: script -q /dev/null <shell> 로 PTY 할당
    this.process = spawn("script", ["-q", "/dev/null", this.shell], {
      cwd: this.cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

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

    // 초기 stty 설정으로 터미널 크기 지정
    this.resize(this._cols, this._rows);
  }

  write(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    if (this.process?.pid) {
      // script로 생성된 PTY의 크기를 stty로 변경
      // 자식 프로세스의 tty에 직접 stty 명령 전달
      this.write(`stty cols ${cols} rows ${rows} 2>/dev/null\n`);
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
