use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    validation::{validate_portable_identifier, validate_sha256_base64},
    CoreError,
};

pub const DEFAULT_MAX_SYNC_BATCH_SIZE: usize = 100;
pub const DEFAULT_MAX_FUTURE_SKEW_MILLIS: i64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationKind {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncMutation {
    pub mutation_id: Uuid,
    pub clip_id: Uuid,
    pub owner_subject: String,
    pub source_device_id: String,
    pub kind: MutationKind,
    pub logical_clock: u64,
    pub created_at_unix_millis: i64,
    pub payload_sha256_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncBatch {
    pub owner_subject: String,
    pub source_device_id: String,
    pub mutations: Vec<SyncMutation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncPolicy {
    pub max_batch_size: usize,
    pub max_future_skew_millis: i64,
}

impl Default for SyncPolicy {
    fn default() -> Self {
        Self {
            max_batch_size: DEFAULT_MAX_SYNC_BATCH_SIZE,
            max_future_skew_millis: DEFAULT_MAX_FUTURE_SKEW_MILLIS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct MutationOrderKey {
    pub logical_clock: u64,
    pub source_device_id: String,
    pub mutation_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSyncBatch {
    pub mutation_count: usize,
    pub highest_logical_clock: u64,
    pub canonical_mutation_ids: Vec<Uuid>,
}

/// Validate an idempotent encrypted synchronization batch and return its
/// deterministic application order.
///
/// Conflict handling is deliberately metadata-only. The crate never receives
/// plaintext and never attempts to merge clipboard contents.
pub fn validate_sync_batch(
    now_unix_millis: i64,
    batch: &SyncBatch,
    policy: SyncPolicy,
) -> Result<ValidatedSyncBatch, CoreError> {
    if now_unix_millis < 0 || policy.max_future_skew_millis < 0 {
        return Err(CoreError::InvalidClock);
    }
    if policy.max_batch_size == 0 {
        return Err(CoreError::BatchTooLarge);
    }
    validate_portable_identifier(&batch.owner_subject)?;
    validate_portable_identifier(&batch.source_device_id)?;
    if batch.mutations.is_empty() {
        return Err(CoreError::EmptyBatch);
    }
    if batch.mutations.len() > policy.max_batch_size {
        return Err(CoreError::BatchTooLarge);
    }

    let latest_allowed_timestamp = now_unix_millis
        .checked_add(policy.max_future_skew_millis)
        .ok_or(CoreError::InvalidClock)?;
    let mut mutation_ids = HashSet::with_capacity(batch.mutations.len());
    let mut record_clocks = HashSet::with_capacity(batch.mutations.len());
    let mut order = Vec::with_capacity(batch.mutations.len());
    let mut highest_logical_clock = 0_u64;

    for mutation in &batch.mutations {
        if mutation.mutation_id.is_nil() || mutation.clip_id.is_nil() {
            return Err(CoreError::InvalidMutation);
        }
        validate_portable_identifier(&mutation.owner_subject)
            .map_err(|_| CoreError::InvalidMutation)?;
        validate_portable_identifier(&mutation.source_device_id)
            .map_err(|_| CoreError::InvalidMutation)?;
        if mutation.owner_subject != batch.owner_subject
            || mutation.source_device_id != batch.source_device_id
        {
            return Err(CoreError::OwnershipMismatch);
        }
        if mutation.logical_clock > i64::MAX as u64 {
            return Err(CoreError::LogicalClockOutOfRange);
        }
        if mutation.created_at_unix_millis < 0
            || mutation.created_at_unix_millis > latest_allowed_timestamp
        {
            return Err(CoreError::FutureMutation);
        }
        validate_sha256_base64(&mutation.payload_sha256_base64)
            .map_err(|_| CoreError::InvalidMutation)?;
        if !mutation_ids.insert(mutation.mutation_id) {
            return Err(CoreError::DuplicateMutation);
        }
        if !record_clocks.insert((
            mutation.clip_id,
            mutation.source_device_id.as_str(),
            mutation.logical_clock,
        )) {
            return Err(CoreError::DuplicateRecordClock);
        }

        highest_logical_clock = highest_logical_clock.max(mutation.logical_clock);
        order.push(MutationOrderKey {
            logical_clock: mutation.logical_clock,
            source_device_id: mutation.source_device_id.clone(),
            mutation_id: mutation.mutation_id,
        });
    }

    order.sort_unstable();
    Ok(ValidatedSyncBatch {
        mutation_count: batch.mutations.len(),
        highest_logical_clock,
        canonical_mutation_ids: order.into_iter().map(|key| key.mutation_id).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA256_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    fn mutation(id: u128, clip_id: u128, clock: u64) -> SyncMutation {
        SyncMutation {
            mutation_id: Uuid::from_u128(id),
            clip_id: Uuid::from_u128(clip_id),
            owner_subject: "user:1234".into(),
            source_device_id: "device:a".into(),
            kind: MutationKind::Upsert,
            logical_clock: clock,
            created_at_unix_millis: 1_000,
            payload_sha256_base64: SHA256_BASE64.into(),
        }
    }

    #[test]
    fn canonical_order_is_clock_device_mutation() {
        let batch = SyncBatch {
            owner_subject: "user:1234".into(),
            source_device_id: "device:a".into(),
            mutations: vec![mutation(2, 2, 9), mutation(1, 1, 7)],
        };
        let validated = validate_sync_batch(1_000, &batch, SyncPolicy::default()).unwrap();
        assert_eq!(
            validated.canonical_mutation_ids,
            vec![Uuid::from_u128(1), Uuid::from_u128(2)]
        );
        assert_eq!(validated.highest_logical_clock, 9);
    }

    #[test]
    fn duplicate_idempotency_keys_and_record_clocks_are_rejected() {
        let duplicate_id = SyncBatch {
            owner_subject: "user:1234".into(),
            source_device_id: "device:a".into(),
            mutations: vec![mutation(1, 1, 7), mutation(1, 2, 8)],
        };
        assert_eq!(
            validate_sync_batch(1_000, &duplicate_id, SyncPolicy::default()),
            Err(CoreError::DuplicateMutation)
        );

        let duplicate_clock = SyncBatch {
            owner_subject: "user:1234".into(),
            source_device_id: "device:a".into(),
            mutations: vec![mutation(1, 1, 7), mutation(2, 1, 7)],
        };
        assert_eq!(
            validate_sync_batch(1_000, &duplicate_clock, SyncPolicy::default()),
            Err(CoreError::DuplicateRecordClock)
        );
    }
}
