use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::CoreError;

pub(crate) const SHA256_BYTES: usize = 32;

pub(crate) fn validate_portable_identifier(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 128
        || value.contains("..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
        })
    {
        return Err(CoreError::InvalidIdentifier);
    }
    Ok(())
}

/// Enforces the RFC token alphabet; media type parameters are intentionally
/// excluded from immutable ciphertext metadata.
fn valid_mime_token(token: &str) -> bool {
    !token.is_empty()
        && token.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

pub(crate) fn validate_mime_type(value: &str) -> Result<(), CoreError> {
    let Some((top_level, subtype)) = value.split_once('/') else {
        return Err(CoreError::InvalidCiphertext);
    };
    if value.len() > 127 || !valid_mime_token(top_level) || !valid_mime_token(subtype) {
        return Err(CoreError::InvalidCiphertext);
    }
    Ok(())
}

pub(crate) fn decode_base64_bounded(
    value: &str,
    max_decoded_bytes: usize,
) -> Result<Vec<u8>, CoreError> {
    if value.is_empty() {
        return Err(CoreError::InvalidCiphertext);
    }

    let encoded_limit = max_decoded_bytes
        .checked_add(2)
        .and_then(|length| length.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or(CoreError::SizeLimitExceeded)?;
    if value.len() > encoded_limit {
        return Err(CoreError::SizeLimitExceeded);
    }

    let decoded = STANDARD
        .decode(value)
        .map_err(|_| CoreError::InvalidCiphertext)?;
    if decoded.is_empty() || decoded.len() > max_decoded_bytes {
        return Err(CoreError::InvalidCiphertext);
    }
    Ok(decoded)
}

pub(crate) fn validate_sha256_base64(value: &str) -> Result<(), CoreError> {
    let decoded = decode_base64_bounded(value, SHA256_BYTES)?;
    if decoded.len() != SHA256_BYTES {
        return Err(CoreError::InvalidCiphertext);
    }
    Ok(())
}

pub(crate) fn validate_storage_key(value: &str, max_len: usize) -> Result<(), CoreError> {
    if !(16..=max_len).contains(&value.len())
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains("..")
        || value.contains("//")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
    {
        return Err(CoreError::InvalidStorageKey);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_identifiers_are_bounded_and_path_free() {
        assert_eq!(validate_portable_identifier("user:1234-device_a"), Ok(()));
        assert_eq!(
            validate_portable_identifier("../tenant"),
            Err(CoreError::InvalidIdentifier)
        );
        assert_eq!(
            validate_portable_identifier("tenant/user"),
            Err(CoreError::InvalidIdentifier)
        );
    }

    #[test]
    fn media_types_require_two_exact_tokens_without_params() {
        for valid in [
            "text/plain",
            "application/vnd.cliptown+json",
            "image/svg+xml",
        ] {
            assert_eq!(validate_mime_type(valid), Ok(()));
        }
        for invalid in [
            "",
            "/plain",
            "text/",
            "text/plain;charset=utf-8",
            "text/plain?auth=secret",
            "text/plain/extra",
            "text/pla in",
            "text/<script>",
            "text\\plain",
        ] {
            assert_eq!(
                validate_mime_type(invalid),
                Err(CoreError::InvalidCiphertext)
            );
        }
    }

    #[test]
    fn storage_keys_allow_namespaces_but_reject_traversal() {
        assert_eq!(
            validate_storage_key("accounts/randomized/object/chunk-0", 512),
            Ok(())
        );
        assert_eq!(
            validate_storage_key("accounts/../secrets", 512),
            Err(CoreError::InvalidStorageKey)
        );
    }
}
