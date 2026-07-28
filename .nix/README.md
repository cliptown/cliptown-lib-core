# Agent-first Nix contract

The canonical development entrypoints are:

```sh
nix develop
nix develop -c agent-check
nix run .#agent-check
```

`agent-check` is non-interactive and exposes named stages:

```sh
nix develop -c agent-check preflight
nix develop -c agent-check workspace
nix develop -c agent-check metadata
nix develop -c agent-check fmt
nix develop -c agent-check check
nix develop -c agent-check clippy
nix develop -c agent-check test
nix develop -c agent-check build
nix develop -c agent-check audit
```

The backend uses a sibling path dependency on `cliptown-interfaces/generated/rust`. The agent contract resolves that dependency in a repository-local workspace and pins `cliptown/cliptown-interfaces` to commit `e4e957b5372dc363fe6a52559c8959f0de781efb`; it does not silently consume a moving `main` branch. The working tree is copied with `rsync`, excluding `.git`, `.cache`, and `target`, so local changes are validated without mutating sibling directories.

Rustup, Cargo, target artifacts, the pinned `cargo-audit` binary, XDG caches, and the sibling workspace remain below `.cache/nix-agent` unless the caller explicitly overrides the corresponding environment variables. The shell never chooses cloud identities, loads secrets, prompts, or mutates global Git configuration.

## Docker / OCI

This repository currently has no production Dockerfile. Nix is the reproducible development and validation layer, not authorization to invent a runtime image. A future OCI PR must separately prove the release binary and dynamic closure, non-root UID/GID, certificates, ports, entrypoint, health and signal behavior, size/layers, SBOM/provenance, signing, vulnerability results, and deployment compatibility.
