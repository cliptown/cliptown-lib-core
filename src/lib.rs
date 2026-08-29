//! Transport-neutral ClipTown core invariants.
//!
//! `cliptown-lib-core` is the semantic consolidation point for reusable
//! ClipTown domain policy. It contains no HTTP client, Axum route, SeaORM
//! entity, generated cross-language contract, operating-system clipboard
//! integration, or plaintext conflict resolver.

#![forbid(unsafe_code)]

pub mod auth;
pub mod clip;
pub mod encrypted_objects;
pub mod error;
pub mod sync;
mod validation;

pub use auth::{
    validate_authorization, AuthorizationContext, AuthorizationPolicy, CredentialLineage,
    Operation, ResourceContext,
};
pub use clip::{CipherAlgorithm, EncryptedClip, OpaqueCiphertext};
pub use encrypted_objects::{
    EncryptedObjectChunk, EncryptedObjectManifest, ObjectGrantPolicy, WrappedContentKey,
};
pub use error::CoreError;
pub use sync::{
    validate_sync_batch, MutationKind, MutationOrderKey, SyncBatch, SyncMutation, SyncPolicy,
    ValidatedSyncBatch,
};

pub mod embedding_contract;
