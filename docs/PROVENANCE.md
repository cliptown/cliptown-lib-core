# Provenance and semantic merge

The initial `main` head preserves the reviewed donor histories as additional
Git parents. No donor side was mechanically chosen wholesale. The resulting
working tree retains only code appropriate to the transport-neutral core.

| Donor | Reviewed head | Retained concept |
| --- | --- | --- |
| `cliptown/cliptown-interfaces` | `ec4f820bcc9181c2423a6963d3890ddc8ef18b97` | generated-contract boundary, Git-consumable Rust workspace, and package topology |
| `cliptown/cliptown-rust-backend.rs` | `c1953e0519e952c682a4e59dc6a931aab7b29cad` | encrypted-object limits, app-vault batch invariants, authorization hardening |
| `cliptown/cliptown-clients` | `8ee49a596c32950efa49f17a5894a5137da633b2` | official SDK boundary and no-fallback transport policy |
| `cliptown/cliptown-monorepo` | `fdf9d869fe4ab711fc69198f26f5dbd4de846acc` | integration topology and cross-repository placement |

The merge intentionally excludes Axum handlers, SeaORM entities, HTTP clients,
generated language models, local IPC, deep-link fallbacks, application-presence
probing, OS clipboard code, and plaintext conflict resolution.
