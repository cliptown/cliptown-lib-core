# ClipTown Rust backend

Rust API service for encrypted ClipTown synchronization. The current foundation exposes service information, liveness, and readiness contracts; authenticated clip, device, search, and sync endpoints remain tracked in Linear.

## Run

```sh
CLIPTOWN_BIND_ADDRESS=127.0.0.1:3000 cargo run --locked
```

The service does not run database migrations at startup. PostgreSQL desired state belongs in `schema/schema.sql` and must be reviewed through the declarative migration workflow before deployment.

## Validate

```sh
cargo metadata --locked --format-version 1 --no-deps
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo build --locked --release
```

GitHub Actions runs these checks against Rust 1.85 and stable while resolving `cliptown-interfaces` from its merged `main` branch. The repository toolchain is pinned to the declared Rust 1.85 minimum so lockfile and formatter behavior remain reproducible.
