//! Conservative cross-lifetime checks. No termination or PID-only adoption.
use super::model::{Generation, Owner, ProcessIdentity};
use super::startup::NativeProof;
use crate::execution_fence::native::{exited, Job};
use crate::owner_control::identity::Identity;
use anyhow::{bail, Context, Result};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER, FILETIME};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

pub fn record(pid: u32, identity: &Identity) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        created_at: identity.created_at.to_string(),
        sid: identity.sid.clone(),
        image: identity.image.to_string_lossy().into_owned(),
    }
}

pub fn process_ended(recorded: &ProcessIdentity) -> Result<()> {
    recorded.validate()?;
    let current = Identity::current()?;
    if current.sid != recorded.sid {
        bail!("HANDOFF_NATIVE_USER_MISMATCH");
    }
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            recorded.pid,
        )
    };
    if raw.is_null() {
        // A vanished PID is useful only together with the separately checked
        // native containment registration. Access denial is never absence.
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(());
        }
        bail!("HANDOFF_PROCESS_PROOF_UNAVAILABLE");
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut ended = created;
    let mut kernel = created;
    let mut user = created;
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut ended,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        bail!("HANDOFF_PROCESS_TIME_UNAVAILABLE");
    }
    let created_at = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    if created_at.to_string() != recorded.created_at {
        bail!("HANDOFF_PROCESS_IDENTITY_CHANGED");
    }
    // Windows can no longer query an exited process's image. Exact immutable
    // creation identity plus the retained handle's signalled exit proves this
    // registered process ended; a recycled PID never passes the creation check.
    if exited(handle.as_raw_handle())? {
        return Ok(());
    }
    let live = Identity::from_process(handle.as_raw_handle())
        .context("HANDOFF_PROCESS_IDENTITY_UNAVAILABLE")?;
    if live.created_at.to_string() != recorded.created_at
        || live.sid != recorded.sid
        || !live
            .image
            .to_string_lossy()
            .eq_ignore_ascii_case(&recorded.image)
    {
        bail!("HANDOFF_PROCESS_IDENTITY_CHANGED");
    }
    bail!("HANDOFF_PREVIOUS_PROCESS_ALIVE")
}

pub struct Proof;
impl NativeProof for Proof {
    fn owner_ended(&mut self, owner: &Owner) -> Result<()> {
        owner.validate()?;
        process_ended(&owner.host)
    }
    fn generation_ended(&mut self, generation: &Generation) -> Result<()> {
        generation.validate()?;
        if Job::recorded_active(&generation.job_name)?.is_some_and(|count| count != 0) {
            bail!("HANDOFF_PREVIOUS_CONTAINMENT_ACTIVE");
        }
        if let Some(root) = &generation.root {
            process_ended(root)?;
        }
        Ok(())
    }
}
