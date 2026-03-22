mod conpty;
mod pipe_relay;

use std::env;
use std::process;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{WaitForSingleObject, GetExitCodeProcess, INFINITE};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 5 {
        eprintln!("Usage: conpty-bridge <cols> <rows> <cwd> <shell>");
        process::exit(1);
    }

    let cols: i16 = args[1].parse().unwrap_or(80);
    let rows: i16 = args[2].parse().unwrap_or(24);
    let cwd = &args[3];
    let shell = &args[4];

    // 환경변수 설정
    let env_block = conpty::build_env_block(&[
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("COLUMNS", &cols.to_string()),
        ("LINES", &rows.to_string()),
    ]);

    // ConPTY 생성
    let pty = match conpty::ConPty::new(cols, rows) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to create ConPTY: {}", e);
            process::exit(1);
        }
    };

    // 셸 프로세스 spawn
    let (pi, job) = match pty.spawn(shell, cwd, &env_block) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to spawn process: {}", e);
            process::exit(1);
        }
    };

    // I/O 릴레이 시작
    let output_thread = pipe_relay::relay_output(pty.output_read);
    let input_thread = pipe_relay::relay_input(pty.input_write, &pty);

    // 자식 프로세스 종료 대기
    unsafe {
        WaitForSingleObject(pi.hProcess, INFINITE);

        let mut exit_code: u32 = 0;
        let _ = GetExitCodeProcess(pi.hProcess, &mut exit_code);

        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(job);

        // 스레드는 파이프가 닫히면 자동 종료
        drop(pty);

        let _ = output_thread.join();
        let _ = input_thread.join();

        process::exit(exit_code as i32);
    }
}
