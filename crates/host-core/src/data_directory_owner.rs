//! One cooperating Host process per data directory, before boot maintenance.
//! Keep the lock inode stable: deleting it would let another process lock a new file.

use anyhow::{bail, Context, Result};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

pub const IN_USE_MARKER: &str = "HOST_DATA_DIR_IN_USE";
const LOCK_FILE: &str = "host-core.lock";

#[derive(Debug)]
pub struct DataDirectoryOwner {
    // Closing the non-inherited handle releases ownership, including on crash.
    _file: File,
}

impl DataDirectoryOwner {
    pub fn acquire(directory: &Path) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            // Deny deletion/replacement while an owner or contender holds it.
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options
            .open(directory.join(LOCK_FILE))
            .context("open Host ownership lock")?;
        let metadata = file.metadata().context("inspect Host ownership lock")?;
        if !metadata.is_file() {
            bail!("Host ownership lock is not a regular file");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                bail!("Host ownership lock must not be a reparse point");
            }
        }
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => {
                bail!("{IN_USE_MARKER}: another host-core owns this data directory")
            }
            Err(TryLockError::Error(error)) => Err(error).context("lock Host data directory"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_owner_per_directory_and_release_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let owner = DataDirectoryOwner::acquire(dir.path()).unwrap();
        let error = DataDirectoryOwner::acquire(dir.path()).unwrap_err();
        assert!(error.to_string().starts_with(IN_USE_MARKER));
        let other = tempfile::tempdir().unwrap();
        let independent = DataDirectoryOwner::acquire(other.path()).unwrap();
        drop(independent);
        drop(owner);
        let successor = DataDirectoryOwner::acquire(dir.path()).unwrap();
        drop(successor);
        assert!(dir.path().join(LOCK_FILE).is_file());
    }

    #[test]
    fn existing_lock_file_is_not_truncated_or_interpreted_as_a_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        std::fs::write(&path, "retained stale metadata").unwrap();
        let owner = DataDirectoryOwner::acquire(dir.path()).unwrap();
        assert!(DataDirectoryOwner::acquire(dir.path()).is_err());
        drop(owner);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "retained stale metadata"
        );
        assert!(DataDirectoryOwner::acquire(dir.path()).is_ok());
    }

    #[test]
    fn rejects_a_directory_in_place_of_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(LOCK_FILE)).unwrap();
        assert!(DataDirectoryOwner::acquire(dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_fifo_without_following_or_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("outside");
        std::fs::write(&target, "unchanged").unwrap();
        let path = dir.path().join(LOCK_FILE);
        symlink(&target, &path).unwrap();
        assert!(DataDirectoryOwner::acquire(dir.path()).is_err());
        std::fs::remove_file(&path).unwrap();
        let fifo = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo is a valid, NUL-terminated path inside the test directory.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(DataDirectoryOwner::acquire(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "unchanged");
    }
}
