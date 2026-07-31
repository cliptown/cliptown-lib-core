# ClipTown application vault and 3FA step-up backend

Tracking: DEN-42, DEN-44, and DEN-45.

## Scope of this slice

This backend slice consumes the versioned contracts merged in
`cliptown/cliptown-interfaces` and establishes fail-closed application and
persistence boundaries. It intentionally does **not** enable authenticated
routes before Supabase JWKS validation, per-device credential verification,
cryptographic provider wiring, and database integration tests exist.

The two reciprocal interfaces remain independent:

1. 3FA may use ClipTown as an opaque application-vault transport.
2. ClipTown may require a one-time 3FA proof for one sensitive request.

Neither interface is a primary login source, refresh-token exchange, shared
cookie jar, or shared private-key store.

## Application-vault push pipeline

The HTTP path app id, authenticated active ClipTown device, request mutations,
and configured application policy are validated before any transaction begins.
The policy layer requires:

- an active, independently authenticated ClipTown device;
- a stable primary-auth subject and exact source device id;
- path, mutation, and configured app ids to match;
- an allowlisted non-semantic namespace;
- a bounded non-empty batch and no duplicate mutation ids;
- no repeated record/source/logical-clock tuple in one batch;
- timestamps within bounded future clock skew;
- ciphertext-or-tombstone exclusivity from the shared interface contract;
- a successful registered-device signature-verifier callback for every mutation.

Signature verification is an explicit trait boundary. A route cannot use the
validation function without supplying a verifier. The backend must resolve an
active `device_verification_keys` row and verify canonical mutation bytes with a
reviewed provider before persistence. Structural validation alone is never
accepted as a signature.

## Storage and conflict handling

`app_vault_mutations` is an append-only ciphertext log. It contains no clipboard
kind, source application, title, preview, pin, blind term, embedding, provider,
account label, OTP seed/code, access token, refresh token, PIN, or plaintext
metadata column.

`app_vault_record_heads` is separate from the history log. A push transaction
must:

1. verify the authenticated subject/device and application policy;
2. verify every device signature;
3. lock the affected head rows in a stable key order;
4. insert idempotent mutation rows;
5. compare candidate and existing order by
   `(logical_clock, source_device_id, mutation_id)`;
6. update only winning heads;
7. commit the complete batch or none of it.

Keeping the log and heads separate preserves concurrent history while providing
a single deterministic row to lock. A stale mutation remains auditable but does
not replace a newer head. Mutation ids are idempotency keys and server sequence
is the pull cursor.

`app.3fa.authenticator` is inserted into the application table with
`enabled = false`. Production enablement is a separately reviewed operation
after authentication, signature, RLS, quota, retention, and adversarial tests
pass.

## Device-bound RLS

The database derives the user and device boundaries from transaction-local JWT
claims exposed as `request.jwt.claim.sub` and `request.jwt.claim.device_id`.
Application-vault reads require an active device belonging to the authenticated
user. Direct inserts additionally require `source_device_id` to equal the
current device. Users cannot directly write record-head rows, challenge rows, or
verified-proof rows.

The API must verify the Supabase/shared-auth session and independently verify the
ClipTown device credential before setting these local claims. Caller-supplied
body fields never establish identity. Revoked or suspended devices must not get
a transaction with an active device claim.

## Request-bound 3FA step-up

A challenge binds all security-relevant request context:

- primary-auth subject;
- initiating ClipTown device;
- audience;
- one canonical action;
- HTTP method;
- normalized route;
- optional target resource id;
- SHA-256 hash of the canonical request body;
- creation and expiration timestamps;
- one-time challenge id.

The Rust policy checks that the live request exactly matches this context. It
then verifies the shared proof structure and requires exact issuer, audience,
subject, challenge, and action matches. Proof issue/expiry must fit inside the
challenge window. A reviewed 3FA issuer/device-key verifier is mandatory.

`external_step_up_proofs` stores only proofs that already passed cryptographic
verification. It is not a bearer-token table. The schema cannot store access or
refresh tokens, cookies, passwords, OTP values, or vault keys.

## Atomic consumption

`cliptown.consume_external_step_up` locks the challenge and verified proof
together and rechecks:

- transaction-local user and initiating device claims;
- active device lifecycle;
- exact method, route, target, body hash, action, and audience;
- issuer and subject;
- challenge/proof expiry and terminal state;
- proof verification and one-time consumption state.

The application must call the function and perform the protected mutation in the
**same database transaction**. A true result only reserves the proof within that
transaction; committing consumption without the protected action, or performing
the protected action in a later transaction, is incorrect.

The function is `SECURITY DEFINER` with a fixed search path and has no public
execute grant. Deployment must grant it only to the backend database role. End
users and anonymous Supabase roles must not call it directly.

## Final integrity invariants

The Signal mailbox accepts the versioned `app_vault_key` purpose from the merged
interface contract. A record-head foreign key includes namespace, opaque record
id, mutation id, server sequence, logical clock, source device, and update time;
a privileged repository bug therefore cannot point a head at a different
mutation while copying only its sequence.

Proof consumption derives time from PostgreSQL `transaction_timestamp()` rather
than a caller parameter. After locking the challenge and proof, either both
terminal markers are written or an invariant exception aborts the statement.
Revoked or suspended initiating devices cannot read pending challenges through
RLS.

## Required production work

Before routes are enabled:

- validate Supabase access tokens through pinned project issuer/audience and
  rotating JWKS;
- issue one random, independently revocable ClipTown device credential per
  installation and store only a suitable server-side digest;
- set transaction-local user/device claims only after both checks pass;
- implement registered device signature verification and 3FA issuer-key
  discovery/rotation;
- implement transactional app-vault repository operations and deterministic head
  selection;
- add quotas, retention, tombstone compaction, and audit event classes without
  sensitive identifiers or payloads;
- run the declarative schema through DPM diff/verify/review and a disposable
  PostgreSQL RLS test matrix;
- prove cross-user and revoked-device isolation;
- test duplicate, replayed, stale, out-of-order, future-dated, and conflicting
  mutations;
- test proof replay, modified body/route/target/action, expired challenges,
  issuer rotation, revoked approving devices, and transaction rollback;
- keep all app-vault and proof values out of logs, traces, metrics, crash reports,
  URLs, and analytics.
