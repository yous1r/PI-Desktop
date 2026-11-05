use super::*;

/// Backend location is metadata, not permission to execute on a paired Host.
pub(super) fn validate_execution(root: &Path, raw: Option<&Value>, main: &str) -> Result<()> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: execution must be an object"))?;
    if object
        .keys()
        .any(|key| key != "main" && key != "workspaceMain")
    {
        bail!("PLUGIN_INVALID: unsupported execution field");
    }
    let placement = object.get("main").and_then(Value::as_str);
    if !matches!(placement, Some("desktop" | "workspace")) {
        bail!("PLUGIN_INVALID: execution.main must be desktop or workspace");
    }
    let companion = object.get("workspaceMain");
    if companion.is_some() && placement != Some("desktop") {
        bail!("PLUGIN_INVALID: execution.workspaceMain requires desktop main");
    }
    let entry = if let Some(value) = companion {
        let entry = value.as_str().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: execution.workspaceMain must be a relative JavaScript file")
        })?;
        if !(entry.ends_with(".js") || entry.ends_with(".cjs") || entry.ends_with(".mjs")) {
            bail!("PLUGIN_INVALID: execution.workspaceMain must be a JavaScript entry");
        }
        Some(entry)
    } else if placement == Some("workspace") {
        Some(main)
    } else {
        None
    };
    if let Some(entry) = entry {
        let normalized = entry.replace('\\', "/");
        if entry.trim().is_empty()
            || entry != entry.trim()
            || entry.chars().any(char::is_control)
            || normalized.starts_with('/')
            || normalized.as_bytes().get(1) == Some(&b':')
            || normalized
                .split('/')
                .any(|part| part.is_empty() || part == "..")
        {
            bail!("PLUGIN_INVALID: workspace entry must stay inside the plugin");
        }
        let resolved = root
            .join(&normalized)
            .canonicalize()
            .map_err(|_| anyhow!("PLUGIN_INVALID: workspace entry missing"))?;
        let canonical_root = root.canonicalize()?;
        if !resolved.is_file() || !resolved.starts_with(&canonical_root) {
            bail!("PLUGIN_INVALID: workspace entry must be a file inside the plugin");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn old_desktop_and_workspace_declarations_are_distinct() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("main.js"), "module.exports = {};").unwrap();
        assert!(validate_execution(root.path(), None, "main.js").is_ok());
        assert!(
            validate_execution(root.path(), Some(&json!({"main":"desktop"})), "main.js").is_ok()
        );
        assert!(
            validate_execution(root.path(), Some(&json!({"main":"workspace"})), "main.js").is_ok()
        );
        let companion = json!({"main":"desktop", "workspaceMain":"remote.cjs"});
        assert!(validate_execution(root.path(), Some(&companion), "main.js").is_err());
        fs::write(root.path().join("remote.cjs"), "module.exports = {};").unwrap();
        assert!(validate_execution(root.path(), Some(&companion), "main.js").is_ok());
    }

    #[test]
    fn invalid_workspace_declarations_fail_before_execution() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("main.js"), "module.exports = {};").unwrap();
        for value in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"main":"remote"}),
            json!({"main":"workspace","extra":true}),
            json!({"main":"workspace","workspaceMain":"main.js"}),
        ] {
            assert!(
                validate_execution(root.path(), Some(&value), "main.js").is_err(),
                "{value}"
            );
        }
        for entry in [
            "../main.js",
            "/main.js",
            "C:/main.js",
            "C:main.js",
            "nested/../../main.js",
            "",
            "main.js\0",
            " main.js",
            "main.ts",
            "nested//main.js",
        ] {
            let value = json!({"main":"desktop","workspaceMain":entry});
            assert!(
                validate_execution(root.path(), Some(&value), "main.js").is_err(),
                "{entry}"
            );
        }
    }
}

/// Desktop model/device integrations must not inherit workspace native placement.
pub(super) fn validate_desktop_contributions(document: &Value) -> Result<()> {
    if document.pointer("/execution/main").and_then(Value::as_str) != Some("workspace") {
        return Ok(());
    }
    let declarations = ["providers", "composerTransforms", "agentExtensions"];
    let desktop = document.get("renderer").is_some()
        || declarations.iter().any(|name| {
            document
                .get("contributes")
                .and_then(|v| v.get(name))
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
        })
        || document
            .get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    matches!(
                        item.as_str(),
                        Some(
                            "provider.register"
                                | "provider.oauth"
                                | "speech.provider"
                                | "renderer.extension"
                                | "composer.transform"
                                | "audio.capture.background"
                                | "audio.playback.background"
                        )
                    )
                })
            });
    if desktop {
        bail!("PLUGIN_INVALID: model, device, Agent extension and renderer contributions require a desktop main; use a workspace companion");
    }
    Ok(())
}

#[cfg(test)]
mod desktop_placement_tests {
    use super::*;
    #[test]
    fn workspace_model_and_device_contributions_require_desktop_main() {
        for permission in [
            "provider.register",
            "provider.oauth",
            "speech.provider",
            "renderer.extension",
            "composer.transform",
            "audio.capture.background",
            "audio.playback.background",
        ] {
            let mut document =
                json!({"execution":{"main":"workspace"}, "permissions":[permission]});
            assert!(validate_desktop_contributions(&document).is_err());
            document["execution"] = json!({"main":"desktop","workspaceMain":"worker.js"});
            assert!(validate_desktop_contributions(&document).is_ok());
        }
        assert!(validate_desktop_contributions(&json!({"execution":{"main":"workspace"},"contributes":{"agentExtensions":["extension.js"]}})).is_err());
    }
}
