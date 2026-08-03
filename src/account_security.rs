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
    use serde_json::json;

    const STATES: [DeviceLifecycleState; 4] = [
        DeviceLifecycleState::Pending,
        DeviceLifecycleState::Active,
        DeviceLifecycleState::Suspended,
        DeviceLifecycleState::Revoked,
    ];

    fn kdf(algorithm: &str) -> PinKdfPolicy {
        PinKdfPolicy {
            algorithm: algorithm.to_owned(),
            memory_kib: 65_536,
            iterations: 3,
            parallelism: 1,
            max_attempts: 10,
            lockout_seconds: 60,
        }
    }

    fn assert_invalid(mut policy: PinKdfPolicy, mutate: impl FnOnce(&mut PinKdfPolicy)) {
        mutate(&mut policy);
        assert!(policy.validate().is_err(), "policy unexpectedly passed: {policy:?}");
    }

    #[test]
    fn lifecycle_transition_matrix_is_exhaustive_and_revocation_is_terminal() {
        for current in STATES {
            for next in STATES {
                let expected = current == next
                    || match current {
                        DeviceLifecycleState::Pending => matches!(
                            next,
                            DeviceLifecycleState::Active
                                | DeviceLifecycleState::Suspended
                                | DeviceLifecycleState::Revoked
                        ),
                        DeviceLifecycleState::Active => matches!(
                            next,
                            DeviceLifecycleState::Suspended | DeviceLifecycleState::Revoked
                        ),
                        DeviceLifecycleState::Suspended => matches!(
                            next,
                            DeviceLifecycleState::Active | DeviceLifecycleState::Revoked
                        ),
                        DeviceLifecycleState::Revoked => false,
                    };
                assert_eq!(
                    current.can_transition_to(next),
                    expected,
                    "unexpected transition decision for {current:?} -> {next:?}"
                );
            }
        }
    }

    #[test]
    fn lifecycle_and_recovery_channels_have_stable_wire_names() {
        assert_eq!(
            serde_json::to_string(&DeviceLifecycleState::Pending).unwrap(),
            r#""pending""#
        );
        assert_eq!(
            serde_json::to_string(&DeviceLifecycleState::Suspended).unwrap(),
            r#""suspended""#
        );
        assert_eq!(
            serde_json::to_string(&RecoveryChannelKind::Email).unwrap(),
            r#""email""#
        );
        assert_eq!(
            serde_json::to_string(&RecoveryChannelKind::Phone).unwrap(),
            r#""phone""#
        );
    }

    #[test]
    fn pin_kdf_accepts_only_supported_algorithms_and_inclusive_bounds() {
        for algorithm in ["argon2id-v1", "scrypt-v1"] {
            assert_eq!(kdf(algorithm).validate(), Ok(()));
            assert_eq!(
                PinKdfPolicy {
                    algorithm: algorithm.to_owned(),
                    memory_kib: 8_192,
                    iterations: 1,
                    parallelism: 1,
                    max_attempts: 3,
                    lockout_seconds: 1,
                }
                .validate(),
                Ok(())
            );
            assert_eq!(
                PinKdfPolicy {
                    algorithm: algorithm.to_owned(),
                    memory_kib: 1_048_576,
                    iterations: 20,
                    parallelism: 8,
                    max_attempts: 20,
                    lockout_seconds: 86_400,
                }
                .validate(),
                Ok(())
            );
        }

        assert!(kdf("argon2id").validate().is_err());
        assert!(kdf("Argon2id-v1").validate().is_err());
        assert!(kdf("pbkdf2-v1").validate().is_err());
    }

    #[test]
    fn every_pin_kdf_and_throttling_bound_fails_closed() {
        let baseline = kdf("argon2id-v1");
        assert_invalid(baseline.clone(), |policy| policy.memory_kib = 8_191);
        assert_invalid(baseline.clone(), |policy| policy.memory_kib = 1_048_577);
        assert_invalid(baseline.clone(), |policy| policy.iterations = 0);
        assert_invalid(baseline.clone(), |policy| policy.iterations = 21);
        assert_invalid(baseline.clone(), |policy| policy.parallelism = 0);
        assert_invalid(baseline.clone(), |policy| policy.parallelism = 9);
        assert_invalid(baseline.clone(), |policy| policy.max_attempts = 2);
        assert_invalid(baseline.clone(), |policy| policy.max_attempts = 21);
        assert_invalid(baseline.clone(), |policy| policy.lockout_seconds = 0);
        assert_invalid(baseline, |policy| policy.lockout_seconds = 86_401);
    }

    #[test]
    fn local_unlock_requires_a_valid_kdf_when_pin_is_enabled() {
        let missing = LocalUnlockPolicy {
            pin_enabled: true,
            biometric_enabled: true,
            passkey_enabled: true,
            pin_kdf: None,
        };
        assert_eq!(
            missing.validate(),
            Err("PIN unlock requires a bounded KDF policy")
        );

        let valid = LocalUnlockPolicy {
            pin_enabled: true,
            biometric_enabled: true,
            passkey_enabled: true,
            pin_kdf: Some(kdf("argon2id-v1")),
        };
        assert_eq!(valid.validate(), Ok(()));

        let invalid_optional_policy = LocalUnlockPolicy {
            pin_enabled: false,
            biometric_enabled: true,
            passkey_enabled: false,
            pin_kdf: Some(PinKdfPolicy {
                algorithm: "unsupported".to_owned(),
                ..kdf("argon2id-v1")
            }),
        };
        assert!(invalid_optional_policy.validate().is_err());
    }

    #[test]
    fn policy_json_rejects_pin_material_and_unknown_fields() {
        let policy = LocalUnlockPolicy {
            pin_enabled: true,
            biometric_enabled: true,
            passkey_enabled: true,
            pin_kdf: Some(kdf("argon2id-v1")),
        };
        let encoded = serde_json::to_value(&policy).unwrap();
        assert_eq!(encoded["pin_enabled"], true);
        assert_eq!(encoded["pin_kdf"]["algorithm"], "argon2id-v1");
        assert!(!encoded.to_string().contains("123456"));
        assert!(!encoded.to_string().contains("fingerprint"));

        let with_pin = json!({
            "pin_enabled": true,
            "biometric_enabled": false,
            "passkey_enabled": false,
            "pin": "123456",
            "pin_kdf": {
                "algorithm": "argon2id-v1",
                "memory_kib": 65536,
                "iterations": 3,
                "parallelism": 1,
                "max_attempts": 10,
                "lockout_seconds": 60
            }
        });
        assert!(serde_json::from_value::<LocalUnlockPolicy>(with_pin).is_err());

        let with_unknown_kdf_field = json!({
            "algorithm": "argon2id-v1",
            "memory_kib": 65536,
            "iterations": 3,
            "parallelism": 1,
            "max_attempts": 10,
            "lockout_seconds": 60,
            "derived_pin_verifier": "must-not-be-accepted"
        });
        assert!(serde_json::from_value::<PinKdfPolicy>(with_unknown_kdf_field).is_err());
    }

    #[test]
    fn recovery_otp_policy_bounds_are_inclusive_and_independent() {
        assert_eq!(RecoveryOtpPolicy::default().validate(), Ok(()));
        assert_eq!(
            RecoveryOtpPolicy {
                ttl_seconds: 60,
                max_attempts: 1,
                issue_cooldown_seconds: 10,
            }
            .validate(),
            Ok(())
        );
        assert_eq!(
            RecoveryOtpPolicy {
                ttl_seconds: 900,
                max_attempts: 10,
                issue_cooldown_seconds: 3_600,
            }
            .validate(),
            Ok(())
        );

        for invalid in [
            RecoveryOtpPolicy {
                ttl_seconds: 59,
                ..RecoveryOtpPolicy::default()
            },
            RecoveryOtpPolicy {
                ttl_seconds: 901,
                ..RecoveryOtpPolicy::default()
            },
            RecoveryOtpPolicy {
                max_attempts: 0,
                ..RecoveryOtpPolicy::default()
            },
            RecoveryOtpPolicy {
                max_attempts: 11,
                ..RecoveryOtpPolicy::default()
            },
            RecoveryOtpPolicy {
                issue_cooldown_seconds: 9,
                ..RecoveryOtpPolicy::default()
            },
            RecoveryOtpPolicy {
                issue_cooldown_seconds: 3_601,
                ..RecoveryOtpPolicy::default()
            },
        ] {
            assert!(invalid.validate().is_err(), "policy unexpectedly passed: {invalid:?}");
        }
    }

    #[test]
    fn recovery_codes_accept_only_bounded_ascii_digits() {
        for valid in ["000000", "123456", "1234567890"] {
            assert!(recovery_code_is_well_formed(valid), "valid code rejected: {valid:?}");
        }
        for invalid in [
            "",
            "12345",
            "12345678901",
            "12 456",
            "12345\n",
            "+123456",
            "１２３４５６",
            "١٢٣٤٥٦",
            "abcdef",
        ] {
            assert!(
                !recovery_code_is_well_formed(invalid),
                "invalid code accepted: {invalid:?}"
            );
        }
    }
}
