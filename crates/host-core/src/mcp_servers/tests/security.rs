use super::*;

// These public PEM fixtures exercise structure/base64 only. Main owns X.509 parsing.
const PUBLIC_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
const OTHER_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\nBAUG\n-----END CERTIFICATE-----\n";
const FIXTURE_CREDENTIAL_REF: &str = "secret:mcp:bearer:11111111-2222-4333-8444-555555555555";

fn http_config() -> McpConfig {
    McpConfig {
        id: "memory".into(),
        label: "Memory".into(),
        transport: "http".into(),
        url: Some("https://memory.example.test/mcp".into()),
        ..Default::default()
    }
}

fn http(id: &str, project: &Path) -> McpServerInput {
    McpServerInput {
        transport: Some("http".into()),
        url: Some("https://memory.example.test/mcp".into()),
        ..project_update(id, project)
    }
}

fn project_update(id: &str, project: &Path) -> McpServerInput {
    McpServerInput {
        id: id.into(),
        level: Some("project".into()),
        project_path: Some(project.to_str().unwrap().into()),
        ..Default::default()
    }
}

fn fixture_bindings() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "/fixture/nonexistent-project".into(),
            "org/project:main@work+1".into(),
        ),
        ("remote-project:fixture-id".into(), "org/remote".into()),
    ])
}

fn secured_http(id: &str, project: &Path) -> McpServerInput {
    McpServerInput {
        auth_type: Some(Some("bearer".into())),
        ca_certificate: Some(Some(PUBLIC_CA_PEM.into())),
        memory_project_bindings: Some(fixture_bindings()),
        ..http(id, project)
    }
}

fn bearer_config() -> McpConfig {
    McpConfig {
        auth_type: Some("bearer".into()),
        credential_ref: Some(FIXTURE_CREDENTIAL_REF.into()),
        ..http_config()
    }
}

#[test]
fn nullable_http_security_overrides_distinguish_absence_null_and_values() {
    let missing: McpServerInput =
        serde_json::from_value(serde_json::json!({ "id": "memory" })).unwrap();
    assert_eq!(missing.auth_type, None);
    assert_eq!(missing.ca_certificate, None);
    assert_eq!(missing.memory_project_bindings, None);

    let clear: McpServerInput = serde_json::from_value(serde_json::json!({
        "id": "memory", "authType": null, "caCertificate": null, "memoryProjectBindings": {}
    }))
    .unwrap();
    assert_eq!(clear.auth_type, Some(None));
    assert_eq!(clear.ca_certificate, Some(None));
    assert_eq!(clear.memory_project_bindings, Some(BTreeMap::new()));

    let supplied: McpServerInput = serde_json::from_value(serde_json::json!({
        "id": "memory", "authType": "bearer", "caCertificate": PUBLIC_CA_PEM,
        "memoryProjectBindings": { "remote-project:fixture-id": "org/remote" }
    }))
    .unwrap();
    assert_eq!(supplied.auth_type, Some(Some("bearer".into())));
    assert_eq!(supplied.ca_certificate, Some(Some(PUBLIC_CA_PEM.into())));
    assert_eq!(
        supplied.memory_project_bindings.unwrap()["remote-project:fixture-id"],
        "org/remote"
    );
}

