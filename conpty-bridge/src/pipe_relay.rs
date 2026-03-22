use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::thread;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};

use crate::conpty::ConPty;

const RESIZE_PREFIX: &[u8] = b"\x1b]resize";
const RESIZE_TERMINATOR: u8 = 0x07;

/// ConPTY output → stdout 릴레이 (별도 스레드)
pub fn relay_output(output_read: HANDLE) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let stdout = io::stdout();
        loop {
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(output_read, Some(&mut buf), Some(&mut bytes_read), None)
            };
            if ok.is_err() || bytes_read == 0 {
                break;
            }
            let mut out = stdout.lock();
            if out.write_all(&buf[..bytes_read as usize]).is_err() {
                break;
            }
            let _ = out.flush();
        }
    })
}

/// stdin → ConPTY input 릴레이 + resize 시퀀스 파싱 (별도 스레드)
pub fn relay_input(input_write: HANDLE, conpty: &ConPty) -> thread::JoinHandle<()> {
    // resize 요청을 메인 스레드로 전달하기 위한 채널
    // ConPty는 Send가 아닐 수 있으므로, resize는 콜백 방식 대신 직접 처리
    let hpc = conpty.hpc;

    thread::spawn(move || {
        let stdin = io::stdin();
        let mut buf = [0u8; 65536];
        loop {
            let mut handle = stdin.lock();
            let n = match handle.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            drop(handle);

            let data = &buf[..n];
            let mut i = 0;

            while i < data.len() {
                // resize 시퀀스 감지: \x1b]resize;<cols>;<rows>\x07
                if data[i..].starts_with(RESIZE_PREFIX) {
                    if let Some(end_offset) = data[i..].iter().position(|&b| b == RESIZE_TERMINATOR) {
                        let seq = &data[i + RESIZE_PREFIX.len()..i + end_offset];
                        if let Ok(params_str) = std::str::from_utf8(seq) {
                            let params: Vec<&str> = params_str.trim_start_matches(';').split(';').collect();
                            if params.len() == 2 {
                                if let (Ok(cols), Ok(rows)) = (params[0].parse::<i16>(), params[1].parse::<i16>()) {
                                    // ConPTY resize
                                    unsafe {
                                        let size = windows::Win32::System::Console::COORD { X: cols, Y: rows };
                                        let _ = windows::Win32::System::Console::ResizePseudoConsole(
                                            windows::Win32::System::Console::HPCON(hpc.0),
                                            size,
                                        );
                                    }
                                }
                            }
                        }
                        i += end_offset + 1;
                        continue;
                    }
                }

                // 다음 resize 시퀀스 찾기
                let next_resize = data[i + 1..].windows(RESIZE_PREFIX.len())
                    .position(|w| w == RESIZE_PREFIX)
                    .map(|p| p + i + 1);

                let end = next_resize.unwrap_or(data.len());
                let chunk = &data[i..end];

                // ConPTY input에 쓰기
                let mut written: u32 = 0;
                let ok = unsafe {
                    WriteFile(input_write, Some(chunk), Some(&mut written), None)
                };
                if ok.is_err() {
                    return;
                }

                i = end;
            }
        }
    })
}
