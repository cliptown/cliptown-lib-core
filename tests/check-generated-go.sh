#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/models" "$tmp/shared" "$tmp/uuidstub"
cp "$repo_root/generated/go/gorm/models.go" "$tmp/models/models.go"
cp "$repo_root/generated/shared/go/entity_descriptors.go" "$tmp/shared/entity_descriptors.go"

cat > "$tmp/go.mod" <<'MOD'
module libcore.generated/check

go 1.23

require github.com/google/uuid v0.0.0
replace github.com/google/uuid => ./uuidstub
MOD
cat > "$tmp/uuidstub/go.mod" <<'MOD'
module github.com/google/uuid

go 1.23
MOD
cat > "$tmp/uuidstub/uuid.go" <<'GO'
package uuid

type UUID [16]byte
GO

(
  cd "$tmp"
  go test ./...
)
