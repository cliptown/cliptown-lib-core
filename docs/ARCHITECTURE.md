# Architecture boundary

## Dependency direction

```text
cliptown-interfaces  -> generated wire contracts
cliptown-lib-core    -> transport-neutral domain and policy
cliptown-clients     -> HTTP/WebSocket/SDK transport adapters
backend/apps         -> persistence, routes, key custody, OS integration
```

`cliptown-lib-core` declares the interface package in `.zpkg.toml` to retain
portfolio topology, but the Rust crate does not path-couple itself to a checked
out generated tree. This keeps crates.io-style builds reproducible while
allowing adapters to map generated contracts into the core types.

## Security boundary

The library assumes token signatures, issuer discovery, revocation feeds, and
cryptographic operations have already been performed by trusted adapters. It
then validates the facts that must remain identical across servers and clients:

1. control-plane credentials cannot be object-grant credentials;
2. audience, client, scope, expiry, revocation, and subject ownership are
   checked before an operation is admitted;
3. writes and deletes require recent assurance level 2 or greater;
4. ciphertext and manifest metadata are bounded before persistence or network
   fan-out;
5. sync ordering is deterministic and uses opaque metadata only.

## Semantic consolidation

The old conceptual roles `cliptown-lib`, `cliptown-core`, and `cliptown-sync`
were overlapping. The consolidated repository owns their common policy surface
without copying server transport or persistence code. Existing repositories
remain authoritative for generated interfaces, clients, and backend adapters.
