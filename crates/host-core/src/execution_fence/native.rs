//! Native process identities and non-inheritable, kill-on-close containment.
use crate::owner_control::identity::Identity;
use anyhow::{bail, Context, Result};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{
    FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

pub fn exited(handle: HANDLE) -> Result<bool> {
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => bail!("EXECUTION_FENCE_IDENTITY_UNAVAILABLE"),
    }
}
pub fn now() -> u64 {
    let mut value: FILETIME = unsafe { std::mem::zeroed() };
    unsafe { GetSystemTimePreciseAsFileTime(&mut value) };
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}
pub fn parent_pid(pid: u32) -> Result<u32> {
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        bail!("EXECUTION_FENCE_PARENT_UNAVAILABLE");
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == pid && entry.th32ParentProcessID != 0 {
            return Ok(entry.th32ParentProcessID);
        }
        ok = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    bail!("EXECUTION_FENCE_PARENT_UNAVAILABLE")
}
pub struct Coordinator {
    pub pid: u32,
    pub handle: OwnedHandle,
    pub identity: Identity,
}
impl Coordinator {
    pub fn capture(owner: &Identity) -> Result<Self> {
        let pid = parent_pid(std::process::id())?;
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            bail!("EXECUTION_FENCE_PARENT_UNAVAILABLE");
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let identity = Identity::from_process(handle.as_raw_handle())?;
        if identity.sid != owner.sid
            || identity.created_at >= owner.created_at
            || exited(handle.as_raw_handle())?
        {
            bail!("EXECUTION_FENCE_PARENT_MISMATCH");
        }
        Ok(Self {
            pid,
            handle,
            identity,
        })
    }
}
pub struct Job(OwnedHandle);
impl Job {
    pub fn create() -> Result<Self> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error()).context("EXECUTION_FENCE_JOB_UNAVAILABLE");
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // No BREAKAWAY or SILENT_BREAKAWAY; no handle is duplicated to a child.
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error()).context("EXECUTION_FENCE_JOB_UNAVAILABLE");
        }
        Ok(job)
    }
    pub fn assign(&self, process: HANDLE) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(std::io::Error::last_os_error()).context("EXECUTION_FENCE_ASSIGN_FAILED");
        }
        Ok(())
    }
    pub fn active(&self) -> Result<u32> {
        let mut counts: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut counts).cast(),
                std::mem::size_of_val(&counts) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            bail!("EXECUTION_FENCE_QUERY_FAILED");
        }
        Ok(counts.ActiveProcesses)
    }
    pub fn terminate(&self) -> Result<()> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            bail!("EXECUTION_FENCE_TERMINATE_FAILED");
        }
        Ok(())
    }
}
