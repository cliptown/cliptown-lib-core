#!/usr/bin/env bash
set -euo pipefail

export CI="${CI:-1}"
export NO_COLOR="${NO_COLOR:-1}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

cache_root="${NIX_AGENT_CACHE_ROOT:-$repo_root/.cache/nix-agent}"
workspace_root="$cache_root/workspace"
backend_repo="$workspace_root/cliptown-rust-backend.rs"
interfaces_repo="$workspace_root/cliptown-interfaces"
interfaces_revision="e4e957b5372dc363fe6a52559c8959f0de781efb"
rust_toolchain="1.88.0"
cargo_audit_version="0.22.2"

export CARGO_HOME="${CARGO_HOME:-$cache_root/cargo-home}"
export CARGO_INSTALL_ROOT="${CARGO_INSTALL_ROOT:-$cache_root/cargo-tools}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$cache_root/target}"
export RUSTUP_HOME="${RUSTUP_HOME:-$cache_root/rustup}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-$rust_toolchain}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$cache_root/xdg}"
export PATH="$CARGO_INSTALL_ROOT/bin:$PATH"
mkdir -p \
  "$CARGO_HOME" \
  "$CARGO_INSTALL_ROOT" \
  "$CARGO_TARGET_DIR" \
  "$RUSTUP_HOME" \
  "$XDG_CACHE_HOME" \
  "$workspace_root"

ensure_rust_toolchain() {
  if ! rustup toolchain list | grep -Eq '^1\.88\.0(-|[[:space:]])'; then
    rustup toolchain install "$rust_toolchain" --profile minimal
  fi
  rustup component add --toolchain "$rust_toolchain" clippy rustfmt
}

sync_interfaces() {
  local current_revision=""

  if [[ -d "$interfaces_repo/.git" ]]; then
    current_revision="$(git -C "$interfaces_repo" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [[ "$current_revision" == "$interfaces_revision" && -f "$interfaces_repo/generated/rust/Cargo.toml" ]]; then
    return
  fi

  rm -rf "$interfaces_repo"
  mkdir -p "$interfaces_repo"
  git -C "$interfaces_repo" init -q
  git -C "$interfaces_repo" remote add origin https://github.com/cliptown/cliptown-interfaces.git
  git -C "$interfaces_repo" fetch --depth=1 origin "$interfaces_revision"
  git -C "$interfaces_repo" checkout --detach -q FETCH_HEAD

  current_revision="$(git -C "$interfaces_repo" rev-parse HEAD)"
  if [[ "$current_revision" != "$interfaces_revision" ]]; then
    printf 'ClipTown interfaces revision mismatch: expected %s, found %s\n' \
      "$interfaces_revision" \
      "$current_revision" >&2
    return 70
  fi
  test -f "$interfaces_repo/generated/rust/Cargo.toml"
}

sync_backend() {
  mkdir -p "$backend_repo"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.cache/' \
    --exclude 'target/' \
    "$repo_root/" \
    "$backend_repo/"
}

prepare_workspace() {
  sync_interfaces
  sync_backend
}

run_in_workspace() {
  prepare_workspace
  (
    cd "$backend_repo"
    "$@"
  )
}

installed_cargo_audit_version() {
  cargo audit --version 2>/dev/null || true
}

require_cargo_audit() {
  local installed_version
  installed_version="$(installed_cargo_audit_version)"
  if [[ "$installed_version" != "cargo-audit $cargo_audit_version" ]]; then
    printf 'cargo-audit %s is required, found: %s\n' \
      "$cargo_audit_version" \
      "${installed_version:-not installed}" >&2
    return 69
  fi
}

prepare_cargo_audit() {
  if [[ "$(installed_cargo_audit_version)" != "cargo-audit $cargo_audit_version" ]]; then
    cargo install cargo-audit \
      --version "$cargo_audit_version" \
      --locked \
      --root "$CARGO_INSTALL_ROOT"
  fi
  require_cargo_audit
}

run_stage() {
  local stage="$1"

  printf '\n==> agent-check stage: %s\n' "$stage" >&2
  ensure_rust_toolchain
  case "$stage" in
    preflight)
      git diff --check
      if git grep -nE '^(<<<<<<<|=======|>>>>>>>)' -- .; then
        printf '%s\n' 'unresolved Git conflict marker found' >&2
        return 1
      fi
      nixfmt --check flake.nix .nix/dev-shell.nix
      shellcheck .nix/agent-check.sh
      shfmt -i 2 -ci -d .nix/agent-check.sh
      actionlint .github/workflows/rust.yml .github/workflows/nix.yml
      nix flake check --show-trace
      rustc --version
      cargo --version
      ;;
    workspace)
      prepare_workspace
      printf 'backend workspace: %s\ninterfaces revision: %s\n' \
        "$backend_repo" \
        "$(git -C "$interfaces_repo" rev-parse HEAD)"
      ;;
    metadata)
      run_in_workspace cargo metadata --locked --format-version 1 --no-deps >/dev/null
      ;;
    fmt)
      run_in_workspace cargo fmt --all --check
      ;;
    check)
      run_in_workspace cargo check --locked --all-targets
      ;;
    clippy)
      run_in_workspace cargo clippy --locked --all-targets -- -D warnings
      ;;
    test)
      run_in_workspace cargo test --locked --all-targets -- --nocapture
      ;;
    build)
      run_in_workspace cargo build --locked --release
      ;;
    audit-prepare)
      prepare_cargo_audit
      cargo audit --version
      ;;
    audit)
      prepare_cargo_audit
      prepare_workspace
      (
        cd "$backend_repo"
        cargo audit
      )
      ;;
    *)
      printf 'unknown agent-check stage: %s\n' "$stage" >&2
      return 64
      ;;
  esac
}

case "${1:-all}" in
  all)
    for stage in preflight workspace metadata fmt check clippy test build audit; do
      run_stage "$stage"
    done
    ;;
  preflight | workspace | metadata | fmt | check | clippy | test | build | audit-prepare | audit)
    run_stage "$1"
    ;;
  *)
    printf 'usage: %s [all|preflight|workspace|metadata|fmt|check|clippy|test|build|audit-prepare|audit]\n' "$0" >&2
    exit 64
    ;;
esac
