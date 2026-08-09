use serde::{Deserialize, Serialize};

use crate::{validation::validate_portable_identifier, CoreError};

pub const CLIPTOWN_API_AUDIENCE: &str = "cliptown-api";
pub const CLIPTOWN_READ_SCOPE: &str = "cliptown:clips:read";
pub const CLIPTOWN_WRITE_SCOPE: &str = "cliptown:clips:write";
pub const CLIPTOWN_DELETE_SCOPE: &str = "cliptown:clips:delete";
pub const DEFAULT_MAX_STEP_UP_AGE_SECONDS: i64 = 300;
pub const DEFAULT_MAX_CLOCK_SKEW_SECONDS: i64 = 60;

/// Credential classes are intentionally explicit so an object-download grant
/// cannot be replayed against the ClipTown control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialLineage {
    SharedAuthSession,
    DeviceSession,
    ObjectGrant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Read,
    Write,
    Delete,
}

impl Operation {
    #[must_use]
    pub const fn required_scope(self) -> &'static str {
        match self {
            Self::Read => CLIPTOWN_READ_SCOPE,
            Self::Write => CLIPTOWN_WRITE_SCOPE,
            Self::Delete => CLIPTOWN_DELETE_SCOPE,
        }
    }

    #[must_use]
    pub const fn requires_fresh_loa2(self) -> bool {
        matches!(self, Self::Write | Self::Delete)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizationContext<'a> {
    pub subject: &'a str,
    pub audience: &'a str,
    pub client_id: &'a str,
    pub lineage: CredentialLineage,
    pub scopes: &'a [&'a str],
    pub assurance_level: u8,
    pub authenticated_at_unix_seconds: i64,
    pub expires_at_unix_seconds: i64,
    pub revoked_at_unix_seconds: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceContext<'a> {
    pub owner_subject: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizationPolicy<'a> {
    pub expected_audience: &'a str,
    pub expected_client_id: &'a str,
    pub max_step_up_age_seconds: i64,
    pub max_clock_skew_seconds: i64,
}

impl<'a> AuthorizationPolicy<'a> {
    #[must_use]
    pub const fn new(expected_client_id: &'a str) -> Self {
        Self {
            expected_audience: CLIPTOWN_API_AUDIENCE,
            expected_client_id,
            max_step_up_age_seconds: DEFAULT_MAX_STEP_UP_AGE_SECONDS,
            max_clock_skew_seconds: DEFAULT_MAX_CLOCK_SKEW_SECONDS,
        }
    }
}

