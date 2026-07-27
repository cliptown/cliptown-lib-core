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
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo build --locked --release
```

GitHub Actions runs these checks against Rust 1.88 and stable while resolving `cliptown-interfaces` from its merged `main` branch. The repository toolchain is pinned to the declared Rust 1.88 minimum required by the locked SeaORM/ICU/time dependency graph.
