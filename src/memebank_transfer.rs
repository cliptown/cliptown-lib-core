//! Headless MemeBank interoperability enforcement for DEN-1578.
//!
//! This module intentionally exposes no Axum routes and accepts no raw bearer,
//! 3FA proof, deep link, app-presence signal, clipboard fallback, or local IPC
//! artifact. A protected shared-auth verifier must first reduce a delegated token
//! to [`DelegatedAuthorization`]. Only then may the policy and transfer state
//! machine below authorize a subject-owned ciphertext operation.

use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

pub const CLIPTOWN_API_AUDIENCE: &str = "cliptown-api";
pub const MEMEBANK_API_CLIENT: &str = "memebank-api";
pub const MEMEBANK_READ_SCOPE: &str = "cliptown:memebank:read";
pub const MEMEBANK_WRITE_SCOPE: &str = "cliptown:memebank:write";
pub const MEMEBANK_DELETE_SCOPE: &str = "cliptown:memebank:delete";
pub const MAX_SOURCE_CONTENT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_ENCODED_CIPHERTEXT_BYTES: usize = 22_369_624;
pub const MIN_RETENTION_SECONDS: i64 = 60;
pub const MAX_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const MAX_TOKEN_LIFETIME_SECONDS: i64 = 15 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Read,
    Write,
    Delete,
}

impl Operation {
    pub const fn required_scope(self) -> &'static str {
        match self {
            Self::Read => MEMEBANK_READ_SCOPE,
            Self::Write => MEMEBANK_WRITE_SCOPE,
            Self::Delete => MEMEBANK_DELETE_SCOPE,
        }
    }

    pub const fn requires_recent_loa2(self) -> bool {
        matches!(self, Self::Write | Self::Delete)
    }
}

/// Normalized output of protected shared-auth verification/introspection.
///
/// The adapter constructing this value is responsible for ES256/JWKS signature
/// verification and revocation-aware session lookup. This type deliberately has
/// no field for a 3FA-specific proof, header, token, app-install state, or deep
/// link, so those artifacts cannot participate in authorization here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegatedAuthorization {
    pub issuer: String,
    pub audiences: Vec<String>,
    pub authorized_party: String,
    pub subject: String,
    pub session_id: String,
    pub token_id: String,
    pub parent_token_id: String,
    pub scopes: Vec<String>,
    pub assurance_level: u8,
    pub assurance_context: String,
    pub authentication_methods: Vec<String>,
    pub authenticated_at_unix_seconds: Option<i64>,
    pub not_before_unix_seconds: i64,
    pub expires_at_unix_seconds: i64,
    pub session_active: bool,
    pub delegated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelegatedTokenPolicy<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub authorized_party: &'a str,
    pub max_auth_age_seconds: i64,
    pub max_clock_skew_seconds: i64,
    pub max_token_lifetime_seconds: i64,
}

