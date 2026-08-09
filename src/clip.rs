use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    validation::{
        decode_base64_bounded, validate_mime_type, validate_portable_identifier,
        validate_sha256_base64,
    },
    CoreError,
};

pub const DEFAULT_MAX_INLINE_CIPHERTEXT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CipherAlgorithm {
    Xchacha20poly1305V1,
    Aes256GcmV1,
}

impl CipherAlgorithm {
    #[must_use]
    pub const fn nonce_bytes(self) -> usize {
        match self {
            Self::Xchacha20poly1305V1 => 24,
            Self::Aes256GcmV1 => 12,
        }
    }
}

/// Opaque encrypted content. Plaintext is intentionally absent from the core
/// domain model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpaqueCiphertext {
    pub algorithm: CipherAlgorithm,
    pub nonce_base64: String,
    pub ciphertext_base64: String,
    pub associated_data_sha256_base64: String,
}

impl OpaqueCiphertext {
    pub fn validate(&self, max_ciphertext_bytes: usize) -> Result<usize, CoreError> {
        if max_ciphertext_bytes == 0 {
            return Err(CoreError::SizeLimitExceeded);
        }

        let nonce = decode_base64_bounded(&self.nonce_base64, 64)?;
        if nonce.len() != self.algorithm.nonce_bytes() {
            return Err(CoreError::InvalidCiphertext);
        }
        validate_sha256_base64(&self.associated_data_sha256_base64)?;
        let ciphertext = decode_base64_bounded(&self.ciphertext_base64, max_ciphertext_bytes)?;
        Ok(ciphertext.len())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EncryptedClip {
    pub clip_id: Uuid,
    pub owner_subject: String,
    pub source_device_id: String,
    pub media_type: String,
    pub payload: OpaqueCiphertext,
    pub logical_clock: u64,
    pub created_at_unix_millis: i64,
    pub updated_at_unix_millis: i64,
    pub deleted_at_unix_millis: Option<i64>,
}

impl EncryptedClip {
    pub fn validate(&self, max_ciphertext_bytes: usize) -> Result<usize, CoreError> {
        if self.clip_id.is_nil() {
            return Err(CoreError::InvalidIdentifier);
        }
        validate_portable_identifier(&self.owner_subject)?;
        validate_portable_identifier(&self.source_device_id)?;
        validate_mime_type(&self.media_type)?;

        if self.logical_clock > i64::MAX as u64 {
            return Err(CoreError::LogicalClockOutOfRange);
        }
        if self.created_at_unix_millis < 0
            || self.updated_at_unix_millis < self.created_at_unix_millis
            || self
                .deleted_at_unix_millis
                .is_some_and(|deleted_at| deleted_at < self.updated_at_unix_millis)
        {
            return Err(CoreError::InvalidClock);
        }

        self.payload.validate(max_ciphertext_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA256_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const XCHACHA_NONCE_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn clip() -> EncryptedClip {
        EncryptedClip {
            clip_id: Uuid::from_u128(1),
            owner_subject: "user:1234".into(),
            source_device_id: "device:abcd".into(),
            media_type: "text/plain".into(),
            payload: OpaqueCiphertext {
                algorithm: CipherAlgorithm::Xchacha20poly1305V1,
                nonce_base64: XCHACHA_NONCE_BASE64.into(),
                ciphertext_base64: "b3BhcXVlLWNpcGhlcnRleHQ=".into(),
                associated_data_sha256_base64: SHA256_BASE64.into(),
            },
            logical_clock: 7,
            created_at_unix_millis: 1_000,
            updated_at_unix_millis: 1_010,
            deleted_at_unix_millis: None,
        }
    }

    #[test]
    fn encrypted_clip_has_no_plaintext_and_validates_bounds() {
        assert_eq!(clip().validate(DEFAULT_MAX_INLINE_CIPHERTEXT_BYTES), Ok(17));
    }

    #[test]
    fn timestamp_and_nonce_invariants_fail_closed() {
        let mut invalid_time = clip();
        invalid_time.updated_at_unix_millis = 999;
        assert_eq!(
            invalid_time.validate(DEFAULT_MAX_INLINE_CIPHERTEXT_BYTES),
            Err(CoreError::InvalidClock)
        );

        let mut invalid_nonce = clip();
        invalid_nonce.payload.nonce_base64 = "AA==".into();
        assert_eq!(
            invalid_nonce.validate(DEFAULT_MAX_INLINE_CIPHERTEXT_BYTES),
            Err(CoreError::InvalidCiphertext)
        );
    }
}
