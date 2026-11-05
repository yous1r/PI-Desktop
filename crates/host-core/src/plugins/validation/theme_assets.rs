/// Extensions a theme may reference from its own package or an absolute path (ADR 0288).
const THEME_ASSET_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "avif", "svg", "woff2"];

/// Declared assets of one theme, summed.
pub(super) const THEME_ASSET_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Mirrors `normalizeThemeAssetPath` in the plugin SDK: a normalized package-relative
/// or absolute path on the extension whitelist, or `None`.
///
/// Absolute paths and `file:` spellings keep their existing handling. Relative
/// paths are resolved under the plugin root by the caller.
pub(super) fn normalize_theme_asset_path(value: &str) -> Option<String> {
    let raw = value.trim();
    let file_url_path = if raw
        .get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://"))
    {
        Some(&raw[7..])
    } else if raw
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
    {
        Some(&raw[5..])
    } else {
        None
    };
    let without_scheme = match file_url_path {
        Some(path) => decode_theme_file_url_path(path)?,
        None => raw.to_string(),
    };
    let normalized = without_scheme.replace('\\', "/");
    // `file:///C:/art/bg.png` and `file:///art/bg.png` both lose the extra slash
    // the authority marker leaves behind; a drive letter is written without it.
    let mut path = match normalized.strip_prefix('/') {
        Some(rest) if is_windows_drive_path(rest) => rest.to_string(),
        _ => normalized,
    };
    if !is_absolute_theme_asset_path(&path) {
        path = path.strip_prefix("./").unwrap_or(&path).to_string();
        if path.contains(':')
            || path.split('/').any(|segment| {
                segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.eq_ignore_ascii_case("node_modules")
            })
        {
            return None;
        }
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    if !THEME_ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(path)
}

fn decode_theme_file_url_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = theme_asset_hex_value(*bytes.get(index + 1)?)?;
            let low = theme_asset_hex_value(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn theme_asset_hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `C:/…` — a Windows drive path after forward-slash normalization.
fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// A POSIX absolute path or a Windows drive path.
pub(super) fn is_absolute_theme_asset_path(value: &str) -> bool {
    value.starts_with('/') || is_windows_drive_path(value)
}

/// Mirrors `WINDOW_BACKGROUND_COLOR_PATTERN` in the plugin SDK.
pub(super) fn is_window_background_color(value: &str) -> bool {
    let digits = value.strip_prefix('#').unwrap_or("");
    if digits.len() != 6 && digits.len() != 8 {
        return false;
    }
    digits
        .chars()
        .all(|character| character.is_ascii_hexdigit())
}
