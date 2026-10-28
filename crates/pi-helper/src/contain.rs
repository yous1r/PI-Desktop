//! Path containment for the helper protocol (spec 23 §10).
//!
//! A request path is always relative and is resolved against the registered
//! project roots or the helper directory. Anything that is not a plain
//! component (`..`, absolute paths, Windows prefixes, backslashes, NUL bytes)
//! is refused before the filesystem is touched, and a resolved path must still
//! be inside its root after `fs::canonicalize`, so a symlink or junction cannot
//! escape. Credential-shaped names are refused in both directions.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::{HelperError, HelperResult};

/// Longest relative path accepted from the protocol.
const MAX_RELATIVE_BYTES: usize = 4096;
/// Longest single component accepted from the protocol. Leaves room for the
/// `<name>.<streamId>.pi-part` sibling used by atomic uploads.
const MAX_COMPONENT_BYTES: usize = 220;
const MAX_COMPONENTS: usize = 64;

/// Top-level names inside the helper directory the protocol may reach.
/// `token` and everything else the helper owns stay unreachable.
const HELPER_TOP_LEVEL: &[&str] = &[
    "adapters", "bin", "env.json", "logs", "pids", "receipts", "venvs",
];

/// The allowlisted roots. Every base must be an absolute, canonical path.
pub(crate) struct Roots {
    helper: PathBuf,
    projects: Vec<PathBuf>,
}

impl Roots {
    pub(crate) fn new(helper: PathBuf, projects: Vec<PathBuf>) -> Self {
        Self { helper, projects }
    }

    pub(crate) fn helper_root(&self) -> &Path {
        &self.helper
    }

    pub(crate) fn project_roots(&self) -> &[PathBuf] {
        &self.projects
    }

    /// Refuses a configuration in which the helper directory and a project root
    /// overlap.
    ///
    /// A project root that contains `$HOME/.pi-desktop-helper` would expose the
    /// token, the installed binary and adapter state as ordinary project paths,
    /// so the fixed root models from M0 onward are disjoint by contract.
    pub(crate) fn validate(&self) -> HelperResult<()> {
        for project in &self.projects {
            if project.starts_with(&self.helper) || self.helper.starts_with(project) {
                return Err(HelperError::InvalidConfig);
            }
        }
        Ok(())
    }

    /// Confines `candidate` to `base` and keeps the helper directory private.
    ///
    /// The extra check is the defence in depth behind [`Roots::validate`]: even
    /// a path that legitimately resolves inside its own project root must never
    /// reach the helper's files through a symlink or a nested copy.
    fn confine(&self, base: &Path, candidate: &Path) -> HelperResult<PathBuf> {
        let canonical = confined(base, candidate)?;
        if base != self.helper && canonical.starts_with(&self.helper) {
            return Err(HelperError::PathForbidden);
        }
        Ok(canonical)
    }

    /// Resolves an existing path for a read-only operation.
    pub(crate) fn resolve_read(&self, relative: &str) -> HelperResult<PathBuf> {
        self.resolve_read_in(None, relative)
    }

