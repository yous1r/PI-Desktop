//! Bounded local owner discovery protocol. Mutating transfer operations are not advertised.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    pub operation: Operation,
    pub expected_owner_epoch: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Status,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerStatus {
    pub owner_epoch: String,
    pub profile_id: String,
    pub process_id: u32,
    pub process_created_at: String,
    pub operations: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub version: u32,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<OwnerStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Failure>,
}

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    UnsupportedVersion,
    StaleOwner,
    InvalidRequest,
}

impl Request {
    pub fn status(expected_owner_epoch: Option<String>) -> Self {
        Self {
            version: VERSION,
            request_id: uuid::Uuid::new_v4().to_string(),
            operation: Operation::Status,
            expected_owner_epoch,
        }
    }
}

pub fn respond(request: Request, owner: &OwnerStatus) -> Response {
    let error = if uuid::Uuid::parse_str(&request.request_id).is_err() {
        Some(Failure::InvalidRequest)
    } else if request.version != VERSION {
        Some(Failure::UnsupportedVersion)
    } else if request
        .expected_owner_epoch
        .as_ref()
        .is_some_and(|epoch| epoch != &owner.owner_epoch)
    {
        Some(Failure::StaleOwner)
    } else {
        None
    };
    Response {
        version: VERSION,
        request_id: request.request_id,
        status: error.is_none().then(|| owner.clone()),
        error,
    }
}

pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        bail!("OWNER_CONTROL_INVALID_FRAME");
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}

pub async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        bail!("OWNER_CONTROL_INVALID_FRAME");
    }
    writer.write_u32_le(bytes.len() as u32).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> OwnerStatus {
        OwnerStatus {
            owner_epoch: uuid::Uuid::new_v4().to_string(),
            profile_id: "fixture".into(),
            process_id: 1,
            process_created_at: "2".into(),
            operations: vec!["status".into()],
        }
    }
    #[test]
    fn versions_epochs_and_unknown_fields_fail_closed() {
        let owner = owner();
        assert!(respond(Request::status(None), &owner).status.is_some());
        let mut request = Request::status(None);
        request.version = 2;
        assert_eq!(
            respond(request, &owner).error,
            Some(Failure::UnsupportedVersion)
        );
        assert_eq!(
            respond(Request::status(Some("old".into())), &owner).error,
            Some(Failure::StaleOwner)
        );
        let mut request = Request::status(None);
        request.request_id = "invalid".into();
        assert_eq!(
            respond(request, &owner).error,
            Some(Failure::InvalidRequest)
        );
        for extra in [r#", "pid":123"#, r#", "path":"C:/outside""#] {
            let json = format!(
                r#"{{"version":1,"requestId":"{}","operation":"status"{extra}}}"#,
                uuid::Uuid::new_v4()
            );
            assert!(serde_json::from_str::<Request>(&json).is_err());
        }
        assert!(serde_json::from_str::<Request>(
            r#"{"version":1,"requestId":"x","operation":"prepare"}"#
        )
        .is_err());
    }
    #[test]
    fn shared_golden_request_response_and_failure_round_trip() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/shared/test/fixtures/owner-control.json"
        ))
        .unwrap();
        let request: Request = serde_json::from_value(fixtures["request"].clone()).unwrap();
        let response: Response = serde_json::from_value(fixtures["response"].clone()).unwrap();
        let owner = response.status.unwrap();
        assert_eq!(
            serde_json::to_value(respond(request, &owner)).unwrap(),
            fixtures["response"]
        );
        let failure: Response = serde_json::from_value(fixtures["failure"].clone()).unwrap();
        assert_eq!(serde_json::to_value(failure).unwrap(), fixtures["failure"]);
    }

    #[tokio::test]
    async fn frame_boundaries_are_checked_before_allocation_or_dispatch() {
        for length in [0_u32, MAX_FRAME_BYTES as u32 + 1, u32::MAX] {
            let bytes = length.to_le_bytes();
            assert!(read_frame(&mut bytes.as_slice()).await.is_err());
        }
        assert!(read_frame(&mut [4, 0, 0, 0, b'{'].as_slice())
            .await
            .is_err());
        let mut output = Vec::new();
        write_frame(&mut output, b"{}").await.unwrap();
        assert_eq!(read_frame(&mut output.as_slice()).await.unwrap(), b"{}");
    }
}
