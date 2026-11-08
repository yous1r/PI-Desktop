//! Bounded synchronous Windows stdio with cancellable I/O, outside Tokio's
//! blocking pool so an unresponsive private peer cannot pin runtime shutdown.
use super::model::MAX_RECORD_BYTES;
use crate::execution_fence::native::{exited, Coordinator};
use anyhow::{bail, Result};
use std::io::{Read, Write};
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE};
use windows_sys::Win32::System::IO::CancelSynchronousIo;

pub(super) async fn receive(coordinator: &Coordinator) -> Result<Option<Vec<u8>>> {
    let mut input = pipe_file(std::io::stdin().as_handle())?;
    perform(coordinator, Duration::from_secs(30), move || {
        let mut header = [0u8; 4];
        if input.read(&mut header[..1])? == 0 {
            return Ok(None);
        }
        input.read_exact(&mut header[1..])?;
        let length = u32::from_le_bytes(header) as usize;
        if !(1..=MAX_RECORD_BYTES).contains(&length) {
            bail!("HANDOFF_INVALID_FRAME");
        }
        let mut body = vec![0u8; length];
        input.read_exact(&mut body)?;
        Ok(Some(body))
    })
    .await
}

pub(super) async fn send(coordinator: &Coordinator, body: Vec<u8>) -> Result<()> {
    if !(1..=MAX_RECORD_BYTES).contains(&body.len()) {
        bail!("HANDOFF_INVALID_FRAME");
    }
    // Bypass Stdout's global LineWriter: cancellation must not leave buffered
    // bytes for a second, unbounded flush during Rust process cleanup.
    let mut output = pipe_file(std::io::stdout().as_handle())?;
    perform(coordinator, Duration::from_secs(5), move || {
        output.write_all(&(body.len() as u32).to_le_bytes())?;
        output.write_all(&body)?;
        Ok(())
    })
    .await
}

fn pipe_file(handle: BorrowedHandle<'_>) -> Result<std::fs::File> {
    if unsafe { GetFileType(handle.as_raw_handle()) } != FILE_TYPE_PIPE {
        bail!("HANDOFF_PRIVATE_PIPE_REQUIRED");
    }
    Ok(std::fs::File::from(handle.try_clone_to_owned()?))
}

struct IoThread<T>(Option<std::thread::JoinHandle<Result<T>>>);
impl<T> Drop for IoThread<T> {
    fn drop(&mut self) {
        if let Some(thread) = &self.0 {
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
        }
    }
}
async fn perform<T: Send + 'static>(
    coordinator: &Coordinator,
    budget: Duration,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let mut worker = IoThread(Some(
        std::thread::Builder::new()
            .name("handoff-stdio".into())
            .spawn(action)?,
    ));
    let deadline = Instant::now() + budget;
    let mut cancellation: Option<(Instant, anyhow::Error)> = None;
    loop {
        let thread = worker
            .0
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HANDOFF_IO_UNAVAILABLE"))?;
        if thread.is_finished() {
            let thread = worker
                .0
                .take()
                .ok_or_else(|| anyhow::anyhow!("HANDOFF_IO_UNAVAILABLE"))?;
            let result = thread
                .join()
                .map_err(|_| anyhow::anyhow!("HANDOFF_IO_FAILED"))?;
            return match cancellation {
                Some((_, error)) => Err(error),
                None => result,
            };
        }
        if cancellation.is_none() {
            let reason = match exited(coordinator.handle.as_raw_handle()) {
                Ok(true) => Some(anyhow::anyhow!("HANDOFF_COORDINATOR_EXITED")),
                Err(error) => Some(error),
                Ok(false) if Instant::now() >= deadline => {
                    Some(anyhow::anyhow!("HANDOFF_IO_TIMEOUT"))
                }
                Ok(false) => None,
            };
            cancellation = reason.map(|error| (Instant::now(), error));
        }
        if let Some((started, _)) = &cancellation {
            // Retry until joined: the thread may be between its header/body I/O.
            unsafe {
                CancelSynchronousIo(thread.as_raw_handle());
            }
            if started.elapsed() >= Duration::from_secs(2) {
                // No journal work exists on this thread. This error exits the
                // restricted process; OS teardown closes any unconfirmed I/O.
                bail!("HANDOFF_IO_CLEANUP_UNCONFIRMED");
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
