-- ClipTown reviewed PostgreSQL desired state.
--
-- Never run this automatically at API startup. Apply only through the reviewed
-- declarative migration workflow. PostgreSQL/Supabase and Cloudflare R2 store
-- ciphertext and bounded routing metadata, never clipboard plaintext, content
-- keys, PINs, biometric templates, Signal private keys, or OTP codes.

CREATE SCHEMA IF NOT EXISTS cliptown;

CREATE OR REPLACE FUNCTION cliptown.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE IF NOT EXISTS cliptown.accounts (
    user_id UUID PRIMARY KEY,
    device_list_revision BIGINT NOT NULL DEFAULT 0 CHECK (device_list_revision >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cliptown.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    platform TEXT NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 64),
    lifecycle_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        lifecycle_state IN ('pending', 'active', 'suspended', 'revoked')
    ),
    sync_token_hash TEXT NOT NULL,
    identity_key_fingerprint_base64 TEXT,
    local_unlock_policy JSONB NOT NULL DEFAULT '{"pin_enabled":false,"biometric_enabled":false,"passkey_enabled":false}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    UNIQUE (user_id, id),
    CONSTRAINT devices_revocation_consistent CHECK (
        (lifecycle_state = 'revoked' AND revoked_at IS NOT NULL)
        OR (lifecycle_state <> 'revoked' AND revoked_at IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS devices_user_state_idx
    ON cliptown.devices (user_id, lifecycle_state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS devices_sync_token_hash_idx
    ON cliptown.devices (sync_token_hash);

CREATE TABLE IF NOT EXISTS cliptown.signal_prekey_bundles (
    device_id UUID PRIMARY KEY REFERENCES cliptown.devices(id) ON DELETE CASCADE,
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),
    registration_id BIGINT NOT NULL CHECK (registration_id > 0),
    identity_key_base64 TEXT NOT NULL,
    signed_prekey_id BIGINT NOT NULL CHECK (signed_prekey_id >= 0),
    signed_prekey_base64 TEXT NOT NULL,
    signed_prekey_signature_base64 TEXT NOT NULL,
    pq_signed_prekey_id BIGINT NOT NULL CHECK (pq_signed_prekey_id >= 0),
    pq_signed_prekey_base64 TEXT NOT NULL,
    pq_signed_prekey_signature_base64 TEXT NOT NULL,
    bundle_revision BIGINT NOT NULL CHECK (bundle_revision > 0),
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > published_at)
);

CREATE TABLE IF NOT EXISTS cliptown.signal_one_time_prekeys (
    device_id UUID NOT NULL REFERENCES cliptown.devices(id) ON DELETE CASCADE,
    prekey_id BIGINT NOT NULL CHECK (prekey_id >= 0),
    public_key_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ,
    claimed_by_device_id UUID REFERENCES cliptown.devices(id) ON DELETE SET NULL,
    PRIMARY KEY (device_id, prekey_id),
    CONSTRAINT signal_one_time_prekey_claim_consistent CHECK (
        (claimed_at IS NULL AND claimed_by_device_id IS NULL)
        OR (claimed_at IS NOT NULL AND claimed_by_device_id IS NOT NULL)
    ),
    CONSTRAINT signal_one_time_prekey_not_self_claimed CHECK (
        claimed_by_device_id IS NULL OR claimed_by_device_id <> device_id
    )
);
CREATE INDEX IF NOT EXISTS signal_one_time_prekeys_available_idx
    ON cliptown.signal_one_time_prekeys (device_id, prekey_id)
    WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS cliptown.device_mailbox (
    server_sequence BIGSERIAL UNIQUE,
    envelope_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    sender_device_id UUID NOT NULL,
    recipient_device_id UUID NOT NULL,
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),
    session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 128),
    message_number NUMERIC(20, 0) NOT NULL CHECK (message_number >= 0),
    purpose TEXT NOT NULL CHECK (purpose IN (
        'account_key_transfer', 'clip_key', 'object_key', 'device_control',
        'recovery_package', 'acknowledgement'
    )),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'
    ),
    ciphertext_base64 TEXT NOT NULL CHECK (octet_length(ciphertext_base64) BETWEEN 1 AND 699052),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    CONSTRAINT mailbox_sender_not_recipient CHECK (sender_device_id <> recipient_device_id),
    CONSTRAINT mailbox_sender_user_fk FOREIGN KEY (user_id, sender_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE CASCADE,
    CONSTRAINT mailbox_recipient_user_fk FOREIGN KEY (user_id, recipient_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_mailbox_recipient_cursor_idx
    ON cliptown.device_mailbox (recipient_device_id, server_sequence)
    WHERE acknowledged_at IS NULL;

CREATE TABLE IF NOT EXISTS cliptown.recovery_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
    destination_ciphertext TEXT NOT NULL,
    destination_key_id TEXT NOT NULL,
    destination_blind_digest TEXT NOT NULL,
    masked_destination TEXT NOT NULL CHECK (char_length(masked_destination) BETWEEN 3 AND 320),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    UNIQUE (user_id, kind, destination_blind_digest)
);

CREATE TABLE IF NOT EXISTS cliptown.recovery_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES cliptown.recovery_channels(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN (
        'add_device', 'account_recovery', 'step_up', 'change_channel', 'revoke_device'
    )),
    code_digest TEXT NOT NULL,
    digest_key_id TEXT NOT NULL,
    attempts_remaining SMALLINT NOT NULL DEFAULT 5 CHECK (attempts_remaining BETWEEN 0 AND 10),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL CHECK (
        expires_at > requested_at AND expires_at <= requested_at + INTERVAL '15 minutes'
    ),
    consumed_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    requester_risk_hash TEXT,
    CONSTRAINT recovery_challenge_terminal_state CHECK (
        consumed_at IS NULL OR invalidated_at IS NULL
    )
);
CREATE INDEX IF NOT EXISTS recovery_challenges_active_idx
    ON cliptown.recovery_challenges (user_id, channel_id, expires_at)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS cliptown.encrypted_recovery_packages (
    user_id UUID PRIMARY KEY REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    package_version SMALLINT NOT NULL CHECK (package_version = 1),
    recovery_key_id TEXT NOT NULL,
    ciphertext_base64 TEXT NOT NULL,
    nonce_base64 TEXT NOT NULL,
    associated_data_hash_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cliptown.clips (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    encrypted_content TEXT NOT NULL,
    nonce TEXT NOT NULL,
    associated_data_hash TEXT,
    key_id TEXT NOT NULL,
    pinned BOOLEAN NOT NULL DEFAULT false,
    deleted BOOLEAN NOT NULL DEFAULT false,
    blind_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
    encrypted_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_device_id UUID NOT NULL,
    logical_clock BIGINT NOT NULL CHECK (logical_clock >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, id),
    CONSTRAINT clips_source_device_user_fk FOREIGN KEY (user_id, source_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS clips_user_clock_idx
    ON cliptown.clips (user_id, logical_clock, id);

CREATE TABLE IF NOT EXISTS cliptown.encrypted_objects (
    id UUID PRIMARY KEY,
    manifest_id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    clip_id UUID NOT NULL,
    content_cipher_version TEXT NOT NULL CHECK (content_cipher_version IN (
        'xchacha20poly1305-chunked-v1', 'aes-256-gcm-chunked-v1'
    )),
    plaintext_length BIGINT NOT NULL CHECK (plaintext_length >= 0),
    ciphertext_length BIGINT NOT NULL CHECK (ciphertext_length > 0),
    chunk_size INTEGER NOT NULL CHECK (chunk_size BETWEEN 65536 AND 16777216),
    ciphertext_sha256_base64 TEXT NOT NULL,
    encrypted_metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT encrypted_objects_clip_user_fk FOREIGN KEY (user_id, clip_id)
        REFERENCES cliptown.clips(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cliptown.encrypted_object_chunks (
    object_id UUID NOT NULL REFERENCES cliptown.encrypted_objects(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    ciphertext_length BIGINT NOT NULL CHECK (ciphertext_length > 0),
    ciphertext_sha256_base64 TEXT NOT NULL,
    nonce_base64 TEXT NOT NULL,
    randomized_storage_key TEXT NOT NULL UNIQUE CHECK (
        char_length(randomized_storage_key) BETWEEN 16 AND 512
        AND randomized_storage_key NOT LIKE '/%'
        AND randomized_storage_key NOT LIKE '%..%'
    ),
    uploaded_at TIMESTAMPTZ,
    PRIMARY KEY (object_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS cliptown.object_wrapped_keys (
    object_id UUID NOT NULL REFERENCES cliptown.encrypted_objects(id) ON DELETE CASCADE,
    recipient_device_id UUID NOT NULL REFERENCES cliptown.devices(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL,
    algorithm TEXT NOT NULL CHECK (algorithm IN (
        'signal-envelope-v1', 'xchacha20poly1305-wrap-v1', 'aes-256-gcm-wrap-v1'
    )),
    nonce_base64 TEXT NOT NULL,
    wrapped_key_base64 TEXT NOT NULL,
    associated_data_hash_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (object_id, recipient_device_id)
);

CREATE TABLE IF NOT EXISTS cliptown.object_upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID NOT NULL REFERENCES cliptown.encrypted_objects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count BETWEEN 1 AND 100000),
    expected_ciphertext_length BIGINT NOT NULL CHECK (expected_ciphertext_length > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '1 hour'
    ),
    completed_at TIMESTAMPTZ,
    UNIQUE (user_id, idempotency_key)
);

ALTER TABLE cliptown.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.recovery_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.recovery_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.encrypted_recovery_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.encrypted_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.object_upload_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_owner_policy ON cliptown.accounts;
CREATE POLICY accounts_owner_policy ON cliptown.accounts
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS devices_owner_policy ON cliptown.devices;
CREATE POLICY devices_owner_policy ON cliptown.devices
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS recovery_channels_owner_policy ON cliptown.recovery_channels;
CREATE POLICY recovery_channels_owner_policy ON cliptown.recovery_channels
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS recovery_challenges_owner_policy ON cliptown.recovery_challenges;
CREATE POLICY recovery_challenges_owner_policy ON cliptown.recovery_challenges
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS encrypted_recovery_packages_owner_policy ON cliptown.encrypted_recovery_packages;
CREATE POLICY encrypted_recovery_packages_owner_policy ON cliptown.encrypted_recovery_packages
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS clips_owner_policy ON cliptown.clips;
CREATE POLICY clips_owner_policy ON cliptown.clips
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS encrypted_objects_owner_policy ON cliptown.encrypted_objects;
CREATE POLICY encrypted_objects_owner_policy ON cliptown.encrypted_objects
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

DROP POLICY IF EXISTS object_upload_sessions_owner_policy ON cliptown.object_upload_sessions;
CREATE POLICY object_upload_sessions_owner_policy ON cliptown.object_upload_sessions
    USING (user_id = cliptown.current_user_id())
    WITH CHECK (user_id = cliptown.current_user_id());

REVOKE ALL ON ALL TABLES IN SCHEMA cliptown FROM PUBLIC;
