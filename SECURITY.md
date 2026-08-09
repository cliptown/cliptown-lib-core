# Security policy

Report security issues privately to the ClipTown maintainers. Do not include
credentials, plaintext clipboard contents, unredacted tokens, encryption keys,
or production object identifiers in a public issue.

This crate deliberately contains no transport clients, database adapters,
server routes, operating-system clipboard access, or plaintext merge logic.
Callers remain responsible for key custody, cryptographic implementation,
revocation feeds, storage isolation, and authenticated transport.
