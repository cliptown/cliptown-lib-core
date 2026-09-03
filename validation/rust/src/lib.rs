#![forbid(unsafe_code)]

use garde::Validate;
use serde::{Deserialize, Serialize};

pub const VALIDATION_CONTRACT_VERSION: &str = "ores.validation.v1";

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestMeta {
    #[garde(length(min = 1, max = 128))] pub request_id: String,
    #[garde(length(min = 1, max = 128))] pub trace_id: String,
    #[garde(length(min = 2, max = 64))] pub locale: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageQuery {
    #[garde(range(min = 1, max = 100))] pub limit: u16,
    #[garde(length(min = 1, max = 512))] pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProblemDetails {
    #[garde(length(min = 1, max = 512))] pub r#type: String,
    #[garde(length(min = 1, max = 256))] pub title: String,
    #[garde(range(min = 400, max = 599))] pub status: u16,
    #[garde(length(max = 4096))] pub detail: Option<String>,
    #[garde(length(min = 1, max = 128))] pub request_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> RequestMeta { RequestMeta { request_id: "req-1".into(), trace_id: "trace-1".into(), locale: Some("en".into()) } }
    fn problem(status: u16) -> ProblemDetails { ProblemDetails { r#type: "urn:test".into(), title: "Invalid request".into(), status, detail: None, request_id: "req-1".into() } }

    #[test]
    fn accepts_boundaries() {
        assert!(RequestMeta { request_id: "r".repeat(128), trace_id: "t".repeat(128), locale: Some("l".repeat(64)) }.validate().is_ok());
        assert!(PageQuery { limit: 1, cursor: None }.validate().is_ok());
        assert!(PageQuery { limit: 100, cursor: Some("c".repeat(512)) }.validate().is_ok());
        assert!(problem(400).validate().is_ok()); assert!(problem(599).validate().is_ok());
    }

    #[test]
    fn rejects_out_of_contract_values() {
        let mut value = request(); value.request_id.clear(); assert!(value.validate().is_err());
        let mut value = request(); value.trace_id = "t".repeat(129); assert!(value.validate().is_err());
        let mut value = request(); value.locale = Some("e".into()); assert!(value.validate().is_err());
        assert!(PageQuery { limit: 0, cursor: None }.validate().is_err());
        assert!(PageQuery { limit: 101, cursor: None }.validate().is_err());
        assert!(problem(399).validate().is_err()); assert!(problem(600).validate().is_err());
        let mut value = problem(400); value.detail = Some("d".repeat(4097)); assert!(value.validate().is_err());
    }

    #[test]
    fn serde_rejects_unknown_and_missing_fields() {
        assert!(serde_json::from_str::<RequestMeta>(r#"{"requestId":"req-1","traceId":"trace-1","userId":"client-supplied"}"#).is_err());
        assert!(serde_json::from_str::<PageQuery>(r#"{}"#).is_err());
        assert!(serde_json::from_str::<ProblemDetails>(r#"{"type":"urn:test","title":"bad","status":400,"requestId":"req-1","internalCode":"secret"}"#).is_err());
    }

    #[test]
    fn preserves_exact_identifier_text() {
        let value: RequestMeta = serde_json::from_str(r#"{"requestId":" req-1 ","traceId":" trace-1 "}"#).expect("decode");
        assert_eq!(value.request_id, " req-1 "); assert_eq!(value.trace_id, " trace-1 ");
    }
}
