use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const MIN_CHUNK_SIZE: u32 = 64 * 1024;
pub const MAX_CHUNK_SIZE: u32 = 16 * 1024 * 1024;
pub const MAX_CHUNKS_PER_OBJECT: usize = 100_000;
pub const MAX_WRAPPED_KEYS_PER_OBJECT: usize = 128;
pub const MAX_RANDOMIZED_STORAGE_KEY_LEN: usize = 512;

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
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(
            self.content_cipher_version.as_str(),
            "xchacha20poly1305-chunked-v1" | "aes-256-gcm-chunked-v1"
        ) {
            return Err("unsupported object cipher version");
        }
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&self.chunk_size)
            || self.chunks.is_empty()
            || self.chunks.len() > MAX_CHUNKS_PER_OBJECT
            || self.wrapped_keys.is_empty()
            || self.wrapped_keys.len() > MAX_WRAPPED_KEYS_PER_OBJECT
        {
            return Err("object manifest counts or chunk size are outside bounds");
        }
        for (position, chunk) in self.chunks.iter().enumerate() {
            if chunk.chunk_index as usize != position
                || chunk.ciphertext_length == 0
                || chunk.ciphertext_sha256_base64.is_empty()
                || chunk.nonce_base64.is_empty()
                || !(16..=MAX_RANDOMIZED_STORAGE_KEY_LEN)
                    .contains(&chunk.randomized_storage_key.len())
                || chunk.randomized_storage_key.contains("..")
                || chunk.randomized_storage_key.starts_with('/')
            {
                return Err("object chunks must be contiguous, complete, and randomized");
            }
        }
        let recipients: HashSet<&str> = self
            .wrapped_keys
            .iter()
            .map(|key| key.recipient_device_id.as_str())
            .collect();
        if recipients.len() != self.wrapped_keys.len() {
            return Err("wrapped keys must be unique per recipient device");
        }
        if self
            .wrapped_keys
            .iter()
            .any(|key| key.wrapped_key_base64.is_empty() || key.associated_data_hash_base64.is_empty())
        {
            return Err("wrapped content keys are incomplete");
        }
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
    pub fn validate(self) -> Result<(), &'static str> {
        if !(60..=3_600).contains(&self.ttl_seconds)
            || self.max_object_bytes == 0
            || self.max_object_bytes > 16 * 1024 * 1024 * 1024
            || self.max_chunks == 0
            || self.max_chunks > 100_000
        {
            return Err("object grant policy is outside supported bounds");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_keys_reject_paths_and_wrapped_keys_are_per_device() {
        let manifest = EncryptedObjectManifest {
            manifest_id: "manifest-1".into(),
            object_id: "object-1".into(),
            clip_id: "clip-1".into(),
            content_cipher_version: "xchacha20poly1305-chunked-v1".into(),
            plaintext_length: 3,
            ciphertext_length: 19,
            chunk_size: MIN_CHUNK_SIZE,
            chunks: vec![EncryptedObjectChunk {
                chunk_index: 0,
                ciphertext_length: 19,
                ciphertext_sha256_base64: "digest".into(),
                nonce_base64: "nonce".into(),
                randomized_storage_key: "accounts/randomized/object/chunk-0".into(),
            }],
            wrapped_keys: vec![WrappedContentKey {
                recipient_device_id: "device-a".into(),
                key_id: "key-1".into(),
                algorithm: "signal-envelope-v1".into(),
                nonce_base64: "nonce".into(),
                wrapped_key_base64: "wrapped".into(),
                associated_data_hash_base64: "aad".into(),
            }],
            encrypted_metadata: serde_json::json!({"ciphertext": "opaque"}),
            ciphertext_sha256_base64: "aggregate".into(),
        };
        assert_eq!(manifest.validate(), Ok(()));
        assert_eq!(ObjectGrantPolicy::default().validate(), Ok(()));
    }
}
