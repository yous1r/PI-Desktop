//! Strict v1 input conversion. Auth and owner authority are absent from input.
use anyhow::{bail, Result};
use serde_json::{Map, Value};
use super::super::{identity::ExecutionTarget, limits, payload::{InterventionIntent, InterventionRequest}, state::StopScope};

pub(super) fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected object"))
}
pub(super) fn keys(value: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let object = object(value)?;
    if required.iter().any(|key| !object.contains_key(*key)) || object.keys().any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str())) {
        bail!("CC_INVALID_ARGUMENT: missing or unknown field");
    }
    Ok(())
}
pub(super) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected string"))
}
pub(super) fn integer(value: &Value, key: &str, minimum: i64) -> Result<i64> {
    let number = value.get(key).and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected integer"))?;
    limits::validate_revision(number, minimum)?;
    Ok(number)
}
pub(super) fn boolean(value: &Value, key: &str) -> Result<bool> {
    value.get(key).and_then(Value::as_bool).ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected boolean"))
}
pub(super) fn uuid<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let text = string(value, key)?;
    limits::validate_uuid(text)?;
    Ok(text)
}
pub(super) fn canonical<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let text = string(value, key)?;
    limits::validate_canonical_id(text, key)?;
    Ok(text)
}
pub(super) fn label<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let text = string(value, key)?;
    limits::validate_label(text)?;
    Ok(text)
}
pub(super) fn target(value: &Value) -> Result<ExecutionTarget> {
    let result = match string(value, "kind")? {
        "session" => {
            keys(value, &["kind", "sessionId", "turnId"], &[])?;
            ExecutionTarget::session(canonical(value, "sessionId")?, canonical(value, "turnId")?)
        }
        "delegation" => {
            keys(value, &["kind", "parentSessionId", "parentTurnId", "delegationId", "executionGeneration"], &[])?;
            ExecutionTarget::delegation(canonical(value, "parentSessionId")?, canonical(value, "parentTurnId")?, canonical(value, "delegationId")?, integer(value, "executionGeneration", 1)?)
        }
        _ => bail!("CC_INVALID_ARGUMENT: unsupported target kind"),
    };
    result.validate()?;
    Ok(result)
}
pub(super) fn intervention(value: &Value) -> Result<InterventionRequest> {
    let intent = &value["intent"];
    let intent = match string(intent, "kind")? {
        "append" => { keys(intent, &["kind", "text"], &[])?; InterventionIntent::Append { text: string(intent, "text")?.to_owned() } }
        "steer" => { keys(intent, &["kind", "text"], &[])?; InterventionIntent::Steer { text: string(intent, "text")?.to_owned() } }
        "reviseGoal" => {
            keys(intent, &["kind", "objective", "constraints"], &[])?;
            let constraints = intent["constraints"].as_array().ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected constraints"))?;
            if constraints.len() > limits::MAX_CONSTRAINTS { bail!("CC_INVALID_ARGUMENT: too many constraints"); }
            let constraints = constraints.iter().map(|item| item.as_str().map(str::to_owned).ok_or_else(|| anyhow::anyhow!("CC_INVALID_ARGUMENT: expected constraint string"))).collect::<Result<Vec<_>>>()?;
            InterventionIntent::ReviseGoal { objective: string(intent, "objective")?.to_owned(), constraints }
        }
        "stop" => {
            keys(intent, &["kind", "scope"], &[])?;
            let scope = match string(intent, "scope")? { "target" => StopScope::Target, "subtree" => StopScope::Subtree, _ => bail!("CC_INVALID_ARGUMENT: unsupported stop scope") };
            InterventionIntent::Stop { scope }
        }
        _ => bail!("CC_INVALID_ARGUMENT: unsupported intervention"),
    };
    let mut required = vec!["version", "requestId", "hostId", "expectedHostEpoch", "commandWorkspaceId", "expectedMembershipRevision", "target", "intent"];
    let expected_goal_revision = if matches!(&intent, InterventionIntent::Stop { .. }) { None } else { required.push("expectedGoalRevision"); Some(integer(value, "expectedGoalRevision", 0)?) };
    keys(value, &required, &[])?;
    let request = InterventionRequest {
        version: 1, request_id: uuid(value, "requestId")?.to_owned(), host_id: string(value, "hostId")?.to_owned(),
        expected_host_epoch: uuid(value, "expectedHostEpoch")?.to_owned(), command_workspace_id: uuid(value, "commandWorkspaceId")?.to_owned(),
        expected_membership_revision: integer(value, "expectedMembershipRevision", 1)?, expected_goal_revision,
        target: target(&value["target"])? , intent,
    };
    request.validate()?;
    Ok(request)
}
pub(super) fn mutation(method: &str) -> bool {
    !["workspace.list", "workspace.get", "membership.get", "membership.list", "receipt.get", "receipt.list"].contains(&method)
}
pub(super) fn validate(method: &str, value: &Value) -> Result<()> {
    if serde_json::to_vec(value)?.len() > limits::MAX_REQUEST_BYTES { bail!("CC_INVALID_ARGUMENT: input exceeds byte budget"); }
    if integer(value, "version", 1)? != 1 { bail!("CC_INVALID_ARGUMENT: unsupported version"); }
    limits::validate_host_id(string(value, "hostId")?)?;
    if method == "intervention.record" { intervention(value)?; return Ok(()); }
    let mut required = vec!["version", "hostId"];
    let mut optional = vec![];
    if mutation(method) { required.push("expectedHostEpoch"); uuid(value, "expectedHostEpoch")?; }
    match method {
        "workspace.list" => {},
        "workspace.get" | "workspace.create" | "workspace.rename" | "workspace.setEnabled" | "workspace.delete" | "membership.list" | "membership.bind" | "membership.remove" => {
            required.push("commandWorkspaceId"); uuid(value, "commandWorkspaceId")?;
        }
        "membership.get" | "receipt.get" | "receipt.list" => {},
        _ => bail!("CC_INVALID_ARGUMENT: unsupported method"),
    }
    if ["workspace.rename", "workspace.setEnabled", "workspace.delete", "membership.remove"].contains(&method) { required.push("expectedRevision"); integer(value, "expectedRevision", 1)?; }
    if ["workspace.create", "workspace.rename"].contains(&method) { required.push("name"); label(value, "name")?; }
    if ["workspace.create", "workspace.setEnabled"].contains(&method) { required.push("enabled"); boolean(value, "enabled")?; }
    if ["membership.get", "membership.bind", "membership.remove"].contains(&method) { required.push("sessionId"); canonical(value, "sessionId")?; }
    if method == "membership.bind" {
        required.push("expectedRevision");
        if value.get("expectedRevision") != Some(&Value::Null) { integer(value, "expectedRevision", 1)?; }
    }
    if ["membership.list", "receipt.list"].contains(&method) {
        required.push("limit");
        if integer(value, "limit", 1)? > 100 { bail!("CC_INVALID_ARGUMENT: page too large"); }
    }
    if method == "membership.list" { optional.push("afterSessionId"); if value.get("afterSessionId").is_some() { canonical(value, "afterSessionId")?; } }
    if method == "receipt.get" { required.push("requestId"); uuid(value, "requestId")?; }
    if method == "receipt.list" { required.push("afterSequence"); integer(value, "afterSequence", 0)?; }
    keys(value, &required, &optional)
}
