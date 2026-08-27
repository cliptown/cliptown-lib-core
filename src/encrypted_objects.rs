use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{
    validation::{
        decode_base64_bounded, validate_portable_identifier, validate_sha256_base64,
        validate_storage_key,
    },
    CoreError,
};

pub const MIN_CHUNK_SIZE: u32 = 64 * 1024;
pub const MAX_CHUNK_SIZE: u32 = 16 * 1024 * 1024;
pub const MAX_CHUNKS_PER_OBJECT: usize = 100_000;
pub const MAX_WRAPPED_KEYS_PER_OBJECT: usize = 128;
pub const MAX_RANDOMIZED_STORAGE_KEY_LEN: usize = 512;
pub const MAX_ENCRYPTED_METADATA_JSON_BYTES: usize = 64 * 1024;
pub const ABSOLUTE_MAX_OBJECT_BYTES: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EncryptedObjectChunk {
    pub chunk_index: u32,
    pub ciphertext_length: u64,
    pub ciphertext_sha256_base64: String,
    pub nonce_base64: String,
    pub randomized_storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WrappedContentKey {
    pub recipient_device_id: String,
    pub key_id: String,
    pub algorithm: String,
    pub nonce_base64: String,
    pub wrapped_key_base64: String,
    pub associated_data_hash_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EncryptedObjectManifest {
    pub manifest_id: String,
    pub object_id: String,
    pub clip_id: String,
    pub content_cipher_version: String,
    pub plaintext_length: u64,
    pub ciphertext_length: u64,
    pub chunk_size: u32,
    pub chunks: Vec<EncryptedObjectChunk>,
    pub wrapped_keys: Vec<WrappedContentKey>,
    pub encrypted_metadata: serde_json::Value,
    pub ciphertext_sha256_base64: String,
}

impl EncryptedObjectManifest {
    pub fn validate(&self) -> Result<(), CoreError> {
        validate_portable_identifier(&self.manifest_id)?;
        validate_portable_identifier(&self.object_id)?;
        validate_portable_identifier(&self.clip_id)?;

        if !matches!(
            self.content_cipher_version.as_str(),
            "xchacha20poly1305-chunked-v1" | "aes-256-gcm-chunked-v1"
        ) {
            return Err(CoreError::UnsupportedCipher);
        }
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&self.chunk_size)
            || self.chunks.is_empty()
            || self.chunks.len() > MAX_CHUNKS_PER_OBJECT
            || self.wrapped_keys.is_empty()
            || self.wrapped_keys.len() > MAX_WRAPPED_KEYS_PER_OBJECT
            || self.ciphertext_length == 0
            || self.ciphertext_length > ABSOLUTE_MAX_OBJECT_BYTES
            || self.plaintext_length > ABSOLUTE_MAX_OBJECT_BYTES
        {
            return Err(CoreError::InvalidManifest);
        }

        validate_sha256_base64(&self.ciphertext_sha256_base64)
            .map_err(|_| CoreError::InvalidManifest)?;
        let metadata =
            serde_json::to_vec(&self.encrypted_metadata).map_err(|_| CoreError::InvalidManifest)?;
        if metadata.len() > MAX_ENCRYPTED_METADATA_JSON_BYTES {
            return Err(CoreError::SizeLimitExceeded);
        }

        let summed_ciphertext_length =
            self.chunks
                .iter()
                .enumerate()
                .try_fold(0_u64, |sum, (position, chunk)| {
                    validate_chunk(position, chunk)?;
                    sum.checked_add(chunk.ciphertext_length)
                        .ok_or(CoreError::SizeLimitExceeded)
                })?;
        match summed_ciphertext_length == self.ciphertext_length {
            true => {}
            false => return Err(CoreError::InvalidManifest),
        }

        self.wrapped_keys.iter().try_fold(
            HashSet::with_capacity(self.wrapped_keys.len()),
            incorporate_wrapped_key,
        )?;

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectGrantPolicy {
    pub ttl_seconds: u32,
    pub max_object_bytes: u64,
    pub max_chunks: u32,
}

impl Default for ObjectGrantPolicy {
    fn default() -> Self {
        Self {
            ttl_seconds: 900,
            max_object_bytes: 2 * 1024 * 1024 * 1024,
            max_chunks: 100_000,
        }
    }
}

impl ObjectGrantPolicy {
    pub fn validate(self) -> Result<(), CoreError> {
        match (
            (60..=3_600).contains(&self.ttl_seconds),
            self.max_object_bytes > 0 && self.max_object_bytes <= ABSOLUTE_MAX_OBJECT_BYTES,
            self.max_chunks > 0 && self.max_chunks <= MAX_CHUNKS_PER_OBJECT as u32,
        ) {
            (true, true, true) => Ok(()),
            _ => Err(CoreError::GrantPolicyOutOfBounds),
        }
    }
}

fn validate_chunk(position: usize, chunk: &EncryptedObjectChunk) -> Result<(), CoreError> {
    match chunk.chunk_index as usize == position && chunk.ciphertext_length != 0 {
        true => {}
        false => return Err(CoreError::InvalidManifest),
    }
    validate_sha256_base64(&chunk.ciphertext_sha256_base64)
        .map_err(|_| CoreError::InvalidManifest)?;
    let nonce =
        decode_base64_bounded(&chunk.nonce_base64, 64).map_err(|_| CoreError::InvalidManifest)?;
    match (12..=24).contains(&nonce.len()) {
        true => {}
        false => return Err(CoreError::InvalidManifest),
    }
    validate_storage_key(
        &chunk.randomized_storage_key,
        MAX_RANDOMIZED_STORAGE_KEY_LEN,
    )
}

fn incorporate_wrapped_key<'a>(
    mut recipients: HashSet<&'a str>,
    wrapped_key: &'a WrappedContentKey,
) -> Result<HashSet<&'a str>, CoreError> {
    validate_portable_identifier(&wrapped_key.recipient_device_id)
        .map_err(|_| CoreError::InvalidWrappedKey)?;
    validate_portable_identifier(&wrapped_key.key_id).map_err(|_| CoreError::InvalidWrappedKey)?;
    validate_portable_identifier(&wrapped_key.algorithm)
        .map_err(|_| CoreError::InvalidWrappedKey)?;
    match recipients.insert(wrapped_key.recipient_device_id.as_str()) {
        true => {}
        false => return Err(CoreError::InvalidWrappedKey),
    }
    validate_wrapped_key_material(wrapped_key)?;
    Ok(recipients)
}

fn validate_wrapped_key_material(wrapped_key: &WrappedContentKey) -> Result<(), CoreError> {
    let nonce = decode_base64_bounded(&wrapped_key.nonce_base64, 64)
        .map_err(|_| CoreError::InvalidWrappedKey)?;
    match (12..=24).contains(&nonce.len()) {
        true => {}
        false => return Err(CoreError::InvalidWrappedKey),
    }
    let wrapped_key_bytes = decode_base64_bounded(&wrapped_key.wrapped_key_base64, 4_096)
        .map_err(|_| CoreError::InvalidWrappedKey)?;
    match wrapped_key_bytes.len() < 32 {
        true => return Err(CoreError::InvalidWrappedKey),
        false => {}
    }
    validate_sha256_base64(&wrapped_key.associated_data_hash_base64)
        .map_err(|_| CoreError::InvalidWrappedKey)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA256_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const NONCE_BASE64: &str = "AAAAAAAAAAAAAAAA";
    const WRAPPED_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    fn manifest() -> EncryptedObjectManifest {
        EncryptedObjectManifest {
            manifest_id: "manifest-1".into(),
            object_id: "object-1".into(),
            clip_id: "clip-1".into(),
            content_cipher_version: "aes-256-gcm-chunked-v1".into(),
            plaintext_length: 3,
            ciphertext_length: 19,
            chunk_size: MIN_CHUNK_SIZE,
            chunks: vec![EncryptedObjectChunk {
                chunk_index: 0,
                ciphertext_length: 19,
                ciphertext_sha256_base64: SHA256_BASE64.into(),
                nonce_base64: NONCE_BASE64.into(),
                randomized_storage_key: "accounts/randomized/object/chunk-0".into(),
            }],
            wrapped_keys: vec![WrappedContentKey {
                recipient_device_id: "device-a".into(),
                key_id: "key-1".into(),
                algorithm: "signal-envelope-v1".into(),
                nonce_base64: NONCE_BASE64.into(),
                wrapped_key_base64: WRAPPED_KEY_BASE64.into(),
                associated_data_hash_base64: SHA256_BASE64.into(),
            }],
            encrypted_metadata: serde_json::json!({"ciphertext": "opaque"}),
            ciphertext_sha256_base64: SHA256_BASE64.into(),
        }
    }

    #[test]
    fn manifest_preserves_donor_bounds_and_adds_length_consistency() {
        assert_eq!(manifest().validate(), Ok(()));
        assert_eq!(ObjectGrantPolicy::default().validate(), Ok(()));

        let mut mismatch = manifest();
        mismatch.ciphertext_length = 20;
        assert_eq!(mismatch.validate(), Err(CoreError::InvalidManifest));
    }

    #[test]
    fn storage_traversal_and_duplicate_recipients_are_rejected() {
        let mut traversal = manifest();
        traversal.chunks[0].randomized_storage_key = "accounts/../secret/chunk".into();
        assert_eq!(traversal.validate(), Err(CoreError::InvalidStorageKey));

        let mut duplicate = manifest();
        duplicate
            .wrapped_keys
            .push(duplicate.wrapped_keys[0].clone());
        assert_eq!(duplicate.validate(), Err(CoreError::InvalidWrappedKey));
    }
}
