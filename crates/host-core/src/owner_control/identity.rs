//! Windows identity and owner-only ACL checks for the local control pipe.
use anyhow::{bail, Context, Result};
use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use windows_sys::Win32::Foundation::{GetLastError, LocalFree, FILETIME, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Clone)]
pub struct Identity {
    pub sid: String,
    pub image: PathBuf,
    pub created_at: u64,
}

pub struct Peer {
    pub pid: u32,
    pub identity: Identity,
    // Keep the original process handle through the exchange; never reopen its PID.
    _handle: OwnedHandle,
}

impl Identity {
    pub fn current() -> Result<Self> {
        // Pseudo handle is borrowed, never closed.
        Self::from_process(unsafe { GetCurrentProcess() })
    }
    fn from_process(process: HANDLE) -> Result<Self> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            bail!("OWNER_CONTROL_AUTH_FAILED: token unavailable");
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut size = 0;
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut size,
            );
        }
        if size == 0 || size > 64 * 1024 {
            bail!("OWNER_CONTROL_AUTH_FAILED: invalid token size");
        }
        // TOKEN_USER contains pointers and needs pointer-aligned storage.
        let mut data = vec![0_usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                data.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        } == 0
        {
            bail!("OWNER_CONTROL_AUTH_FAILED: token query failed");
        }
        let user = unsafe { &*data.as_ptr().cast::<TOKEN_USER>() };
        let mut sid_text = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid_text) } == 0 {
            bail!("OWNER_CONTROL_AUTH_FAILED: SID unavailable");
        }
        let mut len = 0;
        while unsafe { *sid_text.add(len) } != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, len) });
        unsafe {
            LocalFree(sid_text.cast());
        }
        let mut image = vec![0_u16; 32_768];
        let mut length = image.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) } == 0 {
            bail!("OWNER_CONTROL_AUTH_FAILED: image unavailable");
        }
        let image = std::fs::canonicalize(PathBuf::from(OsString::from_wide(
            &image[..length as usize],
        )))
        .context("resolve owner-control executable")?;
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit = created;
        let mut kernel = created;
        let mut user_time = created;
        if unsafe {
            GetProcessTimes(
                process,
                &mut created,
                &mut exit,
                &mut kernel,
                &mut user_time,
            )
        } == 0
        {
            bail!("OWNER_CONTROL_AUTH_FAILED: process identity unavailable");
        }
        Ok(Self {
            sid,
            image,
            created_at: (u64::from(created.dwHighDateTime) << 32)
                | u64::from(created.dwLowDateTime),
        })
    }
    fn accepts(&self, peer: &Self) -> bool {
        self.sid == peer.sid
            && self
                .image
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&peer.image.as_os_str().to_string_lossy())
    }
}

pub fn authenticate(pipe: HANDLE, server_side: bool, owner: &Identity) -> Result<Peer> {
    let mut pid = 0;
    let ok = unsafe {
        if server_side {
            GetNamedPipeClientProcessId(pipe, &mut pid)
        } else {
            GetNamedPipeServerProcessId(pipe, &mut pid)
        }
    };
    if ok == 0 || pid == 0 {
        bail!("OWNER_CONTROL_AUTH_FAILED: peer unavailable");
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        bail!("OWNER_CONTROL_AUTH_FAILED: peer process unavailable");
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(process) };
    let identity = Identity::from_process(handle.as_raw_handle())?;
    if !owner.accepts(&identity) {
        bail!("OWNER_CONTROL_AUTH_FAILED: peer identity mismatch");
    }
    Ok(Peer {
        pid,
        identity,
        _handle: handle,
    })
}

pub struct SecurityDescriptor(*mut c_void);
impl SecurityDescriptor {
    pub fn for_user(sid: &str) -> Result<Self> {
        let text: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            bail!("owner-control ACL creation failed: {}", unsafe {
                GetLastError()
            });
        }
        Ok(Self(descriptor))
    }
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_requires_both_current_sid_and_host_image() {
        let current = Identity::current().unwrap();
        assert!(current.accepts(&current));
        let mut other = current.clone();
        other.sid = "S-1-5-18".into();
        if current.sid == other.sid {
            other.sid = "S-1-5-19".into();
        }
        assert!(!current.accepts(&other));
        other = current.clone();
        other.image = PathBuf::from("C:/not-the-host.exe");
        assert!(!current.accepts(&other));
        assert!(current.created_at > 0);
    }
}
