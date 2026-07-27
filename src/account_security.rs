use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceLifecycleState {
    Pending,
    Active,
    Suspended,
    Revoked,
}

impl DeviceLifecycleState {
    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::Pending => matches!(next, Self::Active | Self::Suspended | Self::Revoked),
            Self::Active => matches!(next, Self::Suspended | Self::Revoked),
            Self::Suspended => matches!(next, Self::Active | Self::Revoked),
            Self::Revoked => false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryChannelKind {
    Email,
    Phone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PinKdfPolicy {
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub max_attempts: u32,
    pub lockout_seconds: u32,
}

impl PinKdfPolicy {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.algorithm.as_str(), "argon2id-v1" | "scrypt-v1") {
            return Err("unsupported PIN KDF policy");
        }
        if !(8_192..=1_048_576).contains(&self.memory_kib)
            || !(1..=20).contains(&self.iterations)
            || !(1..=8).contains(&self.parallelism)
            || !(3..=20).contains(&self.max_attempts)
            || !(1..=86_400).contains(&self.lockout_seconds)
        {
            return Err("PIN KDF or throttling policy is outside supported bounds");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalUnlockPolicy {
    pub pin_enabled: bool,
    pub biometric_enabled: bool,
    pub passkey_enabled: bool,
    pub pin_kdf: Option<PinKdfPolicy>,
}

impl LocalUnlockPolicy {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.pin_enabled && self.pin_kdf.is_none() {
            return Err("PIN unlock requires a bounded KDF policy");
        }
        if let Some(policy) = &self.pin_kdf {
            policy.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryOtpPolicy {
    pub ttl_seconds: u32,
    pub max_attempts: u32,
    pub issue_cooldown_seconds: u32,
}

impl Default for RecoveryOtpPolicy {
    fn default() -> Self {
        Self {
            ttl_seconds: 600,
            max_attempts: 5,
            issue_cooldown_seconds: 60,
        }
    }
}

impl RecoveryOtpPolicy {
    pub fn validate(self) -> Result<(), &'static str> {
        if !(60..=900).contains(&self.ttl_seconds)
            || !(1..=10).contains(&self.max_attempts)
            || !(10..=3_600).contains(&self.issue_cooldown_seconds)
        {
            return Err("recovery OTP policy is outside supported bounds");
        }
        Ok(())
    }
}

pub fn recovery_code_is_well_formed(code: &str) -> bool {
    (6..=10).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoked_device_state_is_terminal() {
        assert!(
            DeviceLifecycleState::Pending.can_transition_to(DeviceLifecycleState::Active)
        );
        assert!(
            DeviceLifecycleState::Active.can_transition_to(DeviceLifecycleState::Suspended)
        );
        assert!(
            DeviceLifecycleState::Suspended.can_transition_to(DeviceLifecycleState::Active)
        );
        assert!(
            !DeviceLifecycleState::Revoked.can_transition_to(DeviceLifecycleState::Active)
        );
    }

    #[test]
    fn pin_policy_contains_costs_not_a_pin() {
        let policy = LocalUnlockPolicy {
            pin_enabled: true,
            biometric_enabled: true,
            passkey_enabled: true,
            pin_kdf: Some(PinKdfPolicy {
                algorithm: "argon2id-v1".into(),
                memory_kib: 65_536,
                iterations: 3,
                parallelism: 1,
                max_attempts: 10,
                lockout_seconds: 60,
            }),
        };
        assert_eq!(policy.validate(), Ok(()));
        let json = serde_json::to_string(&policy).unwrap();
        assert!(!json.contains("123456"));
        assert!(!json.contains("fingerprint"));
    }

    #[test]
    fn recovery_codes_are_short_numeric_challenges() {
        assert!(recovery_code_is_well_formed("123456"));
        assert!(!recovery_code_is_well_formed("12 456"));
        assert_eq!(RecoveryOtpPolicy::default().validate(), Ok(()));
    }
}
