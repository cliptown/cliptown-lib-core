use std::{collections::HashSet, error::Error, fmt};

use cliptown_interfaces_rust::{
    AppVaultMutation, AppVaultPushRequest, ExternalStepUpAction, ExternalStepUpProof,
};

use crate::account_security::DeviceLifecycleState;

pub const THREE_FA_APP_ID: &str = "app.3fa.authenticator";
pub const THREE_FA_NAMESPACE: &str = "threefa-vault-v1";
pub const CLIPTOWN_STEP_UP_AUDIENCE: &str = "cliptown";
pub const THREE_FA_STEP_UP_ISSUER: &str = "https://3fa.app";

const DEFAULT_MAX_APP_VAULT_BATCH: usize = 100;
const DEFAULT_MAX_FUTURE_SKEW_SECONDS: i64 = 300;
const DEFAULT_MAX_STEP_UP_LIFETIME_SECONDS: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthenticatedDevice<'a> {
    pub subject: &'a str,
    pub device_id: &'a str,
    pub lifecycle_state: DeviceLifecycleState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppVaultPolicy<'a> {
    pub app_id: &'a str,
    pub allowed_namespaces: &'a [&'a str],
    pub max_batch_size: usize,
    pub max_future_skew_seconds: i64,
}

impl Default for AppVaultPolicy<'static> {
    fn default() -> Self {
        Self {
            app_id: THREE_FA_APP_ID,
            allowed_namespaces: &[THREE_FA_NAMESPACE],
            max_batch_size: DEFAULT_MAX_APP_VAULT_BATCH,
            max_future_skew_seconds: DEFAULT_MAX_FUTURE_SKEW_SECONDS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedAppVaultPush {
    pub mutation_count: usize,
    pub highest_logical_clock: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedRequestContext<'a> {
    pub subject: &'a str,
    pub initiating_device_id: &'a str,
    pub action: ExternalStepUpAction,
    pub method: &'a str,
    pub normalized_route: &'a str,
    pub target_resource_id: Option<&'a str>,
    pub request_body_sha256_base64: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepUpChallenge<'a> {
    pub challenge_id: &'a str,
    pub subject: &'a str,
    pub initiating_device_id: &'a str,
    pub audience: &'a str,
    pub action: ExternalStepUpAction,
    pub method: &'a str,
    pub normalized_route: &'a str,
    pub target_resource_id: Option<&'a str>,
    pub request_body_sha256_base64: &'a str,
    pub created_at_unix_seconds: i64,
    pub expires_at_unix_seconds: i64,
    pub consumed: bool,
    pub invalidated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepUpPolicy<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub max_lifetime_seconds: i64,
    pub max_clock_skew_seconds: i64,
}

impl Default for StepUpPolicy<'static> {
    fn default() -> Self {
        Self {
            issuer: THREE_FA_STEP_UP_ISSUER,
            audience: CLIPTOWN_STEP_UP_AUDIENCE,
            max_lifetime_seconds: DEFAULT_MAX_STEP_UP_LIFETIME_SECONDS,
            max_clock_skew_seconds: DEFAULT_MAX_FUTURE_SKEW_SECONDS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedStepUpConsumption {
    pub challenge_id: String,
    pub proof_id: String,
    pub consumed_at_unix_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    InvalidClock,
    InvalidDeviceContext,
    InactiveDevice,
    EmptyBatch,
    BatchTooLarge,
    InvalidMutation,
    WrongApplication,
    WrongNamespace,
    SourceDeviceMismatch,
    FutureMutation,
    DuplicateMutation,
    DuplicateRecordClock,
    LogicalClockOutOfRange,
    SignatureRejected,
    InvalidRequestContext,
    InvalidChallenge,
    TerminalChallenge,
    ChallengeNotYetValid,
    ChallengeExpired,
    RequestContextMismatch,
    InvalidProof,
    ProofContextMismatch,
    ProofNotYetValid,
    ProofExpired,
    ProofLifetimeExceeded,
    ProofPredatesChallenge,
    ProofOutlivesChallenge,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidClock => "server clock input is invalid",
            Self::InvalidDeviceContext => "authenticated device context is invalid",
            Self::InactiveDevice => "device is not active",
            Self::EmptyBatch => "app-vault batch is empty",
            Self::BatchTooLarge => "app-vault batch exceeds policy",
            Self::InvalidMutation => "app-vault mutation is invalid",
            Self::WrongApplication => "app-vault application does not match policy",
            Self::WrongNamespace => "app-vault namespace is not allowed",
            Self::SourceDeviceMismatch => "mutation source device does not match authentication",
            Self::FutureMutation => "mutation timestamp exceeds allowed clock skew",
            Self::DuplicateMutation => "app-vault batch repeats a mutation identifier",
            Self::DuplicateRecordClock => "app-vault batch repeats a record clock",
            Self::LogicalClockOutOfRange => "app-vault logical clock exceeds PostgreSQL BIGINT",
            Self::SignatureRejected => "cryptographic signature verification failed",
            Self::InvalidRequestContext => "protected request context is invalid",
            Self::InvalidChallenge => "step-up challenge is invalid",
            Self::TerminalChallenge => "step-up challenge is already terminal",
            Self::ChallengeNotYetValid => "step-up challenge is not yet valid",
            Self::ChallengeExpired => "step-up challenge has expired",
            Self::RequestContextMismatch => "protected request does not match its challenge",
            Self::InvalidProof => "external step-up proof is invalid",
            Self::ProofContextMismatch => "external step-up proof does not match its challenge",
            Self::ProofNotYetValid => "external step-up proof is not yet valid",
            Self::ProofExpired => "external step-up proof has expired",
            Self::ProofLifetimeExceeded => "external step-up proof exceeds local policy lifetime",
            Self::ProofPredatesChallenge => "external step-up proof predates its challenge",
            Self::ProofOutlivesChallenge => "external step-up proof outlives its challenge",
        };
        formatter.write_str(message)
    }
}

impl Error for PolicyError {}

pub trait AppVaultSignatureVerifier {
    fn verify(&self, mutation: &AppVaultMutation) -> Result<(), PolicyError>;
}

pub trait StepUpSignatureVerifier {
    fn verify(&self, proof: &ExternalStepUpProof) -> Result<(), PolicyError>;
}

pub fn validate_app_vault_push<V>(
    now_unix_seconds: i64,
    path_app_id: &str,
    request: &AppVaultPushRequest,
    device: AuthenticatedDevice<'_>,
    policy: AppVaultPolicy<'_>,
    verifier: &V,
) -> Result<ValidatedAppVaultPush, PolicyError>
where
    V: AppVaultSignatureVerifier,
{
    validate_active_device(device)?;
    if now_unix_seconds < 0 || policy.max_future_skew_seconds < 0 {
        return Err(PolicyError::InvalidClock);
    }
    if path_app_id != policy.app_id {
        return Err(PolicyError::WrongApplication);
    }
    if request.mutations.is_empty() {
        return Err(PolicyError::EmptyBatch);
    }
    if request.mutations.len() > policy.max_batch_size {
        return Err(PolicyError::BatchTooLarge);
    }
    request
        .validate()
        .map_err(|_| PolicyError::InvalidMutation)?;

    let latest_allowed_timestamp = now_unix_seconds
        .checked_add(policy.max_future_skew_seconds)
        .ok_or(PolicyError::InvalidClock)?;
    let mut mutation_ids = HashSet::with_capacity(request.mutations.len());
    let mut record_clocks = HashSet::with_capacity(request.mutations.len());
    let mut highest_logical_clock = 0;

    for mutation in &request.mutations {
        if mutation.app_id != path_app_id {
            return Err(PolicyError::WrongApplication);
        }
        if !policy
            .allowed_namespaces
            .iter()
            .any(|namespace| mutation.namespace == *namespace)
        {
            return Err(PolicyError::WrongNamespace);
        }
        if mutation.source_device_id != device.device_id {
            return Err(PolicyError::SourceDeviceMismatch);
        }
        if mutation.created_at.timestamp() > latest_allowed_timestamp
            || mutation.updated_at.timestamp() > latest_allowed_timestamp
        {
            return Err(PolicyError::FutureMutation);
        }
        if !mutation_ids.insert(mutation.mutation_id.as_str()) {
            return Err(PolicyError::DuplicateMutation);
        }
        if !record_clocks.insert((
            mutation.namespace.as_str(),
            mutation.opaque_record_id.as_str(),
            mutation.source_device_id.as_str(),
            mutation.logical_clock,
        )) {
            return Err(PolicyError::DuplicateRecordClock);
        }
        if mutation.logical_clock > i64::MAX as u64 {
            return Err(PolicyError::LogicalClockOutOfRange);
        }
        verifier.verify(mutation)?;
        highest_logical_clock = highest_logical_clock.max(mutation.logical_clock);
    }

    Ok(ValidatedAppVaultPush {
        mutation_count: request.mutations.len(),
        highest_logical_clock,
    })
}

pub fn validate_step_up_authorization<V>(
    now_unix_seconds: i64,
    request: &ProtectedRequestContext<'_>,
    challenge: &StepUpChallenge<'_>,
    proof: &ExternalStepUpProof,
    device: AuthenticatedDevice<'_>,
    policy: StepUpPolicy<'_>,
    verifier: &V,
) -> Result<ValidatedStepUpConsumption, PolicyError>
where
    V: StepUpSignatureVerifier,
{
    validate_active_device(device)?;
    validate_protected_request(request)?;
    validate_challenge(now_unix_seconds, challenge, policy)?;

    if request.subject != device.subject
        || request.initiating_device_id != device.device_id
        || challenge.subject != request.subject
        || challenge.initiating_device_id != request.initiating_device_id
        || challenge.action != request.action
        || challenge.method != request.method
        || challenge.normalized_route != request.normalized_route
        || challenge.target_resource_id != request.target_resource_id
        || challenge.request_body_sha256_base64 != request.request_body_sha256_base64
    {
        return Err(PolicyError::RequestContextMismatch);
    }

    proof
        .validate(None)
        .map_err(|_| PolicyError::InvalidProof)?;
    if proof.issuer != policy.issuer
        || proof.audience != policy.audience
        || proof.audience != challenge.audience
        || proof.subject != challenge.subject
        || proof.challenge_id != challenge.challenge_id
        || proof.action != challenge.action
    {
        return Err(PolicyError::ProofContextMismatch);
    }

    let proof_issued_at = proof.issued_at.timestamp();
    let proof_expires_at = proof.expires_at.timestamp();
    let proof_lifetime = proof_expires_at
        .checked_sub(proof_issued_at)
        .ok_or(PolicyError::InvalidProof)?;
    if proof_lifetime <= 0 || proof_lifetime > policy.max_lifetime_seconds {
        return Err(PolicyError::ProofLifetimeExceeded);
    }
    let latest_allowed_issue_time = now_unix_seconds
        .checked_add(policy.max_clock_skew_seconds)
        .ok_or(PolicyError::InvalidClock)?;
    if proof_issued_at > latest_allowed_issue_time {
        return Err(PolicyError::ProofNotYetValid);
    }
    if proof_expires_at <= now_unix_seconds {
        return Err(PolicyError::ProofExpired);
    }
    if proof_issued_at
        < challenge
            .created_at_unix_seconds
            .saturating_sub(policy.max_clock_skew_seconds)
    {
        return Err(PolicyError::ProofPredatesChallenge);
    }
    if proof_expires_at > challenge.expires_at_unix_seconds {
        return Err(PolicyError::ProofOutlivesChallenge);
    }

    verifier.verify(proof)?;

    Ok(ValidatedStepUpConsumption {
        challenge_id: challenge.challenge_id.to_owned(),
        proof_id: proof.proof_id.clone(),
        consumed_at_unix_seconds: now_unix_seconds,
    })
}

fn validate_active_device(device: AuthenticatedDevice<'_>) -> Result<(), PolicyError> {
    if !is_portable_identifier(device.subject) || !is_portable_identifier(device.device_id) {
        return Err(PolicyError::InvalidDeviceContext);
    }
    if device.lifecycle_state != DeviceLifecycleState::Active {
        return Err(PolicyError::InactiveDevice);
    }
    Ok(())
}

fn validate_protected_request(request: &ProtectedRequestContext<'_>) -> Result<(), PolicyError> {
    if !is_portable_identifier(request.subject)
        || !is_portable_identifier(request.initiating_device_id)
        || !is_sensitive_method(request.method)
        || !is_normalized_route(request.normalized_route)
        || !is_sha256_base64(request.request_body_sha256_base64)
        || request
            .target_resource_id
            .is_some_and(|target| !is_portable_identifier(target))
    {
        return Err(PolicyError::InvalidRequestContext);
    }
    Ok(())
}

fn validate_challenge(
    now_unix_seconds: i64,
    challenge: &StepUpChallenge<'_>,
    policy: StepUpPolicy<'_>,
) -> Result<(), PolicyError> {
    if now_unix_seconds < 0 || policy.max_lifetime_seconds <= 0 || policy.max_clock_skew_seconds < 0
    {
        return Err(PolicyError::InvalidClock);
    }
    if challenge.consumed || challenge.invalidated {
        return Err(PolicyError::TerminalChallenge);
    }
    let context = ProtectedRequestContext {
        subject: challenge.subject,
        initiating_device_id: challenge.initiating_device_id,
        action: challenge.action,
        method: challenge.method,
        normalized_route: challenge.normalized_route,
        target_resource_id: challenge.target_resource_id,
        request_body_sha256_base64: challenge.request_body_sha256_base64,
    };
    if !is_portable_identifier(challenge.challenge_id)
        || challenge.audience != policy.audience
        || validate_protected_request(&context).is_err()
    {
        return Err(PolicyError::InvalidChallenge);
    }

    let lifetime = challenge
        .expires_at_unix_seconds
        .checked_sub(challenge.created_at_unix_seconds)
        .ok_or(PolicyError::InvalidChallenge)?;
    if lifetime <= 0 || lifetime > policy.max_lifetime_seconds {
        return Err(PolicyError::InvalidChallenge);
    }
    if challenge.created_at_unix_seconds
        > now_unix_seconds
            .checked_add(policy.max_clock_skew_seconds)
            .ok_or(PolicyError::InvalidClock)?
    {
        return Err(PolicyError::ChallengeNotYetValid);
    }
    if challenge.expires_at_unix_seconds <= now_unix_seconds {
        return Err(PolicyError::ChallengeExpired);
    }
    Ok(())
}

fn is_sensitive_method(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

fn is_normalized_route(route: &str) -> bool {
    if route.is_empty()
        || route.len() > 256
        || !route.starts_with('/')
        || route.contains('?')
        || route.contains('#')
        || route.contains("//")
        || route.chars().any(char::is_control)
    {
        return false;
    }
    route
        .split('/')
        .skip(1)
        .all(|segment| !matches!(segment, "." | ".."))
}

fn is_sha256_base64(value: &str) -> bool {
    if !(43..=44).contains(&value.len()) {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'+' | b'/' | b'-' | b'_')
            || (byte == b'=' && index + 1 == value.len())
    })
}

fn is_portable_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct AcceptSignatures;

    impl AppVaultSignatureVerifier for AcceptSignatures {
        fn verify(&self, _: &AppVaultMutation) -> Result<(), PolicyError> {
            Ok(())
        }
    }

    impl StepUpSignatureVerifier for AcceptSignatures {
        fn verify(&self, _: &ExternalStepUpProof) -> Result<(), PolicyError> {
            Ok(())
        }
    }

    struct RejectSignatures;

    impl StepUpSignatureVerifier for RejectSignatures {
        fn verify(&self, _: &ExternalStepUpProof) -> Result<(), PolicyError> {
            Err(PolicyError::SignatureRejected)
        }
    }

    fn active_device() -> AuthenticatedDevice<'static> {
        AuthenticatedDevice {
            subject: "user-1",
            device_id: "cliptown-device-a",
            lifecycle_state: DeviceLifecycleState::Active,
        }
    }

    fn mutation(id: &str, source_device_id: &str, logical_clock: u64) -> serde_json::Value {
        json!({
            "protocol_version": 1,
            "mutation_id": id,
            "app_id": THREE_FA_APP_ID,
            "namespace": THREE_FA_NAMESPACE,
            "opaque_record_id": format!("opaque_record_id_{logical_clock:016}"),
            "payload": {
                "algorithm": "xchacha20poly1305-v1",
                "nonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "ciphertext": "AQIDBA==",
                "associated_data_hash": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "key_id": "key-1"
            },
            "deleted": false,
            "source_device_id": source_device_id,
            "logical_clock": logical_clock,
            "created_at": "2026-07-30T12:00:00Z",
            "updated_at": "2026-07-30T12:00:01Z",
            "device_signature": "A".repeat(88)
        })
    }

    fn push_request(values: Vec<serde_json::Value>) -> AppVaultPushRequest {
        serde_json::from_value(json!({"mutations": values, "base": null})).unwrap()
    }

    fn proof() -> ExternalStepUpProof {
        serde_json::from_value(json!({
            "protocol_version": 1,
            "proof_id": "proof-1",
            "issuer": THREE_FA_STEP_UP_ISSUER,
            "subject": "user-1",
            "audience": CLIPTOWN_STEP_UP_AUDIENCE,
            "device_id": "threefa-device-a",
            "challenge_id": "challenge-1",
            "action": "revoke_device",
            "issued_at": "2026-07-30T12:00:10Z",
            "expires_at": "2026-07-30T12:02:00Z",
            "signing_key_id": "threefa-signing-key-1",
            "signature": "A".repeat(88)
        }))
        .unwrap()
    }

    fn request_context() -> ProtectedRequestContext<'static> {
        ProtectedRequestContext {
            subject: "user-1",
            initiating_device_id: "cliptown-device-a",
            action: ExternalStepUpAction::RevokeDevice,
            method: "DELETE",
            normalized_route: "/v1/devices/device-b",
            target_resource_id: Some("device-b"),
            request_body_sha256_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }
    }

    fn challenge() -> StepUpChallenge<'static> {
        let proof = proof();
        StepUpChallenge {
            challenge_id: "challenge-1",
            subject: "user-1",
            initiating_device_id: "cliptown-device-a",
            audience: CLIPTOWN_STEP_UP_AUDIENCE,
            action: ExternalStepUpAction::RevokeDevice,
            method: "DELETE",
            normalized_route: "/v1/devices/device-b",
            target_resource_id: Some("device-b"),
            request_body_sha256_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            created_at_unix_seconds: proof.issued_at.timestamp() - 10,
            expires_at_unix_seconds: proof.expires_at.timestamp(),
            consumed: false,
            invalidated: false,
        }
    }

    #[test]
    fn active_device_can_push_verified_threefa_ciphertext() {
        let request = push_request(vec![
            mutation("mutation-1", "cliptown-device-a", 7),
            mutation("mutation-2", "cliptown-device-a", 8),
        ]);
        let now = request.mutations[0].updated_at.timestamp() + 1;

        let validated = validate_app_vault_push(
            now,
            THREE_FA_APP_ID,
            &request,
            active_device(),
            AppVaultPolicy::default(),
            &AcceptSignatures,
        )
        .unwrap();

        assert_eq!(validated.mutation_count, 2);
        assert_eq!(validated.highest_logical_clock, 8);
    }

    #[test]
    fn app_vault_rejects_sibling_credentials_and_duplicate_mutations() {
        let wrong_device = push_request(vec![mutation("mutation-1", "another-cliptown-device", 7)]);
        let now = wrong_device.mutations[0].updated_at.timestamp() + 1;
        assert_eq!(
            validate_app_vault_push(
                now,
                THREE_FA_APP_ID,
                &wrong_device,
                active_device(),
                AppVaultPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::SourceDeviceMismatch)
        );

        let duplicates = push_request(vec![
            mutation("mutation-1", "cliptown-device-a", 7),
            mutation("mutation-1", "cliptown-device-a", 8),
        ]);
        assert_eq!(
            validate_app_vault_push(
                now,
                THREE_FA_APP_ID,
                &duplicates,
                active_device(),
                AppVaultPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::DuplicateMutation)
        );

        let out_of_range = push_request(vec![mutation(
            "mutation-out-of-range",
            "cliptown-device-a",
            i64::MAX as u64 + 1,
        )]);
        assert_eq!(
            validate_app_vault_push(
                now,
                THREE_FA_APP_ID,
                &out_of_range,
                active_device(),
                AppVaultPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::LogicalClockOutOfRange)
        );
    }

    #[test]
    fn revoked_devices_cannot_push_or_approve_sensitive_requests() {
        let request = push_request(vec![mutation("mutation-1", "cliptown-device-a", 7)]);
        let revoked = AuthenticatedDevice {
            lifecycle_state: DeviceLifecycleState::Revoked,
            ..active_device()
        };
        let now = request.mutations[0].updated_at.timestamp() + 1;
        assert_eq!(
            validate_app_vault_push(
                now,
                THREE_FA_APP_ID,
                &request,
                revoked,
                AppVaultPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::InactiveDevice)
        );

        let proof = proof();
        assert_eq!(
            validate_step_up_authorization(
                proof.issued_at.timestamp() + 1,
                &request_context(),
                &challenge(),
                &proof,
                revoked,
                StepUpPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::InactiveDevice)
        );
    }

    #[test]
    fn step_up_binds_the_exact_request_and_requires_a_verified_signature() {
        let proof = proof();
        let now = proof.issued_at.timestamp() + 1;
        let validated = validate_step_up_authorization(
            now,
            &request_context(),
            &challenge(),
            &proof,
            active_device(),
            StepUpPolicy::default(),
            &AcceptSignatures,
        )
        .unwrap();
        assert_eq!(validated.challenge_id, "challenge-1");
        assert_eq!(validated.proof_id, "proof-1");

        let changed_request = ProtectedRequestContext {
            target_resource_id: Some("device-c"),
            ..request_context()
        };
        assert_eq!(
            validate_step_up_authorization(
                now,
                &changed_request,
                &challenge(),
                &proof,
                active_device(),
                StepUpPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::RequestContextMismatch)
        );
        assert_eq!(
            validate_step_up_authorization(
                now,
                &request_context(),
                &challenge(),
                &proof,
                active_device(),
                StepUpPolicy::default(),
                &RejectSignatures,
            ),
            Err(PolicyError::SignatureRejected)
        );

        let short_policy = StepUpPolicy {
            max_lifetime_seconds: 60,
            ..StepUpPolicy::default()
        };
        let bounded_challenge = StepUpChallenge {
            created_at_unix_seconds: proof.issued_at.timestamp(),
            expires_at_unix_seconds: proof.issued_at.timestamp() + 60,
            ..challenge()
        };
        let overlong_proof: ExternalStepUpProof = serde_json::from_value(json!({
            "protocol_version": 1,
            "proof_id": "proof-overlong",
            "issuer": THREE_FA_STEP_UP_ISSUER,
            "subject": "user-1",
            "audience": CLIPTOWN_STEP_UP_AUDIENCE,
            "device_id": "threefa-device-a",
            "challenge_id": "challenge-1",
            "action": "revoke_device",
            "issued_at": "2026-07-30T11:59:40Z",
            "expires_at": "2026-07-30T12:01:10Z",
            "signing_key_id": "threefa-signing-key-1",
            "signature": "A".repeat(88)
        }))
        .unwrap();
        assert_eq!(
            validate_step_up_authorization(
                now,
                &request_context(),
                &bounded_challenge,
                &overlong_proof,
                active_device(),
                short_policy,
                &AcceptSignatures,
            ),
            Err(PolicyError::ProofLifetimeExceeded)
        );
    }

    #[test]
    fn consumed_or_expired_challenges_fail_closed() {
        let proof = proof();
        let now = proof.issued_at.timestamp() + 1;
        let consumed = StepUpChallenge {
            consumed: true,
            ..challenge()
        };
        assert_eq!(
            validate_step_up_authorization(
                now,
                &request_context(),
                &consumed,
                &proof,
                active_device(),
                StepUpPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::TerminalChallenge)
        );
        assert_eq!(
            validate_step_up_authorization(
                challenge().expires_at_unix_seconds,
                &request_context(),
                &challenge(),
                &proof,
                active_device(),
                StepUpPolicy::default(),
                &AcceptSignatures,
            ),
            Err(PolicyError::ChallengeExpired)
        );
    }
}
