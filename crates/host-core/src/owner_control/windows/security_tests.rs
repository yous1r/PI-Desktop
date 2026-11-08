use super::*;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, ImpersonateLoggedOnUser, RevertToSelf, WinWorldSid,
    DISABLE_MAX_PRIVILEGE, SID_AND_ATTRIBUTES, TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

struct Revert;
impl Drop for Revert {
    fn drop(&mut self) {
        // A test must never return a worker thread with an impersonation token.
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

#[tokio::test]
async fn owner_acl_rejects_a_restricted_token_without_granting_world_access() {
    let root = tempfile::tempdir().unwrap();
    let mut control = Control::start(root.path()).unwrap();
    let (name, _) = address(root.path(), &Identity::current().unwrap()).unwrap();
    tokio::task::spawn_blocking(move || {
        let mut original = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                    &mut original,
                )
            },
            0
        );
        let original = unsafe { OwnedHandle::from_raw_handle(original) };
        let mut world_sid = [0_usize; 16];
        let mut sid_bytes = std::mem::size_of_val(&world_sid) as u32;
        assert_ne!(
            unsafe {
                CreateWellKnownSid(
                    WinWorldSid,
                    std::ptr::null_mut(),
                    world_sid.as_mut_ptr().cast(),
                    &mut sid_bytes,
                )
            },
            0
        );
        let restriction = SID_AND_ATTRIBUTES {
            Sid: world_sid.as_mut_ptr().cast(),
            Attributes: 0,
        };
        let mut restricted = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    original.as_raw_handle(),
                    DISABLE_MAX_PRIVILEGE,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    1,
                    &restriction,
                    &mut restricted,
                )
            },
            0
        );
        let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };
        assert_ne!(
            unsafe { ImpersonateLoggedOnUser(restricted.as_raw_handle()) },
            0
        );
        let revert = Revert;
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        let error = unsafe { GetLastError() };
        drop(revert);
        if result != INVALID_HANDLE_VALUE {
            drop(unsafe { OwnedHandle::from_raw_handle(result) });
            panic!("restricted token unexpectedly opened owner pipe");
        }
        assert_eq!(error, ERROR_ACCESS_DENIED);
    })
    .await
    .unwrap();
    assert!(query(root.path(), None).await.unwrap().status.is_some());
    control.close().await;
}
