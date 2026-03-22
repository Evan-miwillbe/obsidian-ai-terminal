use std::io;
use std::mem;
use std::ptr;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, BOOL};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Console::{
    CreatePseudoConsole, ResizePseudoConsole, ClosePseudoConsole, HPCON, COORD,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
    DeleteProcThreadAttributeList, PROCESS_INFORMATION, STARTUPINFOEXW,
    EXTENDED_STARTUPINFO_PRESENT, CREATE_UNICODE_ENVIRONMENT,
    LPPROC_THREAD_ATTRIBUTE_LIST,
};

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;

pub struct ConPty {
    pub hpc: HPCON,
    pub input_write: HANDLE,   // plugin writes to this → ConPTY input
    pub output_read: HANDLE,   // plugin reads from this ← ConPTY output
    input_read: HANDLE,        // ConPTY reads from this (internal)
    output_write: HANDLE,      // ConPTY writes to this (internal)
}

impl ConPty {
    pub fn new(cols: i16, rows: i16) -> io::Result<Self> {
        unsafe {
            let mut input_read = HANDLE::default();
            let mut input_write = HANDLE::default();
            let mut output_read = HANDLE::default();
            let mut output_write = HANDLE::default();

            // 파이프 생성: input (plugin → ConPTY)
            CreatePipe(&mut input_read, &mut input_write, None, 0)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            // 파이프 생성: output (ConPTY → plugin)
            CreatePipe(&mut output_read, &mut output_write, None, 0)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            let size = COORD { X: cols, Y: rows };
            let hpc = CreatePseudoConsole(size, input_read, output_write, 0)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            Ok(ConPty {
                hpc,
                input_write,
                output_read,
                input_read,
                output_write,
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
            // ProcThreadAttributeList 크기 계산
            let mut attr_size: usize = 0;
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                1, 0, &mut attr_size,
            );

            let mut attr_buf = vec![0u8; attr_size];
            let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut _);

            InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            // ConPTY를 attribute에 연결
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                Some(self.hpc.0 as *const _),
                mem::size_of::<HPCON>(),
                None,
                None,
            ).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            let mut si: STARTUPINFOEXW = mem::zeroed();
            si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
            si.lpAttributeList = attr_list;

            let mut pi: PROCESS_INFORMATION = mem::zeroed();

            // 커맨드라인
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

            // Job Object로 자식 프로세스 그룹 관리
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
            let _ = CloseHandle(self.input_read);
            let _ = CloseHandle(self.input_write);
            let _ = CloseHandle(self.output_read);
            let _ = CloseHandle(self.output_write);
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
    block.push(0); // 최종 null terminator
    block
}
