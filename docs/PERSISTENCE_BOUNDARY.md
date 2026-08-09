# Persistence boundary

ClipTown persists encrypted object metadata, recipient-specific wrapped keys,
device registrations, record metadata, and synchronization cursors. It does
not persist clipboard plaintext, unwrapped content keys, decrypted payloads, or
server-side key custody.

`cliptown-interfaces` owns wire-level types. `cliptown-lib-core` owns shared
policy, validation, stable identifiers, and generated persistence definitions.
API/web/desktop/mobile adapters own actual connections, migrations, object
storage, and authorization checks.

The generated PostgreSQL and SQLite files describe the portable relational
subset. Operational policies such as row-level security, storage lifecycle,
auditing triggers, and encryption-key rotation must be added by the owning
adapter and tested against this contract rather than hidden inside generated
code.
