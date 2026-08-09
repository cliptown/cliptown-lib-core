# cliptown-lib-core

`cliptown-lib-core` is the reusable Rust policy layer for ClipTown. It
consolidates the transport-neutral parts of the earlier library/core/sync
split while keeping generated contracts, clients, database models, server
routes, and platform clipboard integration in their existing repositories.

## Responsibilities

- revocation-aware authorization policy with explicit credential-lineage
  separation;
- subject ownership, stable scopes, and fresh LOA2 requirements for writes
  and deletes;
- opaque encrypted clipboard records with bounded identifiers, timestamps,
  nonces, hashes, and payload sizes;
- chunked encrypted-object manifests, unique recipient key wrapping, safe
  randomized storage keys, and bounded object grants;
- deterministic metadata-only synchronization, idempotency, monotonic logical
  clocks, and duplicate detection.

## Non-responsibilities

This crate does **not** parse or verify JWTs, hold encryption keys, implement a
cipher, read plaintext clipboard contents, access the operating-system
clipboard, call HTTP APIs, persist SeaORM entities, or replace generated API
interfaces. Those boundaries stay in the official Shared Auth SDK,
`cliptown-interfaces`, `cliptown-clients`, backend services, and platform apps.

## Verification

```bash
cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps
```

The initial repository head is a semantic multi-parent merge. Its tree is the
reviewed `cliptown-lib-core` implementation, while its additional parents keep
the exact donor histories reachable for provenance and future archaeology.
See [`docs/PROVENANCE.md`](docs/PROVENANCE.md).