    /// Resolves a read against exactly one registered root. Supplying a root
    /// index removes ambiguity when projects have nested or overlapping roots.
    pub(crate) fn resolve_read_in(
        &self,
        root_index: Option<usize>,
        relative: &str,
    ) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let bases = self.bases(&components, root_index)?;
        for base in bases {
            let candidate = join(base, &components);
            if fs::symlink_metadata(&candidate).is_ok() {
                return self.confine(base, &candidate);
            }
        }
        Err(HelperError::PathNotFound)
    }

    /// Resolves a path that may be replaced by an atomic upload.
    ///
    /// The parent directory must already exist and every existing component of
    /// the chain must be a real directory, so no symlinked ancestor is written
    /// through; an existing target must be a regular file.
    pub(crate) fn resolve_write(&self, relative: &str) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let (base, candidate) = self.pick(&components, components.len() - 1, None)?;
        verify_ancestors(base, &components[..components.len() - 1])?;
        // A new target is not canonicalizable yet, so the parent carries the
        // containment proof on its behalf.
        let parent = candidate.parent().ok_or(HelperError::InvalidArgument)?;
        self.confine(base, parent)?;
        if let Ok(metadata) = fs::symlink_metadata(&candidate) {
            if metadata.file_type().is_symlink() {
                return Err(HelperError::PathEscape);
            }
            if !metadata.is_file() {
                return Err(HelperError::InvalidArgument);
            }
            self.confine(base, &candidate)?;
        }
        Ok(candidate)
    }

    /// Resolves a directory that may be created, together with its parents.
    pub(crate) fn resolve_mkdir(&self, relative: &str) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let (base, candidate) = self.pick(&components, 0, None)?;
        let depth = existing_depth(base, &components);
        verify_ancestors(base, &components[..depth])?;
        if depth > 0 {
            self.confine(base, &join(base, &components[..depth]))?;
        }
        if depth == components.len() {
            let metadata =
                fs::symlink_metadata(&candidate).map_err(|_| HelperError::PathNotFound)?;
            if metadata.file_type().is_symlink() {
                return Err(HelperError::PathEscape);
            }
            if !metadata.is_dir() {
                return Err(HelperError::InvalidArgument);
            }
            return self.confine(base, &candidate);
        }
        fs::create_dir_all(&candidate)?;
        self.confine(base, &candidate)
    }

    /// Bases a request path may resolve against, in preference order.
    ///
    /// `root_index` pins the request to exactly one registered project root, so
    /// a path that exists in two roots can never be read from one and written
    /// to the other. The helper directory is only reachable through its own
    /// top-level names and never through a project base.
    fn bases<'a>(
        &'a self,
        components: &[&str],
        root_index: Option<usize>,
    ) -> HelperResult<Vec<&'a Path>> {
        let mut bases: Vec<&Path> = match root_index {
            Some(index) => vec![self
                .projects
                .get(index)
                .ok_or(HelperError::InvalidArgument)?
                .as_path()],
            None => self.projects.iter().map(PathBuf::as_path).collect(),
        };
        if HELPER_TOP_LEVEL.contains(&components[0]) {
            bases.push(self.helper.as_path());
        }
        Ok(bases)
    }

    /// Chooses the root with the deepest existing prefix of the request path.
    ///
    /// Ties keep the order above, so a project root wins over the helper
    /// directory when both can serve the same relative path.
    fn pick(
        &self,
        components: &[&str],
        required_depth: usize,
        root_index: Option<usize>,
    ) -> HelperResult<(&Path, PathBuf)> {
        let mut best: Option<(usize, &Path, PathBuf)> = None;
        for base in self.bases(components, root_index)? {
            let depth = existing_depth(base, components);
            if depth < required_depth {
                continue;
            }
            if best
                .as_ref()
                .is_some_and(|(best_depth, _, _)| *best_depth >= depth)
            {
                continue;
            }
            best = Some((depth, base, join(base, components)));
        }
        best.map(|(_, base, candidate)| (base, candidate))
            .ok_or(HelperError::PathNotFound)
    }
}

/// Splits a request path into plain components or refuses it.
fn validate_relative(relative: &str) -> HelperResult<Vec<&str>> {
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(HelperError::PathEscape);
    }
    if relative.len() > MAX_RELATIVE_BYTES {
        return Err(HelperError::InvalidArgument);
    }
    if relative.contains('\0') || relative.contains('\\') {
        return Err(HelperError::PathEscape);
    }
    let trimmed = relative.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(HelperError::InvalidArgument);
    }
    let mut components = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part.len() > MAX_COMPONENT_BYTES {
            return Err(HelperError::InvalidArgument);
        }
        if part == ".." {
            return Err(HelperError::PathEscape);
        }
        if !is_plain_component(part) {
            return Err(HelperError::PathEscape);
        }
        if credential_shaped(part) {
            return Err(HelperError::PathForbidden);
        }
        components.push(part);
    }
    if components.len() > MAX_COMPONENTS {
        return Err(HelperError::InvalidArgument);
    }
    Ok(components)
}

/// Rejects anything a platform path parser would treat as more than one plain
/// name, such as a Windows drive or UNC prefix.
fn is_plain_component(part: &str) -> bool {
    let mut parsed = Path::new(part).components();
    match (parsed.next(), parsed.next()) {
        (Some(Component::Normal(name)), None) => name.to_str() == Some(part),
        _ => false,
    }
}

fn credential_shaped(component: &str) -> bool {
    let lower = component.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower == ".ssh"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

fn join(base: &Path, components: &[&str]) -> PathBuf {
    let mut path = base.to_path_buf();
    for component in components {
        path.push(component);
    }
    path
}

/// Number of leading components of `components` that exist under `base`.
fn existing_depth(base: &Path, components: &[&str]) -> usize {
    (0..=components.len())
        .rev()
        .find(|depth| fs::metadata(join(base, &components[..*depth])).is_ok())
        .unwrap_or(0)
}

/// Requires every listed component to exist as a real directory.
///
/// A symlinked ancestor is refused as an escape, while an existing regular file
/// is a bad argument rather than an escape: nothing left the root, the caller
/// simply asked to traverse a non-directory.
fn verify_ancestors(base: &Path, components: &[&str]) -> HelperResult<()> {
    for index in 1..=components.len() {
        let path = join(base, &components[..index]);
        let metadata = fs::symlink_metadata(&path).map_err(|_| HelperError::PathNotFound)?;
        if metadata.file_type().is_symlink() {
            return Err(HelperError::PathEscape);
        }
        if !metadata.is_dir() {
            return Err(HelperError::InvalidArgument);
        }
    }
    Ok(())
}

/// Canonicalizes `candidate` and requires it to stay inside `base`.
fn confined(base: &Path, candidate: &Path) -> HelperResult<PathBuf> {
    let canonical = fs::canonicalize(candidate).map_err(|_| HelperError::PathEscape)?;
    if canonical.starts_with(base) {
        Ok(canonical)
    } else {
        Err(HelperError::PathEscape)
    }
}