#[test]
fn http_security_round_trips_through_registry_and_persistence_without_tokens() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let mut registry = McpServerRegistry::new(app.path());
    let saved = registry
        .upsert(secured_http("memory", project.path()))
        .unwrap();
    let reference = saved.credential_ref.as_deref().unwrap();
    assert!(crate::mcp_servers::security::valid_credential_ref(
        reference
    ));
    assert_eq!(saved.auth_type.as_deref(), Some("bearer"));
    assert_eq!(saved.ca_certificate.as_deref(), Some(PUBLIC_CA_PEM));
    assert_eq!(saved.memory_project_bindings, fixture_bindings());

    let document = fs::read_to_string(saved.path.as_deref().unwrap()).unwrap();
    let config: McpConfig = serde_json::from_str(&document).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&document).unwrap();
    assert_eq!(serde_json::to_value(config).unwrap(), raw);
    assert_eq!(raw["authType"], "bearer");
    assert_eq!(raw["credentialRef"], reference);
    assert_eq!(raw["caCertificate"], PUBLIC_CA_PEM);
    assert_eq!(
        raw["memoryProjectBindings"]["remote-project:fixture-id"],
        "org/remote"
    );
    for field in ["bearerToken", "token", "hasBearerToken", "enabled", "scope"] {
        assert!(
            raw.get(field).is_none(),
            "persisted unexpected field {field}"
        );
    }
    let public = serde_json::to_value(&saved).unwrap();
    for field in ["bearerToken", "token", "hasBearerToken"] {
        assert!(
            public.get(field).is_none(),
            "returned unexpected field {field}"
        );
    }

    let mut restarted = McpServerRegistry::new(app.path());
    let listed = restarted
        .list(CapabilityLevel::Project, project.path().to_str())
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].credential_ref, saved.credential_ref);
    assert_eq!(listed[0].ca_certificate, saved.ca_certificate);
    assert_eq!(
        listed[0].memory_project_bindings,
        saved.memory_project_bindings
    );
}

#[test]
fn updates_preserve_replace_and_clear_http_security_settings() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let mut registry = McpServerRegistry::new(app.path());
    let initial = registry
        .upsert(secured_http("memory", project.path()))
        .unwrap();
    let preserved = registry
        .upsert(project_update("memory", project.path()))
        .unwrap();
    assert_eq!(preserved.auth_type, initial.auth_type);
    assert_eq!(preserved.credential_ref, initial.credential_ref);
    assert_eq!(preserved.ca_certificate, initial.ca_certificate);
    assert_eq!(
        preserved.memory_project_bindings,
        initial.memory_project_bindings
    );

    let mut replacement = project_update("memory", project.path());
    replacement.auth_type = Some(Some("bearer".into()));
    replacement.ca_certificate = Some(Some(OTHER_CA_PEM.into()));
    replacement.memory_project_bindings = Some(BTreeMap::from([(
        "remote-project:new-id".into(),
        "org/new-project".into(),
    )]));
    let updated = registry.upsert(replacement).unwrap();
    assert_eq!(updated.credential_ref, initial.credential_ref);
    assert_eq!(updated.ca_certificate.as_deref(), Some(OTHER_CA_PEM));
    assert_eq!(updated.memory_project_bindings.len(), 1);
    assert_eq!(
        updated.memory_project_bindings["remote-project:new-id"],
        "org/new-project"
    );

    let clear: McpServerInput = serde_json::from_value(serde_json::json!({
        "id": "memory", "level": "project", "projectPath": project.path().to_str().unwrap(),
        "authType": null, "caCertificate": null, "memoryProjectBindings": {}
    }))
    .unwrap();
    let cleared = registry.upsert(clear).unwrap();
    assert_eq!(cleared.auth_type, None);
    assert_eq!(cleared.credential_ref, None);
    assert_eq!(cleared.ca_certificate, None);
    assert!(cleared.memory_project_bindings.is_empty());
    for raw in [
        serde_json::to_value(&cleared).unwrap(),
        serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(cleared.path.as_deref().unwrap()).unwrap(),
        )
        .unwrap(),
    ] {
        for field in [
            "authType",
            "credentialRef",
            "caCertificate",
            "memoryProjectBindings",
        ] {
            assert!(
                raw.get(field).is_none(),
                "cleared field {field} was not omitted"
            );
        }
    }

    let mut enable_again = project_update("memory", project.path());
    enable_again.auth_type = Some(Some("bearer".into()));
    let enabled = registry.upsert(enable_again).unwrap();
    assert!(crate::mcp_servers::security::valid_credential_ref(
        enabled.credential_ref.as_deref().unwrap()
    ));
    assert_ne!(enabled.credential_ref, initial.credential_ref);
}

