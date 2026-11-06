use anyhow::{bail, Context, Result};
use serde::{Deserialize, Deserializer};

pub(super) fn deserialize_ca_override<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub(super) fn validate_ca(pem: &str, transport: &str, url: Option<&str>) -> Result<()> {
    if transport != "http"
        || reqwest::Url::parse(url.unwrap_or_default())
            .map(|value| value.scheme() != "https")
            .unwrap_or(true)
    {
        bail!("MCP_INVALID: caCertificate requires HTTPS");
    }
    if pem.len() > 64 * 1024 || pem.trim().is_empty() {
        bail!("MCP_INVALID: caCertificate must be a public PEM bundle of at most 64 KiB");
    }
    let mut rest = pem.trim();
    let mut count = 0;
    while !rest.is_empty() {
        if !rest.starts_with("-----BEGIN CERTIFICATE-----") {
            bail!("MCP_INVALID: caCertificate must contain public certificates only");
        }
        let end = rest
            .find("-----END CERTIFICATE-----")
            .context("MCP_INVALID: incomplete CA certificate")?
            + "-----END CERTIFICATE-----".len();
        reqwest::Certificate::from_pem(rest[..end].as_bytes())
            .context("MCP_INVALID: invalid CA certificate")?;
        count += 1;
        if count > 16 {
            bail!("MCP_INVALID: at most 16 CA certificates");
        }
        rest = rest[end..].trim();
    }
    Ok(())
}