/// Validate reusable control-plane authorization invariants.
///
/// This function does not parse or verify a token. The caller must supply a
/// cryptographically verified and revocation-aware context produced by the
/// official Shared Auth or ClipTown SDK boundary.
pub fn validate_authorization(
    now_unix_seconds: i64,
    operation: Operation,
    authorization: AuthorizationContext<'_>,
    resource: ResourceContext<'_>,
    policy: AuthorizationPolicy<'_>,
) -> Result<(), CoreError> {
    if now_unix_seconds < 0
        || policy.max_step_up_age_seconds <= 0
        || policy.max_clock_skew_seconds < 0
    {
        return Err(CoreError::InvalidClock);
    }

    validate_portable_identifier(authorization.subject)?;
    validate_portable_identifier(resource.owner_subject)?;
    validate_portable_identifier(authorization.client_id)?;
    validate_portable_identifier(policy.expected_client_id)?;

    if authorization.audience != policy.expected_audience {
        return Err(CoreError::InvalidAudience);
    }
    if authorization.client_id != policy.expected_client_id {
        return Err(CoreError::InvalidClient);
    }
    if authorization.lineage == CredentialLineage::ObjectGrant {
        return Err(CoreError::InvalidCredentialLineage);
    }
    if authorization.expires_at_unix_seconds <= now_unix_seconds {
        return Err(CoreError::ExpiredCredential);
    }
    let latest_allowed_now = now_unix_seconds
        .checked_add(policy.max_clock_skew_seconds)
        .ok_or(CoreError::InvalidClock)?;
    if authorization
        .revoked_at_unix_seconds
        .is_some_and(|revoked_at| revoked_at <= latest_allowed_now)
    {
        return Err(CoreError::RevokedCredential);
    }
    if authorization.subject != resource.owner_subject {
        return Err(CoreError::OwnershipMismatch);
    }
    if !authorization
        .scopes
        .iter()
        .any(|scope| *scope == operation.required_scope())
    {
        return Err(CoreError::MissingScope);
    }

    let latest_allowed_authentication = latest_allowed_now;
    if authorization.authenticated_at_unix_seconds < 0
        || authorization.authenticated_at_unix_seconds > latest_allowed_authentication
    {
        return Err(CoreError::InvalidClock);
    }

    if operation.requires_fresh_loa2() {
        if authorization.assurance_level < 2 {
            return Err(CoreError::InsufficientAssurance);
        }
        let age = now_unix_seconds
            .checked_sub(authorization.authenticated_at_unix_seconds)
            .ok_or(CoreError::InvalidClock)?;
        if age > policy.max_step_up_age_seconds {
            return Err(CoreError::StaleStepUp);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context<'a>(scopes: &'a [&'a str]) -> AuthorizationContext<'a> {
        AuthorizationContext {
            subject: "user:1234",
            audience: CLIPTOWN_API_AUDIENCE,
            client_id: "cliptown.desktop",
            lineage: CredentialLineage::SharedAuthSession,
            scopes,
            assurance_level: 2,
            authenticated_at_unix_seconds: 980,
            expires_at_unix_seconds: 2_000,
            revoked_at_unix_seconds: None,
        }
    }

    #[test]
    fn write_requires_owner_scope_and_fresh_loa2() {
        let scopes = [CLIPTOWN_WRITE_SCOPE];
        assert_eq!(
            validate_authorization(
                1_000,
                Operation::Write,
                context(&scopes),
                ResourceContext {
                    owner_subject: "user:1234",
                },
                AuthorizationPolicy::new("cliptown.desktop"),
            ),
            Ok(())
        );

        let mut stale = context(&scopes);
        stale.authenticated_at_unix_seconds = 600;
        assert_eq!(
            validate_authorization(
                1_000,
                Operation::Write,
                stale,
                ResourceContext {
                    owner_subject: "user:1234",
                },
                AuthorizationPolicy::new("cliptown.desktop"),
            ),
            Err(CoreError::StaleStepUp)
        );
    }

    #[test]
    fn object_grants_cannot_call_control_plane() {
        let scopes = [CLIPTOWN_READ_SCOPE];
        let mut object_grant = context(&scopes);
        object_grant.lineage = CredentialLineage::ObjectGrant;
        assert_eq!(
            validate_authorization(
                1_000,
                Operation::Read,
                object_grant,
                ResourceContext {
                    owner_subject: "user:1234",
                },
                AuthorizationPolicy::new("cliptown.desktop"),
            ),
            Err(CoreError::InvalidCredentialLineage)
        );
    }

    #[test]
    fn revoked_and_cross_subject_credentials_fail_closed() {
        let scopes = [CLIPTOWN_READ_SCOPE];
        let mut revoked = context(&scopes);
        revoked.revoked_at_unix_seconds = Some(999);
        assert_eq!(
            validate_authorization(
                1_000,
                Operation::Read,
                revoked,
                ResourceContext {
                    owner_subject: "user:1234",
                },
                AuthorizationPolicy::new("cliptown.desktop"),
            ),
            Err(CoreError::RevokedCredential)
        );

        assert_eq!(
            validate_authorization(
                1_000,
                Operation::Read,
                context(&scopes),
                ResourceContext {
                    owner_subject: "user:other",
                },
                AuthorizationPolicy::new("cliptown.desktop"),
            ),
            Err(CoreError::OwnershipMismatch)
        );
    }
}