#[test]
fn caller_selected_credential_references_and_raw_tokens_never_enter_the_registry() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let mut registry = McpServerRegistry::new(app.path());
    let input: McpServerInput = serde_json::from_value(serde_json::json!({
        "id": "memory", "level": "project", "projectPath": project.path().to_str().unwrap(),
        "transport": "http", "url": "https://memory.example.test/mcp", "authType": "bearer",
        "credentialRef": FIXTURE_CREDENTIAL_REF, "bearerToken": "synthetic-token-never-persist"
    }))
    .unwrap();
    let saved = registry.upsert(input).unwrap();
    assert!(crate::mcp_servers::security::valid_credential_ref(
        saved.credential_ref.as_deref().unwrap()
    ));
    assert_ne!(
        saved.credential_ref.as_deref(),
        Some(FIXTURE_CREDENTIAL_REF)
    );

    let update: McpServerInput = serde_json::from_value(serde_json::json!({
        "id": "memory", "level": "project", "projectPath": project.path().to_str().unwrap(),
        "credentialRef": "secret:provider:forged-selection", "bearerToken": "another-synthetic-token"
    })).unwrap();
    let preserved = registry.upsert(update).unwrap();
    assert_eq!(preserved.credential_ref, saved.credential_ref);
    for raw in [
        fs::read_to_string(preserved.path.as_deref().unwrap()).unwrap(),
        serde_json::to_string(&preserved).unwrap(),
    ] {
        assert!(!raw.contains("bearerToken"));
        assert!(!raw.contains("synthetic-token"));
        assert!(!raw.contains("forged-selection"));
        assert!(!raw.contains(FIXTURE_CREDENTIAL_REF));
    }
}

#[test]
fn bearer_references_require_the_exact_namespace_and_canonical_uuid() {
    let mut config = bearer_config();
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    for reference in [
        "secret:provider:11111111-2222-4333-8444-555555555555",
        "secret:mcp:basic:11111111-2222-4333-8444-555555555555",
        "secret:mcp:bearer:ABCDEFAB-2222-4333-8444-555555555555",
        "secret:mcp:bearer:{11111111-2222-4333-8444-555555555555}",
        "secret:mcp:bearer:11111111222243338444555555555555",
        "secret:mcp:bearer:not-a-uuid",
        "secret:mcp:bearer:11111111-2222-4333-8444-555555555555:extra",
    ] {
        config.credential_ref = Some(reference.into());
        let error = McpServerRegistry::validate_config(&config)
            .unwrap_err()
            .to_string();
        assert!(error.contains("MCP_INVALID"));
        assert!(!error.contains(reference));
    }
    config.credential_ref = None;
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.credential_ref = Some(FIXTURE_CREDENTIAL_REF.into());
    config.auth_type = None;
    assert!(McpServerRegistry::validate_config(&config).is_err());
    for auth_type in ["basic", "Bearer", " bearer", ""] {
        config.auth_type = Some(auth_type.into());
        assert!(McpServerRegistry::validate_config(&config).is_err());
    }
}

#[test]
fn managed_bearer_only_accepts_https_or_literal_strict_loopback_http() {
    let mut config = bearer_config();
    for url in [
        "https://memory.example.test/mcp",
        "http://localhost:3000/mcp",
        "http://LOCALHOST/mcp",
        "http://127.0.0.1:3000/mcp",
        "http://[::1]:3000/mcp",
    ] {
        config.url = Some(url.into());
        assert!(
            McpServerRegistry::validate_config(&config).is_ok(),
            "rejected {url}"
        );
    }
    for url in [
        "http://192.168.1.20/mcp",
        "http://memory.example.test/mcp",
        "http://127.0.0.2/mcp",
        "http://127.1/mcp",
        "http://2130706433/mcp",
        "http://0x7f000001/mcp",
        "http://%6cocalhost/mcp",
        "http://localhost./mcp",
        "http://localhost.example.test/mcp",
        "http://[::ffff:127.0.0.1]/mcp",
        "http://[0:0:0:0:0:0:0:1]/mcp",
        "ftp://memory.example.test/mcp",
        "http://127.0.0.1\\@memory.example.test/mcp",
    ] {
        config.url = Some(url.into());
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted {url}"
        );
    }
}

