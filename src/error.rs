use thiserror::Error;

/// A bounded, transport-neutral failure returned by ClipTown core validation.
///
/// Variants intentionally carry no user-controlled text, ciphertext, tokens, or
/// identifiers so callers can safely map them to stable API error codes.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    #[error("identifier is invalid")]
    InvalidIdentifier,
    #[error("clock input is invalid")]
    InvalidClock,
    #[error("authorization audience is invalid")]
    InvalidAudience,
    #[error("authorization client is invalid")]
    InvalidClient,
    #[error("credential lineage is invalid for this operation")]
    InvalidCredentialLineage,
    #[error("credential has been revoked")]
    RevokedCredential,
    #[error("credential has expired")]
    ExpiredCredential,
    #[error("required scope is missing")]
    MissingScope,
    #[error("assurance level is insufficient")]
    InsufficientAssurance,
    #[error("step-up authentication is stale")]
    StaleStepUp,
    #[error("resource ownership does not match the authenticated subject")]
    OwnershipMismatch,
    #[error("ciphertext envelope is invalid")]
    InvalidCiphertext,
    #[error("cipher algorithm is unsupported")]
    UnsupportedCipher,
    #[error("encrypted object manifest is invalid")]
    InvalidManifest,
    #[error("randomized storage key is invalid")]
    InvalidStorageKey,
    #[error("wrapped content key is invalid")]
    InvalidWrappedKey,
    #[error("object grant policy is outside supported bounds")]
    GrantPolicyOutOfBounds,
    #[error("synchronization batch is empty")]
    EmptyBatch,
    #[error("synchronization batch exceeds policy")]
    BatchTooLarge,
    #[error("synchronization mutation is invalid")]
    InvalidMutation,
    #[error("synchronization mutation is duplicated")]
    DuplicateMutation,
    #[error("synchronization record clock is duplicated")]
    DuplicateRecordClock,
    #[error("synchronization mutation is too far in the future")]
    FutureMutation,
    #[error("logical clock exceeds the supported range")]
    LogicalClockOutOfRange,
    #[error("payload exceeds the supported size")]
    SizeLimitExceeded,
}

impl CoreError {
    /// Stable machine-readable code suitable for API and SDK mappings.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidIdentifier => "invalid_identifier",
            Self::InvalidClock => "invalid_clock",
            Self::InvalidAudience => "invalid_audience",
            Self::InvalidClient => "invalid_client",
            Self::InvalidCredentialLineage => "invalid_credential_lineage",
            Self::RevokedCredential => "revoked_credential",
            Self::ExpiredCredential => "expired_credential",
            Self::MissingScope => "missing_scope",
            Self::InsufficientAssurance => "insufficient_assurance",
            Self::StaleStepUp => "stale_step_up",
            Self::OwnershipMismatch => "ownership_mismatch",
            Self::InvalidCiphertext => "invalid_ciphertext",
            Self::UnsupportedCipher => "unsupported_cipher",
            Self::InvalidManifest => "invalid_manifest",
            Self::InvalidStorageKey => "invalid_storage_key",
            Self::InvalidWrappedKey => "invalid_wrapped_key",
            Self::GrantPolicyOutOfBounds => "grant_policy_out_of_bounds",
            Self::EmptyBatch => "empty_batch",
            Self::BatchTooLarge => "batch_too_large",
            Self::InvalidMutation => "invalid_mutation",
            Self::DuplicateMutation => "duplicate_mutation",
            Self::DuplicateRecordClock => "duplicate_record_clock",
            Self::FutureMutation => "future_mutation",
            Self::LogicalClockOutOfRange => "logical_clock_out_of_range",
            Self::SizeLimitExceeded => "size_limit_exceeded",
        }
    }
}