impl<'a> DelegatedTokenPolicy<'a> {
    pub const fn new(issuer: &'a str) -> Self {
        Self {
            issuer,
            audience: CLIPTOWN_API_AUDIENCE,
            authorized_party: MEMEBANK_API_CLIENT,
            max_auth_age_seconds: 10 * 60,
            max_clock_skew_seconds: 60,
            max_token_lifetime_seconds: MAX_TOKEN_LIFETIME_SECONDS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedSubject {
    pub subject: String,
    pub session_id: String,
    pub token_id: String,
    pub operation: Operation,
}

pub fn authorize_delegated_operation(
    now_unix_seconds: i64,
    claims: &DelegatedAuthorization,
    operation: Operation,
    policy: DelegatedTokenPolicy<'_>,
) -> Result<AuthorizedSubject, PolicyError> {
    if now_unix_seconds < 0
        || policy.issuer.is_empty()
        || policy.audience.is_empty()
        || policy.authorized_party.is_empty()
        || policy.max_auth_age_seconds <= 0
        || policy.max_clock_skew_seconds < 0
        || policy.max_token_lifetime_seconds <= 0
    {
        return Err(PolicyError::InvalidPolicy);
    }
    if claims.issuer != policy.issuer {
        return Err(PolicyError::WrongIssuer);
    }
    if claims.audiences.len() != 1 || claims.audiences[0] != policy.audience {
        return Err(PolicyError::WrongAudience);
    }
    if claims.authorized_party != policy.authorized_party {
        return Err(PolicyError::WrongAuthorizedParty);
    }
    if !claims.delegated
        || !claims.session_active
        || !is_portable_identifier(&claims.subject)
        || !is_portable_identifier(&claims.session_id)
        || !is_portable_identifier(&claims.token_id)
        || !is_portable_identifier(&claims.parent_token_id)
        || claims.parent_token_id == claims.token_id
    {
        return Err(PolicyError::InvalidDelegation);
    }

    let latest_allowed_time = now_unix_seconds
        .checked_add(policy.max_clock_skew_seconds)
        .ok_or(PolicyError::InvalidPolicy)?;
    if claims.not_before_unix_seconds > latest_allowed_time {
        return Err(PolicyError::TokenNotYetValid);
    }
    if claims.expires_at_unix_seconds <= now_unix_seconds {
        return Err(PolicyError::TokenExpired);
    }
    let lifetime = claims
        .expires_at_unix_seconds
        .checked_sub(claims.not_before_unix_seconds)
        .ok_or(PolicyError::InvalidDelegation)?;
    if lifetime <= 0 || lifetime > policy.max_token_lifetime_seconds {
        return Err(PolicyError::TokenLifetimeExceeded);
    }

    let expected_scope = operation.required_scope();
    if claims.scopes.len() != 1 || claims.scopes[0] != expected_scope {
        return Err(PolicyError::WrongScope);
    }

    if operation.requires_recent_loa2() {
        let authenticated_at = claims
            .authenticated_at_unix_seconds
            .ok_or(PolicyError::AssuranceRequired)?;
        if claims.assurance_level < 2
            || claims.assurance_context.trim().is_empty()
            || claims.authentication_methods.is_empty()
            || authenticated_at > latest_allowed_time
            || now_unix_seconds.saturating_sub(authenticated_at) > policy.max_auth_age_seconds
        {
            return Err(PolicyError::AssuranceRequired);
        }
    }

    Ok(AuthorizedSubject {
        subject: claims.subject.clone(),
        session_id: claims.session_id.clone(),
        token_id: claims.token_id.clone(),
        operation,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    MemebankToCliptown,
    CliptownToMemebank,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CipherAlgorithm {
    Xchacha20poly1305V1,
    Aes256GcmV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CipherEnvelope {
    pub algorithm: CipherAlgorithm,
    pub nonce: String,
    pub ciphertext: String,
    pub associated_data_hash: Option<String>,
    pub key_id: String,
}

impl CipherEnvelope {
    pub fn validate(&self) -> Result<(), PolicyError> {
        if !(16..=128).contains(&self.nonce.len())
            || !is_base64ish(&self.nonce)
            || self.ciphertext.is_empty()
            || self.ciphertext.len() > MAX_ENCODED_CIPHERTEXT_BYTES
            || !is_base64ish(&self.ciphertext)
            || !is_portable_identifier(&self.key_id)
            || self
                .associated_data_hash
                .as_deref()
                .is_some_and(|value| value.len() > 128 || !is_base64ish(value))
        {
            return Err(PolicyError::InvalidCipherEnvelope);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CreateTransferRequest {
    pub contract_version: u16,
    pub direction: TransferDirection,
    pub source_item_id: String,
    pub media_type: String,
    pub content_sha256: String,
    pub content_length: u64,
    pub payload: CipherEnvelope,
    pub encrypted_metadata: Option<CipherEnvelope>,
    pub expires_at_unix_seconds: i64,
}

impl CreateTransferRequest {
    pub fn validate(&self, now_unix_seconds: i64) -> Result<(), PolicyError> {
        if now_unix_seconds < 0 || self.contract_version != 1 {
            return Err(PolicyError::IncompatibleContract);
        }
        if !is_portable_identifier(&self.source_item_id)
            || !is_media_type(&self.media_type)
            || !is_sha256_base64url(&self.content_sha256)
            || self.content_length > MAX_SOURCE_CONTENT_BYTES
        {
            return Err(PolicyError::InvalidTransfer);
        }
        self.payload.validate()?;
        if let Some(metadata) = &self.encrypted_metadata {
            metadata.validate()?;
        }

        let retention = self
            .expires_at_unix_seconds
            .checked_sub(now_unix_seconds)
            .ok_or(PolicyError::InvalidRetention)?;
        if !(MIN_RETENTION_SECONDS..=MAX_RETENTION_SECONDS).contains(&retention) {
            return Err(PolicyError::InvalidRetention);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Pending,
    Acknowledged,
    Ignored,
    Rejected,
    Expired,
    Cancelled,
}

impl TransferState {
    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcknowledgementDisposition {
    Acknowledged,
    Ignored,
    Rejected,
}

impl From<AcknowledgementDisposition> for TransferState {
    fn from(value: AcknowledgementDisposition) -> Self {
        match value {
            AcknowledgementDisposition::Acknowledged => Self::Acknowledged,
            AcknowledgementDisposition::Ignored => Self::Ignored,
            AcknowledgementDisposition::Rejected => Self::Rejected,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcknowledgeTransferRequest {
    pub contract_version: u16,
    pub disposition: AcknowledgementDisposition,
    pub client_receipt_id: String,
}

impl AcknowledgeTransferRequest {
    pub fn validate(&self) -> Result<(), PolicyError> {
        if self.contract_version != 1 || !is_idempotency_key(&self.client_receipt_id) {
            return Err(PolicyError::InvalidAcknowledgement);
        }
        Ok(())
    }
}

pub fn acknowledge_state(
    now_unix_seconds: i64,
    expires_at_unix_seconds: i64,
    current: TransferState,
    disposition: AcknowledgementDisposition,
) -> Result<TransferState, PolicyError> {
    let target = TransferState::from(disposition);
    if current == target {
        return Ok(current);
    }
    if current != TransferState::Pending {
        return Err(PolicyError::InvalidTransition);
    }
    if now_unix_seconds >= expires_at_unix_seconds {
        return Err(PolicyError::TransferExpired);
    }
    Ok(target)
}

/// Cancellation is idempotent. A pending expired record becomes `expired`; any
/// already-terminal record remains terminal and is never reopened.
pub fn cancel_state(
    now_unix_seconds: i64,
    expires_at_unix_seconds: i64,
    current: TransferState,
) -> TransferState {
    match current {
        TransferState::Pending if now_unix_seconds >= expires_at_unix_seconds => {
            TransferState::Expired
        }
        TransferState::Pending => TransferState::Cancelled,
        terminal => terminal,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedTransfer<'a> {
    pub transfer_id: &'a str,
    pub subject: &'a str,
}

/// Returns the same `NotFound` result for an absent/cross-subject lookup.
pub fn authorize_owned_transfer(
    authorized: &AuthorizedSubject,
    transfer: Option<OwnedTransfer<'_>>,
) -> Result<(), PolicyError> {
    let transfer = transfer.ok_or(PolicyError::NotFound)?;
    if !is_uuid(&transfer.transfer_id) || transfer.subject != authorized.subject {
        return Err(PolicyError::NotFound);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdempotentOperation {
    Create,
    Acknowledge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdempotencyBinding<'a> {
    pub subject: &'a str,
    pub key: &'a str,
    pub operation: IdempotentOperation,
    pub normalized_route: &'a str,
    pub request_digest: &'a str,
    pub expires_at_unix_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdempotencyDecision {
    New,
    Replay,
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_idempotency(
    now_unix_seconds: i64,
    existing: Option<IdempotencyBinding<'_>>,
    subject: &str,
    key: &str,
    operation: IdempotentOperation,
    normalized_route: &str,
    request_digest: &str,
) -> Result<IdempotencyDecision, PolicyError> {
    if now_unix_seconds < 0
        || !is_portable_identifier(subject)
        || !is_idempotency_key(key)
        || !is_normalized_route(normalized_route)
        || !is_sha256_base64url(request_digest)
    {
        return Err(PolicyError::InvalidIdempotency);
    }
    let Some(existing) = existing else {
        return Ok(IdempotencyDecision::New);
    };

    // A repository lookup is keyed by (subject, key). Treat any accidental
    // cross-subject value as absent so it cannot become an existence oracle.
    if existing.subject != subject
        || existing.key != key
        || existing.expires_at_unix_seconds <= now_unix_seconds
    {
        return Ok(IdempotencyDecision::New);
    }
    if existing.operation == operation
        && existing.normalized_route == normalized_route
        && existing.request_digest == request_digest
    {
        return Ok(IdempotencyDecision::Replay);
    }
    Err(PolicyError::IdempotencyConflict)
}

pub fn validate_opaque_cursor(cursor: &str) -> Result<(), PolicyError> {
    if cursor.is_empty()
        || cursor.len() > 512
        || cursor.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
        })
    {
        return Err(PolicyError::InvalidCursor);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    InvalidPolicy,
    WrongIssuer,
    WrongAudience,
    WrongAuthorizedParty,
    InvalidDelegation,
    TokenNotYetValid,
    TokenExpired,
    TokenLifetimeExceeded,
    WrongScope,
    AssuranceRequired,
    IncompatibleContract,
    InvalidTransfer,
    InvalidCipherEnvelope,
    InvalidRetention,
    InvalidAcknowledgement,
    InvalidTransition,
    TransferExpired,
    NotFound,
    InvalidIdempotency,
    IdempotencyConflict,
    InvalidCursor,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPolicy => "delegated-token policy is invalid",
            Self::WrongIssuer => "delegated token issuer is not allowed",
            Self::WrongAudience => "delegated token audience is not allowed",
            Self::WrongAuthorizedParty => "delegated token client is not allowed",
            Self::InvalidDelegation => "delegated token lineage or session is invalid",
            Self::TokenNotYetValid => "delegated token is not yet valid",
            Self::TokenExpired => "delegated token is expired",
            Self::TokenLifetimeExceeded => "delegated token lifetime exceeds policy",
            Self::WrongScope => "delegated token does not contain the exact operation scope",
            Self::AssuranceRequired => "recent LOA2 assurance is required",
            Self::IncompatibleContract => "MemeBank transfer contract is incompatible",
            Self::InvalidTransfer => "MemeBank transfer metadata is invalid",
            Self::InvalidCipherEnvelope => "ciphertext envelope is invalid",
            Self::InvalidRetention => "transfer retention is outside policy",
            Self::InvalidAcknowledgement => "transfer acknowledgement is invalid",
            Self::InvalidTransition => "transfer state transition is invalid",
            Self::TransferExpired => "transfer is expired",
            Self::NotFound => "transfer was not found",
            Self::InvalidIdempotency => "idempotency binding is invalid",
            Self::IdempotencyConflict => "idempotency key was reused with a different request",
            Self::InvalidCursor => "cursor is invalid",
        })
    }
}

impl Error for PolicyError {}

fn is_portable_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len()) && is_portable_identifier(value)
}

fn is_media_type(value: &str) -> bool {
    if !(3..=128).contains(&value.len()) || value.matches('/').count() != 1 {
        return false;
    }
    value.split('/').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
    })
}

fn is_base64ish(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'+' | b'/' | b'-' | b'_')
                || (byte == b'=' && index + 2 >= value.len())
        })
}

fn is_sha256_base64url(value: &str) -> bool {
    (43..=44).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_')
                || (byte == b'=' && index + 1 == value.len())
        })
}

fn is_normalized_route(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.starts_with('/')
        && !value.contains('?')
        && !value.contains('#')
        && !value.contains("//")
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .skip(1)
            .all(|segment| !matches!(segment, "." | ".."))
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;
    const ISSUER: &str = "https://auth.example.test";
    const DIGEST: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn claims(scope: &str) -> DelegatedAuthorization {
        DelegatedAuthorization {
            issuer: ISSUER.to_owned(),
            audiences: vec![CLIPTOWN_API_AUDIENCE.to_owned()],
            authorized_party: MEMEBANK_API_CLIENT.to_owned(),
            subject: "00000000-0000-4000-8000-000000000001".to_owned(),
            session_id: "session-active-0001".to_owned(),
            token_id: "delegated-token-0001".to_owned(),
            parent_token_id: "parent-token-0001".to_owned(),
            scopes: vec![scope.to_owned()],
            assurance_level: 2,
            assurance_context: "urn:oresoftware:loa:2".to_owned(),
            authentication_methods: vec!["passkey".to_owned()],
            authenticated_at_unix_seconds: Some(NOW - 30),
            not_before_unix_seconds: NOW - 10,
            expires_at_unix_seconds: NOW + 290,
            session_active: true,
            delegated: true,
        }
    }

    fn policy() -> DelegatedTokenPolicy<'static> {
        DelegatedTokenPolicy::new(ISSUER)
    }

    fn envelope() -> CipherEnvelope {
        CipherEnvelope {
            algorithm: CipherAlgorithm::Xchacha20poly1305V1,
            nonce: "AAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
            ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA==".to_owned(),
            associated_data_hash: Some(DIGEST.to_owned()),
            key_id: "device-key-0001".to_owned(),
        }
    }

    fn request() -> CreateTransferRequest {
        CreateTransferRequest {
            contract_version: 1,
            direction: TransferDirection::MemebankToCliptown,
            source_item_id: "opaque-source-0001".to_owned(),
            media_type: "image/png".to_owned(),
            content_sha256: DIGEST.to_owned(),
            content_length: 16,
            payload: envelope(),
            encrypted_metadata: Some(envelope()),
            expires_at_unix_seconds: NOW + 3600,
        }
    }

    #[test]
    fn exact_delegated_scope_and_fresh_shared_auth_assurance_are_required() {
        for operation in [Operation::Read, Operation::Write, Operation::Delete] {
            let authorization = claims(operation.required_scope());
            let allowed = authorize_delegated_operation(NOW, &authorization, operation, policy())
                .expect("valid delegated operation");
            assert_eq!(allowed.subject, authorization.subject);
            assert_eq!(allowed.operation, operation);
        }
    }

    #[test]
    fn token_identity_session_lineage_time_and_scope_fail_closed() {
        let cases: Vec<Box<dyn Fn(&mut DelegatedAuthorization)>> = vec![
            Box::new(|value| value.issuer = "https://attacker.invalid".to_owned()),
            Box::new(|value| value.audiences = vec!["other-api".to_owned()]),
            Box::new(|value| value.audiences.push("other-api".to_owned())),
            Box::new(|value| value.authorized_party = "other-client".to_owned()),
            Box::new(|value| value.session_active = false),
            Box::new(|value| value.delegated = false),
            Box::new(|value| value.session_id.clear()),
            Box::new(|value| value.parent_token_id.clear()),
            Box::new(|value| value.parent_token_id = value.token_id.clone()),
            Box::new(|value| value.not_before_unix_seconds = NOW + 61),
            Box::new(|value| value.expires_at_unix_seconds = NOW),
            Box::new(|value| value.expires_at_unix_seconds = NOW + 901),
            Box::new(|value| {
                value.scopes = vec![
                    MEMEBANK_READ_SCOPE.to_owned(),
                    MEMEBANK_WRITE_SCOPE.to_owned(),
                ]
            }),
            Box::new(|value| value.scopes = vec![MEMEBANK_DELETE_SCOPE.to_owned()]),
        ];
        for mutate in cases {
            let mut value = claims(MEMEBANK_WRITE_SCOPE);
            mutate(&mut value);
            assert!(
                authorize_delegated_operation(NOW, &value, Operation::Write, policy()).is_err(),
                "mutated authorization unexpectedly passed: {value:?}"
            );
        }
    }

    #[test]
    fn write_and_delete_require_recent_loa2_but_read_does_not() {
        for operation in [Operation::Write, Operation::Delete] {
            let mut value = claims(operation.required_scope());
            value.assurance_level = 1;
            assert_eq!(
                authorize_delegated_operation(NOW, &value, operation, policy()),
                Err(PolicyError::AssuranceRequired)
            );

            let mut value = claims(operation.required_scope());
            value.authenticated_at_unix_seconds = Some(NOW - 601);
            assert_eq!(
                authorize_delegated_operation(NOW, &value, operation, policy()),
                Err(PolicyError::AssuranceRequired)
            );

            let mut value = claims(operation.required_scope());
            value.authenticated_at_unix_seconds = None;
            assert_eq!(
                authorize_delegated_operation(NOW, &value, operation, policy()),
                Err(PolicyError::AssuranceRequired)
            );
        }

        let mut read = claims(MEMEBANK_READ_SCOPE);
        read.assurance_level = 1;
        read.authenticated_at_unix_seconds = None;
        assert!(authorize_delegated_operation(NOW, &read, Operation::Read, policy()).is_ok());
    }

    #[test]
    fn ciphertext_only_transfer_request_enforces_contract_and_retention() {
        assert_eq!(request().validate(NOW), Ok(()));

        let mut invalid = request();
        invalid.contract_version = 2;
        assert_eq!(
            invalid.validate(NOW),
            Err(PolicyError::IncompatibleContract)
        );

        let mut invalid = request();
        invalid.source_item_id = "https://private.example/item".to_owned();
        assert_eq!(invalid.validate(NOW), Err(PolicyError::InvalidTransfer));

        let mut invalid = request();
        invalid.content_length = MAX_SOURCE_CONTENT_BYTES + 1;
        assert_eq!(invalid.validate(NOW), Err(PolicyError::InvalidTransfer));

        let mut invalid = request();
        invalid.expires_at_unix_seconds = NOW + MIN_RETENTION_SECONDS - 1;
        assert_eq!(invalid.validate(NOW), Err(PolicyError::InvalidRetention));

        let mut invalid = request();
        invalid.expires_at_unix_seconds = NOW + MAX_RETENTION_SECONDS + 1;
        assert_eq!(invalid.validate(NOW), Err(PolicyError::InvalidRetention));
    }

    #[test]
    fn envelope_and_json_shape_reject_plaintext_credentials_urls_and_unknown_fields() {
        let mut invalid = request();
        invalid.payload.nonce = "not base64!".to_owned();
        assert_eq!(
            invalid.validate(NOW),
            Err(PolicyError::InvalidCipherEnvelope)
        );

        let with_plaintext = json!({
            "contract_version": 1,
            "direction": "memebank_to_cliptown",
            "source_item_id": "opaque-source-0001",
            "media_type": "image/png",
            "content_sha256": DIGEST,
            "content_length": 16,
            "payload": {
                "algorithm": "xchacha20poly1305-v1",
                "nonce": "AAAAAAAAAAAAAAAAAAAAAAAA",
                "ciphertext": "AQIDBAUGBwgJCgsMDQ4PEA==",
                "associated_data_hash": DIGEST,
                "key_id": "device-key-0001",
                "signed_url": "https://storage.invalid/private"
            },
            "expires_at_unix_seconds": NOW + 3600,
            "plaintext_caption": "must never be accepted",
            "access_token": "must never be accepted"
        });
        assert!(serde_json::from_value::<CreateTransferRequest>(with_plaintext).is_err());
    }

    #[test]
    fn ownership_failures_are_indistinguishable_from_absence() {
        let authorized = authorize_delegated_operation(
            NOW,
            &claims(MEMEBANK_READ_SCOPE),
            Operation::Read,
            policy(),
        )
        .unwrap();
        assert_eq!(
            authorize_owned_transfer(&authorized, None),
            Err(PolicyError::NotFound)
        );
        assert_eq!(
            authorize_owned_transfer(
                &authorized,
                Some(OwnedTransfer {
                    transfer_id: "00000000-0000-4000-8000-000000000002",
                    subject: "00000000-0000-4000-8000-000000000099",
                })
            ),
            Err(PolicyError::NotFound)
        );
        assert_eq!(
            authorize_owned_transfer(
                &authorized,
                Some(OwnedTransfer {
                    transfer_id: "00000000-0000-4000-8000-000000000002",
                    subject: &authorized.subject,
                })
            ),
            Ok(())
        );
    }

    #[test]
    fn create_and_acknowledgement_idempotency_are_subject_digest_and_route_bound() {
        let existing = IdempotencyBinding {
            subject: "subject-00000001",
            key: "idempotency-key-00000001",
            operation: IdempotentOperation::Create,
            normalized_route: "/v1/integrations/memebank/transfers",
            request_digest: DIGEST,
            expires_at_unix_seconds: NOW + 3600,
        };
        assert_eq!(
            evaluate_idempotency(
                NOW,
                Some(existing.clone()),
                existing.subject,
                existing.key,
                existing.operation,
                existing.normalized_route,
                existing.request_digest,
            ),
            Ok(IdempotencyDecision::Replay)
        );
        assert_eq!(
            evaluate_idempotency(
                NOW,
                Some(existing.clone()),
                existing.subject,
                existing.key,
                existing.operation,
                existing.normalized_route,
                "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            ),
            Err(PolicyError::IdempotencyConflict)
        );
        assert_eq!(
            evaluate_idempotency(
                NOW,
                Some(existing.clone()),
                "another-subject-0001",
                existing.key,
                existing.operation,
                existing.normalized_route,
                existing.request_digest,
            ),
            Ok(IdempotencyDecision::New)
        );
        assert_eq!(
            evaluate_idempotency(
                NOW,
                Some(existing),
                "subject-00000001",
                "idempotency-key-00000001",
                IdempotentOperation::Acknowledge,
                "/v1/integrations/memebank/transfers/00000000-0000-4000-8000-000000000002/ack",
                DIGEST,
            ),
            Err(PolicyError::IdempotencyConflict)
        );
    }

    #[test]
    fn acknowledgement_and_cancel_state_machines_never_reopen_terminal_records() {
        assert_eq!(
            acknowledge_state(
                NOW,
                NOW + 3600,
                TransferState::Pending,
                AcknowledgementDisposition::Acknowledged,
            ),
            Ok(TransferState::Acknowledged)
        );
        assert_eq!(
            acknowledge_state(
                NOW,
                NOW + 3600,
                TransferState::Acknowledged,
                AcknowledgementDisposition::Acknowledged,
            ),
            Ok(TransferState::Acknowledged)
        );
        assert_eq!(
            acknowledge_state(
                NOW,
                NOW + 3600,
                TransferState::Acknowledged,
                AcknowledgementDisposition::Rejected,
            ),
            Err(PolicyError::InvalidTransition)
        );
        assert_eq!(
            acknowledge_state(
                NOW,
                NOW,
                TransferState::Pending,
                AcknowledgementDisposition::Ignored,
            ),
            Err(PolicyError::TransferExpired)
        );
        assert_eq!(
            cancel_state(NOW, NOW + 3600, TransferState::Pending),
            TransferState::Cancelled
        );
        assert_eq!(
            cancel_state(NOW, NOW, TransferState::Pending),
            TransferState::Expired
        );
        for terminal in [
            TransferState::Acknowledged,
            TransferState::Ignored,
            TransferState::Rejected,
            TransferState::Expired,
            TransferState::Cancelled,
        ] {
            assert_eq!(cancel_state(NOW, NOW + 3600, terminal), terminal);
        }
    }

    #[test]
    fn acknowledgement_and_cursor_inputs_are_bounded() {
        assert_eq!(
            AcknowledgeTransferRequest {
                contract_version: 1,
                disposition: AcknowledgementDisposition::Ignored,
                client_receipt_id: "client-receipt-00000001".to_owned(),
            }
            .validate(),
            Ok(())
        );
        assert_eq!(validate_opaque_cursor("v1.opaque_cursor-0001"), Ok(()));
        assert_eq!(
            validate_opaque_cursor("../tenant"),
            Err(PolicyError::InvalidCursor)
        );
        assert_eq!(
            validate_opaque_cursor(&"a".repeat(513)),
            Err(PolicyError::InvalidCursor)
        );
    }
}