#[test]
fn managed_bearer_rejects_url_credentials_queries_fragments_and_raw_authorization() {
    let mut config = bearer_config();
    for url in [
        "https://user@memory.example.test/mcp",
        "https://user:password@memory.example.test/mcp",
        "https://@memory.example.test/mcp",
        "https://memory.example.test/mcp?token=synthetic",
        "https://memory.example.test/mcp?",
        "https://memory.example.test/mcp#fragment",
        "https://memory.example.test/mcp#",
        "https://memory.example.test/mcp\n",
        "https://memory.example.test\\mcp",
        "https:memory.example.test/mcp",
        "https:///mcp",
        "https://memory.example.test:invalid/mcp",
    ] {
        config.url = Some(url.into());
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted {url}"
        );
    }
    config.url = Some("https://memory.example.test/mcp".into());
    for key in [
        "Authorization",
        "authorization",
        "AUTHORIZATION",
        "aUtHoRiZaTiOn",
    ] {
        config.headers = BTreeMap::from([(key.into(), "synthetic-header".into())]);
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted {key}"
        );
    }
    config.headers = BTreeMap::from([("X-Project".into(), "fixture".into())]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn custom_ca_requires_https_and_bounded_public_certificate_pem_only() {
    let mut config = http_config();
    config.ca_certificate = Some(PUBLIC_CA_PEM.into());
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.ca_certificate = Some(format!("{PUBLIC_CA_PEM}{OTHER_CA_PEM}"));
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.url = Some("http://localhost:3000/mcp".into());
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.url = Some("https://memory.example.test/mcp".into());
    for pem in [
        "",
        "/fixture/ca.pem",
        "not a certificate",
        "-----BEGIN CERTIFICATE-----\nAQID\n",
        "-----BEGIN CERTIFICATE-----\nnot-base64!\n-----END CERTIFICATE-----\n",
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n",
        "-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----\n",
        "-----BEGIN EC PRIVATE KEY-----\nAQID\n-----END EC PRIVATE KEY-----\n",
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAQID\n-----END ENCRYPTED PRIVATE KEY-----\n",
    ] {
        config.ca_certificate = Some(pem.into());
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted invalid PEM fixture"
        );
    }
    config.ca_certificate = Some(format!(
        "{PUBLIC_CA_PEM}-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n"
    ));
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.ca_certificate = Some(format!("{PUBLIC_CA_PEM}extra text"));
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.ca_certificate = Some(format!(
        "{PUBLIC_CA_PEM}{}",
        " ".repeat(64 * 1024 - PUBLIC_CA_PEM.len())
    ));
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.ca_certificate.as_mut().unwrap().push(' ');
    assert!(McpServerRegistry::validate_config(&config).is_err());
}

