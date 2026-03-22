use std::io;
use std::mem;
use std::ptr;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, GENERIC_READ, GENERIC_WRITE};
use windows::Win32::System::Console::{
    CreatePseudoConsole, ResizePseudoConsole, ClosePseudoConsole, HPCON, COORD,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreateNamedPipeW;
use windows::Win32::System::Threading::{
    CreateProcessW, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
    DeleteProcThreadAttributeList, PROCESS_INFORMATION, STARTUPINFOEXW,
    EXTENDED_STARTUPINFO_PRESENT, CREATE_UNICODE_ENVIRONMENT, STARTF_USESTDHANDLES,
    LPPROC_THREAD_ATTRIBUTE_LIST,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
    PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, FILE_FLAG_FIRST_PIPE_INSTANCE,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_WAIT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;

fn to_wstring(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct ConPty {
    pub hpc: HPCON,
    pub input_client: HANDLE,   // bridge writes to this → ConPTY input
    pub output_client: HANDLE,  // bridge reads from this ← ConPTY output
}

impl ConPty {
    /// Named Pipe 기반 ConPTY 생성 (node-pty 방식)
    pub fn new(cols: i16, rows: i16) -> io::Result<Self> {
        unsafe {
            let pid = std::process::id();
            let in_name = format!("\\\\.\\pipe\\conpty-{}-in", pid);
            let out_name = format!("\\\\.\\pipe\\conpty-{}-out", pid);

            let sa = SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: ptr::null_mut(),
                bInheritHandle: false.into(),
            };

            // Named Pipe 서버 생성
            let h_in_pipe = CreateNamedPipeW(
                &windows::core::HSTRING::from(&in_name),
                PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1, 128 * 1024, 128 * 1024, 30000, Some(&sa),
            );
            if h_in_pipe.is_invalid() {
                return Err(io::Error::new(io::ErrorKind::Other, "CreateNamedPipe in failed"));
            }

            let h_out_pipe = CreateNamedPipeW(
                &windows::core::HSTRING::from(&out_name),
                PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1, 128 * 1024, 128 * 1024, 30000, Some(&sa),
            );
            if h_out_pipe.is_invalid() {
                return Err(io::Error::new(io::ErrorKind::Other, "CreateNamedPipe out failed"));
            }

            // ConPTY 생성 (named pipe 서버 핸들 사용)
            let size = COORD { X: cols, Y: rows };
            let hpc = CreatePseudoConsole(size, h_in_pipe, h_out_pipe, 0)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("CreatePseudoConsole: {}", e)))?;

            // Named Pipe 클라이언트 연결
            let input_client = CreateFileW(
                &windows::core::HSTRING::from(&in_name),
                GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, format!("CreateFile in: {}", e)))?;

            let output_client = CreateFileW(
                &windows::core::HSTRING::from(&out_name),
                GENERIC_READ.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, format!("CreateFile out: {}", e)))?;

            // 서버 측 연결 완료
            let _ = ConnectNamedPipe(h_in_pipe, None);
            let _ = ConnectNamedPipe(h_out_pipe, None);

            // 서버 핸들은 ConPTY가 내부적으로 사용, CreateProcess 후 닫을 예정
            // 여기서는 임시로 보관
            // 실제로는 spawn()에서 닫음
            Ok(ConPty {
                hpc,
                input_client,
                output_client,
            })
        }
    }

    pub fn resize(&self, cols: i16, rows: i16) -> io::Result<()> {
        unsafe {
            let size = COORD { X: cols, Y: rows };
            ResizePseudoConsole(self.hpc, size)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
        }
    }

    pub fn spawn(&self, shell: &str, cwd: &str, env_block: &[u16]) -> io::Result<(PROCESS_INFORMATION, HANDLE)> {
        unsafe {
            let mut attr_size: usize = 0;
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                1, 0, &mut attr_size,
            );

            let mut attr_buf = vec![0u8; attr_size];
            let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut _);

            InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                Some(self.hpc.0 as *const _),
                mem::size_of::<HPCON>(),
                None,
                None,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            // ★ STARTF_USESTDHANDLES + null std handles
            // 자식 프로세스가 부모의 stdout을 상속하지 않도록 방지
            let mut si: STARTUPINFOEXW = mem::zeroed();
            si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = HANDLE::default();
            si.StartupInfo.hStdOutput = HANDLE::default();
            si.StartupInfo.hStdError = HANDLE::default();
            si.lpAttributeList = attr_list;

            let mut pi: PROCESS_INFORMATION = mem::zeroed();
            let mut cmd: Vec<u16> = shell.encode_utf16().chain(std::iter::once(0)).collect();
            let mut cwd_w: Vec<u16> = cwd.encode_utf16().chain(std::iter::once(0)).collect();

            CreateProcessW(
                None,
                PWSTR(cmd.as_mut_ptr()),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                Some(env_block.as_ptr() as *const _),
                PWSTR(cwd_w.as_mut_ptr()),
                &si.StartupInfo,
                &mut pi,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            DeleteProcThreadAttributeList(attr_list);

            // Job Object
            let job = CreateJobObjectW(None, None)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            AssignProcessToJobObject(job, pi.hProcess)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            Ok((pi, job))
        }
    }
}

impl Drop for ConPty {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.hpc);
            let _ = CloseHandle(self.input_client);
            let _ = CloseHandle(self.output_client);
        }
    }
}

/// 환경변수를 Windows 형식의 null-terminated 유니코드 블록으로 변환
pub fn build_env_block(extra: &[(&str, &str)]) -> Vec<u16> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    for (k, v) in extra {
        env.insert(k.to_string(), v.to_string());
    }
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in &env {
        let entry = format!("{}={}", k, v);
        block.extend(entry.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}
