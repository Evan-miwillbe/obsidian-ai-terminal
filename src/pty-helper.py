#!/usr/bin/env python3
"""PTY helper for obsidian-ai-terminal.
Allocates a real PTY and relays I/O between stdin/stdout pipes and the PTY.
Usage: python3 pty-helper.py <cols> <rows> <cwd> <shell> [args...]
"""
import sys, os, pty, select, signal, struct, fcntl, termios, tty

def set_winsize(fd, cols, rows):
    s = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, s)

def main():
    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    cwd = sys.argv[3]
    shell = sys.argv[4]
    args = sys.argv[4:]

    os.chdir(cwd)

    # PTY 생성
    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, cols, rows)

    pid = os.fork()
    if pid == 0:
        # 자식: slave PTY를 stdin/stdout/stderr로
        os.close(master_fd)
        if hasattr(os, 'login_tty'):
            # Python 3.12+: setsid + TIOCSCTTY + dup2 + close 한번에 처리
            os.login_tty(slave_fd)
        else:
            os.setsid()
            try:
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except OSError:
                # WSL 등 일부 환경에서 TIOCSCTTY 실패 시 ttyname으로 fallback
                slave_name = os.ttyname(slave_fd)
                os.close(slave_fd)
                slave_fd = os.open(slave_name, os.O_RDWR)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = "en_US.UTF-8"
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)

        # 로그인 셸로 실행하여 .zprofile/.zshrc 로드 (nvm, homebrew 등 PATH 설정)
        os.execvpe(shell, [shell, "-l"], env)

    # 부모: master PTY ↔ stdin/stdout 릴레이
    os.close(slave_fd)

    # stdin을 non-blocking으로
    import fcntl as fcntl2
    flags = fcntl2.fcntl(sys.stdin.fileno(), fcntl2.F_GETFL)
    fcntl2.fcntl(sys.stdin.fileno(), fcntl2.F_SETFL, flags | os.O_NONBLOCK)

    # SIGWINCH (resize) 처리 — stdin에서 ESC sequence로 수신
    # 형식: \x1b[8;<rows>;<cols>t
    buf = b""

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    try:
        while True:
            try:
                rlist, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)
            except (select.error, ValueError):
                break

            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 65536)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                except OSError:
                    break

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 65536)
                    if not data:
                        break

                    # resize 시퀀스 파싱: \x1b]resize;<cols>;<rows>\x07
                    i = 0
                    while i < len(data):
                        if data[i:i+8] == b'\x1b]resize':
                            end = data.find(b'\x07', i)
                            if end != -1:
                                params = data[i+8:end].decode().strip(';').split(';')
                                if len(params) == 2:
                                    new_cols = int(params[0])
                                    new_rows = int(params[1])
                                    set_winsize(master_fd, new_cols, new_rows)
                                    os.kill(pid, signal.SIGWINCH)
                                i = end + 1
                                continue
                        # 일반 데이터는 PTY로 전달
                        end = data.find(b'\x1b]resize', i + 1)
                        if end == -1:
                            os.write(master_fd, data[i:])
                            break
                        else:
                            os.write(master_fd, data[i:end])
                            i = end
                except OSError:
                    break
    finally:
        os.close(master_fd)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

if __name__ == "__main__":
    main()