#[test]
fn bindings_accept_logical_remote_identities_and_unprobed_absolute_local_paths() {
    let mut config = http_config();
    config.memory_project_bindings = BTreeMap::from([
        ("remote-project:fixture-id".into(), "org/remote:main".into()),
        (
            "/fixture/nonexistent/project".into(),
            "org/project@work+1".into(),
        ),
        (
            "C:\\fixture\\nonexistent-project".into(),
            "central-project_1.2".into(),
        ),
        (
            "\\\\fixture-server\\share\\project".into(),
            "org/share".into(),
        ),
    ]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    let project = tempdir().unwrap();
    let file = project.path().join("not-a-directory");
    fs::write(&file, "synthetic fixture").unwrap();
    config.memory_project_bindings =
        BTreeMap::from([(file.to_str().unwrap().into(), "org/logical-identity".into())]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn bindings_reject_invalid_keys_central_paths_and_entry_or_byte_limits() {
    let mut config = http_config();
    for key in [
        "",
        " ",
        "relative/path",
        "C:relative",
        "remote-project:",
        "remote-project: ",
        "/fixture/\nproject",
        "/fixture/\0project",
    ] {
        config.memory_project_bindings = BTreeMap::from([(key.into(), "org/project".into())]);
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted invalid identity"
        );
    }
    for value in [
        "",
        "/absolute/project",
        "C:/project",
        "C:relative",
        "\\\\server\\share",
        ".project",
        "-project",
        "project with space",
        "project\nkey",
        "项目",
    ] {
        config.memory_project_bindings =
            BTreeMap::from([("/fixture/project".into(), value.into())]);
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted invalid central project"
        );
    }
    let longest_key = format!("/{}", "p".repeat(4095));
    let longest_value = "p".repeat(256);
    config.memory_project_bindings = BTreeMap::from([(longest_key.clone(), longest_value.clone())]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.memory_project_bindings =
        BTreeMap::from([(format!("{longest_key}p"), "org/project".into())]);
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.memory_project_bindings =
        BTreeMap::from([("/fixture/project".into(), format!("{longest_value}p"))]);
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.memory_project_bindings = (0..64)
        .map(|index| (format!("/fixture/{index}"), format!("org/project-{index}")))
        .collect();
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config
        .memory_project_bindings
        .insert("/fixture/64".into(), "org/project-64".into());
    assert!(McpServerRegistry::validate_config(&config).is_err());
}

#[test]
fn bindings_reject_duplicate_normalized_identities_without_probing_paths() {
    let mut config = http_config();
    for (first, second) in [
        ("/fixture/project", "/fixture/project/"),
        (" /fixture/project ", "/fixture/project"),
        ("C:\\Fixture\\Project\\", "c:/fixture/project"),
        ("\\\\?\\C:\\Fixture\\Project", "C:/Fixture/Project"),
        ("remote-project:fixture-id", " remote-project:fixture-id "),
    ] {
        config.memory_project_bindings = BTreeMap::from([
            (first.into(), "org/first".into()),
            (second.into(), "org/second".into()),
        ]);
        assert!(
            McpServerRegistry::validate_config(&config).is_err(),
            "accepted duplicate identities"
        );
    }
    config.memory_project_bindings = BTreeMap::from([
        ("/fixture/Project".into(), "org/first".into()),
        ("/fixture/project".into(), "org/second".into()),
        ("remote-project:Case".into(), "org/remote-first".into()),
        ("remote-project:case".into(), "org/remote-second".into()),
    ]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn unmanaged_http_preserves_existing_lan_and_header_behavior() {
    let mut config = http_config();
    config.url = Some("http://192.168.1.20:8080/mcp".into());
    config.headers = BTreeMap::from([("Authorization".into(), "legacy-synthetic-header".into())]);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.memory_project_bindings = fixture_bindings();
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.memory_project_bindings.clear();
    config.url = Some("http://user@192.168.1.20/mcp?legacy=fixture#legacy".into());
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn switching_to_stdio_clears_http_security_and_rejects_explicit_nonnull_settings() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let mut registry = McpServerRegistry::new(app.path());
    let original = registry
        .upsert(secured_http("memory", project.path()))
        .unwrap();
    let path = original.path.as_deref().unwrap();
    let before = fs::read_to_string(path).unwrap();
    let mut switch = stdio("memory");
    switch.level = Some("project".into());
    switch.project_path = Some(project.path().to_str().unwrap().into());
    let mut auth = switch.clone();
    auth.auth_type = Some(Some("bearer".into()));
    let mut ca = switch.clone();
    ca.ca_certificate = Some(Some(PUBLIC_CA_PEM.into()));
    let mut bindings = switch.clone();
    bindings.memory_project_bindings = Some(fixture_bindings());
    for input in [auth, ca, bindings] {
        assert!(registry.upsert(input).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), before);
    }
    let switched = registry.upsert(switch).unwrap();
    assert_eq!(switched.transport, "stdio");
    assert_eq!(switched.url, None);
    assert!(switched.headers.is_empty());
    assert_eq!(switched.auth_type, None);
    assert_eq!(switched.credential_ref, None);
    assert_eq!(switched.ca_certificate, None);
    assert!(switched.memory_project_bindings.is_empty());

    let mut clear = project_update("memory", project.path());
    clear.auth_type = Some(None);
    clear.ca_certificate = Some(None);
    clear.memory_project_bindings = Some(BTreeMap::new());
    assert!(registry.upsert(clear).is_ok());
    let back_to_http = registry.upsert(http("memory", project.path())).unwrap();
    assert_eq!(back_to_http.auth_type, None);
    assert_eq!(back_to_http.credential_ref, None);
    assert_eq!(back_to_http.ca_certificate, None);
    assert!(back_to_http.memory_project_bindings.is_empty());
}

#[test]
fn invalid_security_updates_do_not_overwrite_the_existing_document() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let mut registry = McpServerRegistry::new(app.path());
    let original = registry
        .upsert(secured_http("memory", project.path()))
        .unwrap();
    let before = fs::read_to_string(original.path.as_deref().unwrap()).unwrap();
    let mut auth = project_update("memory", project.path());
    auth.auth_type = Some(Some("basic".into()));
    let mut url = project_update("memory", project.path());
    url.url = Some("http://192.168.1.20/mcp".into());
    let mut headers = project_update("memory", project.path());
    headers.headers = Some(BTreeMap::from([(
        "aUtHoRiZaTiOn".into(),
        "synthetic-header".into(),
    )]));
    let mut ca = project_update("memory", project.path());
    ca.ca_certificate = Some(Some(
        "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n".into(),
    ));
    let mut bindings = project_update("memory", project.path());
    bindings.memory_project_bindings = Some(BTreeMap::from([(
        "/fixture/project".into(),
        "C:/not-central".into(),
    )]));
    for input in [auth, url, headers, ca, bindings] {
        let error = registry.upsert(input).unwrap_err();
        assert!(error.to_string().contains("MCP_INVALID"));
        assert_eq!(
            fs::read_to_string(original.path.as_deref().unwrap()).unwrap(),
            before
        );
    }
}

#[test]
fn scans_skip_forged_references_and_invalid_new_security_but_keep_legacy_servers() {
    let (home, app, project) = scaffolding();
    test_support::with_global_agents(home.path(), || {
        let directory = project.path().join(".agents/servers");
        fs::create_dir_all(&directory).unwrap();
        let mut valid = bearer_config();
        valid.ca_certificate = Some(PUBLIC_CA_PEM.into());
        valid.memory_project_bindings = fixture_bindings();
        fs::write(
            directory.join("zz-valid.json"),
            serde_json::to_string(&valid).unwrap(),
        )
        .unwrap();
        let mut legacy = http_config();
        legacy.id = "legacy-http".into();
        legacy.url = Some("http://192.168.1.20/mcp".into());
        legacy.label = "Legacy HTTP".into();
        legacy.headers =
            BTreeMap::from([("Authorization".into(), "legacy-synthetic-header".into())]);
        fs::write(
            directory.join("legacy-http.json"),
            serde_json::to_string(&legacy).unwrap(),
        )
        .unwrap();
        let stdio = McpConfig {
            id: "legacy-stdio".into(),
            label: "Stdio".into(),
            transport: "stdio".into(),
            command: Some("node".into()),
            ..Default::default()
        };
        fs::write(
            directory.join("legacy-stdio.json"),
            serde_json::to_string(&stdio).unwrap(),
        )
        .unwrap();
        for (name, overrides) in [
            (
                "00-forged",
                serde_json::json!({ "id": "memory", "credentialRef": "secret:provider:arbitrary-secret" }),
            ),
            ("unbound-ref", serde_json::json!({ "authType": null })),
            (
                "bad-uuid",
                serde_json::json!({ "credentialRef": "secret:mcp:bearer:not-a-uuid" }),
            ),
            ("bad-auth", serde_json::json!({ "authType": "basic" })),
            (
                "unsafe-http",
                serde_json::json!({ "url": "http://192.168.1.20/mcp" }),
            ),
            (
                "url-credentials",
                serde_json::json!({ "url": "https://user@memory.example.test/mcp" }),
            ),
            (
                "url-query",
                serde_json::json!({ "url": "https://memory.example.test/mcp?credential=synthetic" }),
            ),
            (
                "raw-header",
                serde_json::json!({ "headers": { "aUtHoRiZaTiOn": "synthetic-header" } }),
            ),
            (
                "private-ca",
                serde_json::json!({ "caCertificate": "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n" }),
            ),
            (
                "bad-bindings",
                serde_json::json!({ "memoryProjectBindings": { "relative/project": "org/project" } }),
            ),
            (
                "stdio-security",
                serde_json::json!({ "transport": "stdio", "url": null, "command": "node" }),
            ),
        ] {
            let mut raw = serde_json::to_value(&valid).unwrap();
            raw["id"] = serde_json::json!(name);
            raw.as_object_mut()
                .unwrap()
                .extend(overrides.as_object().unwrap().clone());
            fs::write(
                directory.join(format!("{name}.json")),
                serde_json::to_string(&raw).unwrap(),
            )
            .unwrap();
        }
        let mut registry = McpServerRegistry::new(app.path());
        let listed = registry
            .list(CapabilityLevel::Project, project.path().to_str())
            .unwrap();
        let ids = listed
            .iter()
            .map(|record| record.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            ids,
            HashSet::from(["memory", "legacy-http", "legacy-stdio"])
        );
        assert_eq!(
            listed
                .iter()
                .find(|record| record.id == "memory")
                .unwrap()
                .credential_ref
                .as_deref(),
            Some(FIXTURE_CREDENTIAL_REF)
        );
        assert!(!serde_json::to_string(&listed)
            .unwrap()
            .contains("arbitrary-secret"));
        let active = registry.active_for(project.path().to_str()).unwrap();
        assert_eq!(active.len(), 3);
    });
}

#[test]
fn transfer_collision_keeps_the_opaque_reference_ca_and_remote_bindings_unchanged() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut source = secured_http("memory", project.path());
        source.level = Some("global".into());
        source.project_path = None;
        source.label = Some("Memory".into());
        let saved = registry.upsert(source).unwrap();
        let mut destination = stdio("memory");
        destination.label = Some("Memory".into());
        destination.level = Some("project".into());
        destination.project_path = Some(project_path.clone());
        let existing = registry.upsert(destination).unwrap();
        let existing_raw = fs::read_to_string(existing.path.as_deref().unwrap()).unwrap();
        let moved = registry
            .transfer(
                "memory",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();
        assert_eq!(moved.id, "memory-2");
        assert_eq!(moved.label, "Memory (2)");
        assert_eq!(moved.auth_type, saved.auth_type);
        assert_eq!(moved.credential_ref, saved.credential_ref);
        assert_eq!(moved.ca_certificate, saved.ca_certificate);
        assert_eq!(moved.memory_project_bindings, saved.memory_project_bindings);
        assert!(!Path::new(saved.path.as_deref().unwrap()).exists());
        assert_eq!(
            fs::read_to_string(existing.path.as_deref().unwrap()).unwrap(),
            existing_raw
        );
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(moved.path.as_deref().unwrap()).unwrap())
                .unwrap();
        assert_eq!(
            raw["credentialRef"],
            saved.credential_ref.as_deref().unwrap()
        );
        assert_eq!(raw["caCertificate"], PUBLIC_CA_PEM);
        assert_eq!(
            raw["memoryProjectBindings"]["remote-project:fixture-id"],
            "org/remote"
        );
        assert!(raw.get("bearerToken").is_none());
        let mut restarted = McpServerRegistry::new(app.path());
        let listed = restarted
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        let arrived = listed
            .iter()
            .find(|record| record.id == "memory-2")
            .unwrap();
        assert_eq!(arrived.credential_ref, saved.credential_ref);
        assert_eq!(arrived.ca_certificate, saved.ca_certificate);
        assert_eq!(
            arrived.memory_project_bindings,
            saved.memory_project_bindings
        );
    });
}
