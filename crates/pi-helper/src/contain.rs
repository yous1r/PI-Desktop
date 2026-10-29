//! Path containment for the helper protocol (spec 23 §10).
//!
//! A request path is always relative and resolves inside exactly one base: the
//! project root the request names, or the helper's own directory for adapter
//! operations. The two namespaces never mix, so a project file whose first
//! segment matches a helper name (`bin/`, `env.json`, ...) still lands in the
//! project, and nothing under a project path can reach helper state.
//!
//! Anything that is not a plain component (`..`, absolute paths, Windows
//! prefixes, backslashes, NUL bytes) is refused before the filesystem is
//! touched, and a resolved path must still be inside its base after
//! `fs::canonicalize`, so a symlink or junction cannot escape. Credential-shaped
//! names are refused in both directions.

use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{RwLock, RwLockReadGuard},
};

use crate::{HelperError, HelperResult};

/// Longest relative path accepted from the protocol.
const MAX_RELATIVE_BYTES: usize = 4096;
/// Longest absolute project root accepted by `root.register`.
const MAX_ROOT_BYTES: usize = 4096;
/// Longest single component accepted from the protocol. Leaves room for the
/// `<name>.<streamId>.pi-part` sibling used by atomic uploads.
const MAX_COMPONENT_BYTES: usize = 220;
const MAX_COMPONENTS: usize = 64;
/// Most project roots one helper process serves. The registry only grows for
/// the life of the process, so it is bounded.
pub(crate) const MAX_PROJECT_ROOTS: usize = 64;

/// Top-level names inside the helper directory that helper-scoped operations
/// may reach. Only the adapter tree is addressed by the protocol; the token,
/// the installed binary, logs and receipts stay unreachable.
const HELPER_TOP_LEVEL: &[&str] = &["adapters"];

/// The single base one request resolves against.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Scope<'a> {
    /// A registered project root, named by its canonical absolute path.
    Project(&'a Path),
    /// The helper's own directory, reachable only by adapter operations.
    Helper,
}

/// The allowlisted roots. Every base is an absolute, canonical path.
pub(crate) struct Roots {
    helper: PathBuf,
    projects: RwLock<Vec<PathBuf>>,
}

impl Roots {
    pub(crate) fn new(helper: PathBuf, projects: Vec<PathBuf>) -> Self {
        Self {
            helper,
            projects: RwLock::new(projects),
        }
    }

    pub(crate) fn helper_root(&self) -> &Path {
        &self.helper
    }

    pub(crate) fn project_count(&self) -> usize {
        self.read_projects().len()
    }

    /// The registry only ever grows by one complete push, so a poisoned lock
    /// still guards a consistent list.
    fn read_projects(&self) -> RwLockReadGuard<'_, Vec<PathBuf>> {
        self.projects
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Refuses a configuration in which the helper directory and a project root
    /// overlap.
    ///
    /// A project root that contains `$HOME/.pi-desktop-helper` would expose the
    /// token, the installed binary and adapter state as ordinary project paths,
    /// so the roots are disjoint by contract.
    pub(crate) fn validate(&self) -> HelperResult<()> {
        self.read_projects()
            .iter()
            .try_for_each(|project| self.refuse_overlap(project))
    }

    fn refuse_overlap(&self, project: &Path) -> HelperResult<()> {
        if project.starts_with(&self.helper) || self.helper.starts_with(project) {
            return Err(HelperError::RootOverlap);
        }
        Ok(())
    }

    /// Registers one mirror root and returns its canonical form, which every
    /// later file operation names as its `root`.
    ///
    /// Registration is idempotent. The root must be an existing directory that
    /// is disjoint from the helper directory, so `$HOME` itself and anything
    /// inside the helper directory are refused.
    pub(crate) fn register(&self, requested: &str) -> HelperResult<PathBuf> {
        if requested.is_empty() || requested.len() > MAX_ROOT_BYTES || requested.contains('\0') {
            return Err(HelperError::InvalidArgument);
        }
        let requested = Path::new(requested);
        if !requested.is_absolute() {
            return Err(HelperError::InvalidArgument);
        }
        let canonical = fs::canonicalize(requested).map_err(|_| HelperError::PathNotFound)?;
        // The canonical form travels back over the protocol as a string.
        if !canonical.is_dir() || canonical.to_str().is_none() {
            return Err(HelperError::InvalidArgument);
        }
        self.refuse_overlap(&canonical)?;
        let mut projects = self
            .projects
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !projects.contains(&canonical) {
            if projects.len() >= MAX_PROJECT_ROOTS {
                return Err(HelperError::InvalidArgument);
            }
            projects.push(canonical.clone());
        }
        Ok(canonical)
    }

    /// The base a scope resolves against.
    ///
    /// A project scope must name a registered root exactly; there is no default
    /// root and no search across roots, so a request can never land in another
    /// project. The helper scope admits only its allowlisted top-level names.
    fn base(&self, scope: Scope<'_>, components: &[&str]) -> HelperResult<PathBuf> {
        match scope {
            Scope::Helper => match components.first() {
                Some(first) if HELPER_TOP_LEVEL.contains(first) => Ok(self.helper.clone()),
                _ => Err(HelperError::PathForbidden),
            },
            Scope::Project(root) => self
                .read_projects()
                .iter()
                .find(|project| project.as_path() == root)
                .cloned()
                .ok_or(HelperError::PathForbidden),
        }
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
    pub(crate) fn resolve_read(&self, scope: Scope<'_>, relative: &str) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let base = self.base(scope, &components)?;
        let candidate = join(&base, &components);
        if fs::symlink_metadata(&candidate).is_err() {
            return Err(HelperError::PathNotFound);
        }
        self.confine(&base, &candidate)
    }

    /// Resolves a path that may be replaced by an atomic upload.
    ///
    /// The parent directory must already exist and every component of the chain
    /// must be a real directory, so no symlinked ancestor is written through; an
    /// existing target must be a regular file.
    pub(crate) fn resolve_write(&self, scope: Scope<'_>, relative: &str) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let base = self.base(scope, &components)?;
        let (_, ancestors) = components
            .split_last()
            .ok_or(HelperError::InvalidArgument)?;
        verify_ancestors(&base, ancestors)?;
        let candidate = join(&base, &components);
        // A new target is not canonicalizable yet, so the parent carries the
        // containment proof on its behalf.
        let parent = candidate.parent().ok_or(HelperError::InvalidArgument)?;
        self.confine(&base, parent)?;
        if let Ok(metadata) = fs::symlink_metadata(&candidate) {
            if metadata.file_type().is_symlink() {
                return Err(HelperError::PathEscape);
            }
            if !metadata.is_file() {
                return Err(HelperError::InvalidArgument);
            }
            self.confine(&base, &candidate)?;
        }
        Ok(candidate)
    }

    /// Resolves a directory that may be created, together with its parents.
    pub(crate) fn resolve_mkdir(&self, scope: Scope<'_>, relative: &str) -> HelperResult<PathBuf> {
        let components = validate_relative(relative)?;
        let base = self.base(scope, &components)?;
        let candidate = join(&base, &components);
        let depth = existing_depth(&base, &components);
        verify_ancestors(&base, &components[..depth])?;
        if depth > 0 {
            self.confine(&base, &join(&base, &components[..depth]))?;
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
            return self.confine(&base, &candidate);
        }
        fs::create_dir_all(&candidate)?;
        self.confine(&base, &candidate)
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
