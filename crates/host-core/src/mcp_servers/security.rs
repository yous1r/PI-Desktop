//! Pure validation of additive HTTP settings. Credential contents and X.509
//! parsing belong to Main; scanning untrusted documents never reads secrets.

use super::{normalize_project_path, McpConfig, MAX_VALUE_BYTES};
use crate::db::REMOTE_PROJECT_PREFIX;
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

const CREDENTIAL_PREFIX: &str = "secret:mcp:bearer:";
const MAX_CA_BYTES: usize = 64 * 1024;
const MAX_BINDINGS: usize = 64;
const MAX_CENTRAL_PROJECT_BYTES: usize = 256;
const CERTIFICATE_BEGIN: &str = "-----BEGIN CERTIFICATE-----";
const CERTIFICATE_END: &str = "-----END CERTIFICATE-----";

pub(super) fn valid_credential_ref(reference: &str) -> bool {
    reference
        .strip_prefix(CREDENTIAL_PREFIX)
        .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id))
}

pub(super) fn new_credential_ref() -> String {
    format!("{CREDENTIAL_PREFIX}{}", Uuid::new_v4())
}

/// Do not revalidate legacy documents' old fields during a scan. Only the new
/// security surface is fail-closed, preserving existing unmanaged MCP behavior.
pub(super) fn validate(config: &McpConfig) -> Result<()> {
    if config.auth_type.is_none()
        && config.credential_ref.is_none()
        && config.ca_certificate.is_none()
        && config.memory_project_bindings.is_empty()
    {
        return Ok(());
    }
    if config.transport != "http" {
        bail!("MCP_INVALID: authentication, CA and memory bindings require HTTP transport");
    }
    match (
        config.auth_type.as_deref(),
        config.credential_ref.as_deref(),
    ) {
        (None, None) => {}
        (Some("bearer"), Some(reference)) if valid_credential_ref(reference) => {
            check_bearer(config)?;
        }
        (Some("bearer"), _) => {
            bail!(
                "MCP_INVALID: bearer authentication requires a namespaced canonical UUID credentialRef"
            );
        }
        (Some(_), _) => bail!("MCP_INVALID: authType must be \"bearer\" or null"),
        (None, Some(_)) => bail!("MCP_INVALID: credentialRef requires bearer authentication"),
    }
    if let Some(pem) = &config.ca_certificate {
        let (url, _) = http_url(config)?;
        if url.scheme() != "https" {
            bail!("MCP_INVALID: caCertificate requires HTTPS");
        }
        check_public_pem(pem)?;
    }
    check_bindings(&config.memory_project_bindings)
}

fn http_url(config: &McpConfig) -> Result<(Url, &str)> {
    let raw = config.url.as_deref().unwrap_or_default();
    if raw.len() > MAX_VALUE_BYTES || raw.chars().any(char::is_control) || raw.contains('\\') {
        bail!("MCP_INVALID: invalid HTTP security URL");
    }
    let raw = raw.trim();
    let (_, rest) = raw
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("MCP_INVALID: invalid HTTP security URL"))?;
    let url =
        Url::parse(raw).map_err(|_| anyhow::anyhow!("MCP_INVALID: invalid HTTP security URL"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || authority.is_empty()
    {
        bail!("MCP_INVALID: invalid HTTP security URL");
    }
    Ok((url, authority))
}

fn check_bearer(config: &McpConfig) -> Result<()> {
    let (url, authority) = http_url(config)?;
    if authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("MCP_INVALID: managed bearer URL must not contain credentials, query or fragment");
    }
    // Check the literal authority, not a URL parser's normalized IP: shorthand,
    // integer, encoded and alternate loopback spellings must not widen HTTP.
    let host = if authority.starts_with('[') {
        authority.split_inclusive(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    if url.scheme() == "http"
        && !["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|allowed| host.eq_ignore_ascii_case(allowed))
    {
        bail!("MCP_INVALID: managed bearer authentication requires HTTPS or strict loopback HTTP");
    }
    if config
        .headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"))
    {
        bail!("MCP_INVALID: managed bearer authentication must not set an Authorization header");
    }
    Ok(())
}

/// Validate only public certificate PEM structure/base64 here, not X.509 trust.
/// Any other PEM label or non-PEM content (including private keys) is refused.
fn check_public_pem(pem: &str) -> Result<()> {
    if pem.len() > MAX_CA_BYTES {
        bail!("MCP_INVALID: caCertificate must not exceed 64 KiB");
    }
    if !pem.is_ascii() {
        bail!("MCP_INVALID: caCertificate must contain only public certificate PEM");
    }
    let mut inside = false;
    let mut encoded = String::new();
    let mut certificates = 0;
    for line in pem.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !inside {
            if line != CERTIFICATE_BEGIN {
                bail!("MCP_INVALID: caCertificate must contain only public certificate PEM");
            }
            inside = true;
        } else if line == CERTIFICATE_END {
            if encoded.is_empty() || STANDARD.decode(&encoded).is_err() {
                bail!("MCP_INVALID: caCertificate contains invalid certificate PEM");
            }
            encoded.clear();
            inside = false;
            certificates += 1;
        } else if line
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            encoded.push_str(line);
        } else {
            bail!("MCP_INVALID: caCertificate must contain only public certificate PEM");
        }
    }
    if inside || certificates == 0 {
        bail!("MCP_INVALID: caCertificate requires complete public certificate PEM");
    }
    Ok(())
}

fn drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn valid_central_project(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_CENTRAL_PROJECT_BYTES
        && bytes[0].is_ascii_alphanumeric()
        && !drive_prefix(value)
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(*byte, b'.' | b'_' | b':' | b'/' | b'@' | b'+' | b'-')
        })
}

fn check_bindings(bindings: &BTreeMap<String, String>) -> Result<()> {
    if bindings.len() > MAX_BINDINGS {
        bail!("MCP_INVALID: at most 64 memoryProjectBindings");
    }
    let mut seen = HashSet::new();
    for (identity, central_project) in bindings {
        if identity.len() > MAX_VALUE_BYTES || identity.chars().any(char::is_control) {
            bail!("MCP_INVALID: invalid memoryProjectBindings project identity");
        }
        // This helper only normalizes spelling; it never canonicalizes paths,
        // probes the filesystem, or resolves a remote project onto this device.
        let normalized = normalize_project_path(identity);
        let remote = normalized
            .strip_prefix(REMOTE_PROJECT_PREFIX)
            .is_some_and(|id| !id.trim().is_empty());
        let drive_absolute =
            drive_prefix(&normalized) && normalized.as_bytes().get(2) == Some(&b'/');
        if !remote && !normalized.starts_with('/') && !drive_absolute {
            bail!(
                "MCP_INVALID: memoryProjectBindings keys require a logical remote identity or absolute local path"
            );
        }
        let key = if drive_absolute {
            normalized.to_lowercase()
        } else {
            normalized
        };
        if !seen.insert(key) {
            bail!("MCP_INVALID: duplicate normalized memoryProjectBindings project identity");
        }
        if !valid_central_project(central_project) {
            bail!(
                "MCP_INVALID: memoryProjectBindings values require a central project key, not a filesystem path"
            );
        }
    }
    Ok(())
}
