#![forbid(unsafe_code)]

use cliptown_validation::RequestMeta;
use garde::Validate;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedActor {
    #[garde(length(min = 1, max = 128))] pub user_id: String,
    #[garde(length(min = 1, max = 128))] pub tenant_id: Option<String>,
    #[garde(length(max = 64), inner(length(min = 1, max = 128)))] pub roles: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerRequestContext {
    #[garde(dive)] pub public: RequestMeta,
    #[garde(dive)] pub actor: TrustedActor,
    #[garde(ip)] pub source_ip: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InternalCommand {
    #[garde(length(min = 1, max = 256))] pub operation_id: String,
    #[garde(length(min = 1, max = 128))] pub idempotency_key: Option<String>,
    #[garde(dive)] pub context: ServerRequestContext,
    #[garde(skip)] pub payload: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*; use serde_json::json;
    fn actor() -> TrustedActor { TrustedActor { user_id: "user-1".into(), tenant_id: None, roles: vec!["reader".into()] } }
    fn context() -> ServerRequestContext { ServerRequestContext { public: RequestMeta { request_id: "req-1".into(), trace_id: "trace-1".into(), locale: None }, actor: actor(), source_ip: Some("127.0.0.1".into()) } }

    #[test]
    fn accepts_and_rejects_server_boundaries() {
        assert!(context().validate().is_ok());
        assert!(InternalCommand { operation_id: "clips.create".into(), idempotency_key: Some("idem-1".into()), context: context(), payload: json!({}) }.validate().is_ok());
        let mut value = actor(); value.user_id.clear(); assert!(value.validate().is_err());
        let mut value = actor(); value.roles = vec!["reader".into(); 65]; assert!(value.validate().is_err());
        let mut value = context(); value.source_ip = Some("not-an-ip".into()); assert!(value.validate().is_err());
        assert!(InternalCommand { operation_id: String::new(), idempotency_key: None, context: context(), payload: json!({}) }.validate().is_err());
    }

    #[test]
    fn serde_rejects_unknown_server_fields() {
        let input = r#"{"operationId":"clips.create","context":{"public":{"requestId":"req-1","traceId":"trace-1"},"actor":{"userId":"user-1","roles":[]}},"payload":{},"credential":"secret"}"#;
        assert!(serde_json::from_str::<InternalCommand>(input).is_err());
    }
}
