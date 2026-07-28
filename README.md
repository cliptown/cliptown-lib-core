# ClipTown Rust backend

Rust API service for encrypted ClipTown synchronization. The current foundation exposes service information, liveness, and readiness contracts. DEN-42/DEN-45/DEN-47/DEN-51 add reviewed account-security, Signal Protocol relay, PostgreSQL/Supabase, and encrypted Cloudflare R2 storage foundations without enabling unauthenticated placeholder routes.

## Security model

- Flutter encrypts clipboard text, metadata, images, and files before upload.
- PostgreSQL/Supabase and R2 store opaque ciphertext plus bounded routing/integrity metadata.
- Signal Protocol sessions enroll devices and deliver small wrapped account/clip/object keys; large objects use chunked AEAD with random content keys.
- Backup email and phone OTP are recovery/step-up channels only.
- Biometrics remain in platform authenticators; a six-digit PIN is local-only and never an encryption key or server credential.
- See [`docs/security-storage.md`](docs/security-storage.md).

## Run

```sh
CLIPTOWN_BIND_ADDRESS=127.0.0.1:3000 cargo run --locked
```

The service does not run database migrations at startup. PostgreSQL desired state belongs in [`schema/schema.sql`](schema/schema.sql) and must be reviewed through the declarative migration workflow before deployment.

## Validate

```sh
cargo metadata --locked --format-version 1 --no-deps
cargo tree --locked -e normal,build -i rsa
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo build --locked --release
nix develop -c agent-check audit
```

GitHub Actions runs the Rust checks against Rust 1.88 and stable. Both native and Nix CI resolve `cliptown-interfaces` at commit `e4e957b5372dc363fe6a52559c8959f0de781efb`, avoiding a moving sibling dependency while retaining the repository's declared Rust 1.88 minimum required by the locked SeaORM/ICU/time dependency graph.

SeaORM default features remain disabled because this service uses PostgreSQL only. Cargo may retain optional SQLx MySQL/SQLite package metadata in `Cargo.lock`, but native and Nix CI fail if `rsa`, `sqlx-mysql`, or `sqlx-sqlite` becomes reachable in the active normal/build dependency graph. RustSec advisory `RUSTSEC-2023-0071` is ignored only after that reachability proof; every other advisory remains fail-closed.
