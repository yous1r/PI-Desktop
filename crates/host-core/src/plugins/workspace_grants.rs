use super::*;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExecutionGrant {
    plugin_id: String,
    host_key: String,
    digest: String,
}

impl PluginManager {
    fn execution_grant(
        &self,
        plugin_id: &str,
        host_key: &str,
        digest: &str,
    ) -> Result<ExecutionGrant> {
        if plugin_id.is_empty()
            || plugin_id.len() > 128
            || host_key.is_empty()
            || host_key.len() > 256
            || host_key.chars().any(char::is_control)
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            bail!("invalid workspace execution grant");
        }
        let plugin = self
            .runtime
            .iter()
            .find(|plugin| plugin.id == plugin_id && plugin.enabled)
            .ok_or_else(|| anyhow!("plugin is not enabled"))?;
        let path = plugin
            .path
            .as_deref()
            .ok_or_else(|| anyhow!("plugin path is missing"))?;
        let manifest = Self::read_manifest(Path::new(path))?;
        let execution = manifest
            .execution
            .as_ref()
            .ok_or_else(|| anyhow!("workspace execution is not declared"))?;
        if execution.get("main").and_then(Value::as_str) != Some("workspace")
            && execution
                .get("workspaceMain")
                .and_then(Value::as_str)
                .is_none()
        {
            bail!("workspace execution is not declared");
        }
        Ok(ExecutionGrant {
            plugin_id: plugin_id.into(),
            host_key: host_key.into(),
            digest: digest.into(),
        })
    }

    fn execution_grants(&self) -> Result<Vec<ExecutionGrant>> {
        let path = self
            .data_dir
            .join("plugins/workspace-execution-grants.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(path)?;
        if bytes.len() > 1024 * 1024 {
            bail!("workspace execution grant store exceeds its limit");
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn workspace_execution_allowed(
        &self,
        plugin_id: &str,
        host_key: &str,
        digest: &str,
    ) -> Result<bool> {
        let grant = self.execution_grant(plugin_id, host_key, digest)?;
        Ok(self.execution_grants()?.contains(&grant))
    }

    pub fn set_workspace_execution(
        &self,
        plugin_id: &str,
        host_key: &str,
        digest: &str,
        allowed: bool,
    ) -> Result<()> {
        let grant = self.execution_grant(plugin_id, host_key, digest)?;
        let mut grants = self.execution_grants()?;
        grants.retain(|old| old.plugin_id != plugin_id || old.host_key != host_key);
        if allowed {
            grants.push(grant);
        }
        if grants.len() > 2000 {
            bail!("workspace execution grant limit reached");
        }
        let path = self
            .data_dir
            .join("plugins/workspace-execution-grants.json");
        fs::create_dir_all(self.data_dir.join("plugins"))?;
        // Rust owns this store, like the plugin registry. A failed write never authorizes execution.
        let temporary = self.data_dir.join(format!(
            "plugins/.workspace-execution-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        fs::write(&temporary, serde_json::to_vec_pretty(&grants)?)?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_grants_are_scoped_to_host_and_artifact() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let plugin = dir.path().join("fixture");
        fs::create_dir(&plugin)?;
        fs::write(
            plugin.join("manifest.json"),
            r#"{"schemaVersion":1,"id":"test.workspace","name":"Test","version":"1.0.0","main":"main.js","execution":{"main":"workspace"}}"#,
        )?;
        fs::write(plugin.join("main.js"), "module.exports = {};")?;
        let mut manager = PluginManager::new(dir.path(), MarketChannel::Official, None);
        manager.load_dev(&plugin.to_string_lossy())?;
        let digest = "a".repeat(64);
        assert!(!manager.workspace_execution_allowed("test.workspace", "host-a", &digest)?);
        manager.set_workspace_execution("test.workspace", "host-a", &digest, true)?;
        assert!(manager.workspace_execution_allowed("test.workspace", "host-a", &digest)?);
        assert!(!manager.workspace_execution_allowed("test.workspace", "host-b", &digest)?);
        assert!(!manager.workspace_execution_allowed(
            "test.workspace",
            "host-a",
            &"b".repeat(64)
        )?);
        manager.set_workspace_execution("test.workspace", "host-a", &digest, false)?;
        assert!(!manager.workspace_execution_allowed("test.workspace", "host-a", &digest)?);
        Ok(())
    }
}
