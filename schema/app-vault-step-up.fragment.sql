-- BEGIN DEN-44 APP VAULT AND EXTERNAL STEP-UP
--
-- Application-vault records are not clipboard records. This schema stores only
-- ciphertext/tombstones and bounded routing metadata. External step-up proofs
-- are one-time authorization artifacts, never primary sessions or bearer tokens.

CREATE OR REPLACE FUNCTION cliptown.current_device_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.device_id', true), '')::uuid
$$;

CREATE TABLE IF NOT EXISTS cliptown.device_verification_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('device_auth', 'app_vault_mutation')),
    algorithm TEXT NOT NULL CHECK (algorithm IN (
        'ed25519-v1', 'p256-v1', 'signal-identity-v1'
    )),
    key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 128),
    public_key_base64 TEXT NOT NULL CHECK (octet_length(public_key_base64) BETWEEN 16 AND 16384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (user_id, device_id, purpose, key_id),
    CONSTRAINT device_verification_keys_device_user_fk
        FOREIGN KEY (user_id, device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_verification_keys_active_idx
    ON cliptown.device_verification_keys (user_id, device_id, purpose, key_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cliptown.app_vault_applications (
    app_id TEXT PRIMARY KEY CHECK (
        char_length(app_id) BETWEEN 1 AND 128
        AND app_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    ),
    enabled BOOLEAN NOT NULL DEFAULT false,
    allowed_namespaces JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(allowed_namespaces) = 'array'
    ),
    max_batch_size INTEGER NOT NULL CHECK (max_batch_size BETWEEN 1 AND 500),
    max_ciphertext_base64_length INTEGER NOT NULL CHECK (
        max_ciphertext_base64_length BETWEEN 1 AND 699052
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (updated_at >= created_at)
);

INSERT INTO cliptown.app_vault_applications (
    app_id,
    enabled,
    allowed_namespaces,
    max_batch_size,
    max_ciphertext_base64_length
)
VALUES (
    'app.3fa.authenticator',
    false,
    '["threefa-vault-v1"]'::jsonb,
    100,
    699052
)
ON CONFLICT (app_id) DO UPDATE SET
    allowed_namespaces = EXCLUDED.allowed_namespaces,
    max_batch_size = EXCLUDED.max_batch_size,
    max_ciphertext_base64_length = EXCLUDED.max_ciphertext_base64_length,
    updated_at = now();

CREATE TABLE IF NOT EXISTS cliptown.app_vault_mutations (
    server_sequence BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES cliptown.app_vault_applications(app_id) ON DELETE RESTRICT,
    mutation_id TEXT NOT NULL CHECK (
        char_length(mutation_id) BETWEEN 1 AND 128
        AND mutation_id ~ '^[A-Za-z0-9._:-]+$'
    ),
    namespace TEXT NOT NULL CHECK (
        char_length(namespace) BETWEEN 1 AND 128
        AND namespace ~ '^[A-Za-z0-9._:-]+$'
    ),
    opaque_record_id TEXT NOT NULL CHECK (
        char_length(opaque_record_id) BETWEEN 16 AND 128
        AND opaque_record_id ~ '^[A-Za-z0-9_-]+$'
    ),
    payload_algorithm TEXT CHECK (
        payload_algorithm IS NULL OR payload_algorithm IN (
            'xchacha20poly1305-v1', 'aes-256-gcm-v1'
        )
    ),
    payload_nonce_base64 TEXT CHECK (
        payload_nonce_base64 IS NULL OR octet_length(payload_nonce_base64) BETWEEN 16 AND 64
    ),
    payload_ciphertext_base64 TEXT CHECK (
        payload_ciphertext_base64 IS NULL
        OR octet_length(payload_ciphertext_base64) BETWEEN 1 AND 699052
    ),
    payload_associated_data_hash_base64 TEXT CHECK (
        payload_associated_data_hash_base64 IS NULL
        OR octet_length(payload_associated_data_hash_base64) BETWEEN 43 AND 44
    ),
    payload_key_id TEXT CHECK (
        payload_key_id IS NULL OR char_length(payload_key_id) BETWEEN 1 AND 128
    ),
    deleted BOOLEAN NOT NULL,
    source_device_id UUID NOT NULL,
    logical_clock BIGINT NOT NULL CHECK (logical_clock >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
    device_signature_base64 TEXT NOT NULL CHECK (
        octet_length(device_signature_base64) BETWEEN 43 AND 684
    ),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, app_id, mutation_id),
    UNIQUE (user_id, app_id, mutation_id, server_sequence),
    CONSTRAINT app_vault_mutations_source_device_user_fk
        FOREIGN KEY (user_id, source_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE RESTRICT,
    CONSTRAINT app_vault_mutations_live_or_tombstone CHECK (
        (
            deleted
            AND payload_algorithm IS NULL
            AND payload_nonce_base64 IS NULL
            AND payload_ciphertext_base64 IS NULL
            AND payload_associated_data_hash_base64 IS NULL
            AND payload_key_id IS NULL
        )
        OR (
            NOT deleted
            AND payload_algorithm IS NOT NULL
            AND payload_nonce_base64 IS NOT NULL
            AND payload_ciphertext_base64 IS NOT NULL
            AND payload_associated_data_hash_base64 IS NOT NULL
            AND payload_key_id IS NOT NULL
        )
    ),
    CONSTRAINT app_vault_mutations_future_skew CHECK (
        created_at <= received_at + INTERVAL '5 minutes'
        AND updated_at <= received_at + INTERVAL '5 minutes'
    )
);
CREATE INDEX IF NOT EXISTS app_vault_mutations_cursor_idx
    ON cliptown.app_vault_mutations (user_id, app_id, server_sequence);
CREATE INDEX IF NOT EXISTS app_vault_mutations_record_clock_idx
    ON cliptown.app_vault_mutations (
        user_id, app_id, namespace, opaque_record_id, logical_clock, source_device_id
    );

CREATE TABLE IF NOT EXISTS cliptown.app_vault_record_heads (
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES cliptown.app_vault_applications(app_id) ON DELETE RESTRICT,
    namespace TEXT NOT NULL,
    opaque_record_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    server_sequence BIGINT NOT NULL,
    logical_clock BIGINT NOT NULL CHECK (logical_clock >= 0),
    source_device_id UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, app_id, namespace, opaque_record_id),
    CONSTRAINT app_vault_record_heads_mutation_fk
        FOREIGN KEY (user_id, app_id, mutation_id, server_sequence)
        REFERENCES cliptown.app_vault_mutations (
            user_id, app_id, mutation_id, server_sequence
        ) ON DELETE CASCADE,
    CONSTRAINT app_vault_record_heads_source_device_user_fk
        FOREIGN KEY (user_id, source_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cliptown.external_step_up_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    initiating_device_id UUID NOT NULL,
    audience TEXT NOT NULL CHECK (audience = 'cliptown'),
    action TEXT NOT NULL CHECK (action IN (
        'enroll_device', 'revoke_device', 'update_security_settings',
        'change_recovery_channel', 'export_app_vault', 'recover_account'
    )),
    method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
    normalized_route TEXT NOT NULL CHECK (
        char_length(normalized_route) BETWEEN 1 AND 256
        AND normalized_route LIKE '/%'
        AND normalized_route NOT LIKE '%?%'
        AND normalized_route NOT LIKE '%#%'
        AND normalized_route NOT LIKE '%//%'
        AND normalized_route NOT LIKE '%/../%'
        AND normalized_route NOT LIKE '%/./%'
    ),
    target_resource_id TEXT CHECK (
        target_resource_id IS NULL OR char_length(target_resource_id) BETWEEN 1 AND 128
    ),
    request_body_sha256_base64 TEXT NOT NULL CHECK (
        octet_length(request_body_sha256_base64) BETWEEN 43 AND 44
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL CHECK (
        expires_at > created_at
        AND expires_at <= created_at + INTERVAL '5 minutes'
    ),
    consumed_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    consumed_proof_id TEXT,
    UNIQUE (user_id, id),
    CONSTRAINT external_step_up_challenges_device_user_fk
        FOREIGN KEY (user_id, initiating_device_id)
        REFERENCES cliptown.devices(user_id, id) ON DELETE CASCADE,
    CONSTRAINT external_step_up_challenges_terminal_state CHECK (
        consumed_at IS NULL OR invalidated_at IS NULL
    ),
    CONSTRAINT external_step_up_challenges_consumption_consistent CHECK (
        (consumed_at IS NULL AND consumed_proof_id IS NULL)
        OR (consumed_at IS NOT NULL AND consumed_proof_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS external_step_up_challenges_active_idx
    ON cliptown.external_step_up_challenges (
        user_id, initiating_device_id, expires_at
    )
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS cliptown.external_step_up_proofs (
    proof_id TEXT PRIMARY KEY CHECK (
        char_length(proof_id) BETWEEN 1 AND 128
        AND proof_id ~ '^[A-Za-z0-9._:-]+$'
    ),
    user_id UUID NOT NULL REFERENCES cliptown.accounts(user_id) ON DELETE CASCADE,
    challenge_id UUID NOT NULL,
    issuer TEXT NOT NULL CHECK (issuer = 'https://3fa.app'),
    subject TEXT NOT NULL CHECK (subject = user_id::text),
    audience TEXT NOT NULL CHECK (audience = 'cliptown'),
    approving_external_device_id TEXT NOT NULL CHECK (
        char_length(approving_external_device_id) BETWEEN 1 AND 128
        AND approving_external_device_id ~ '^[A-Za-z0-9._:-]+$'
    ),
    action TEXT NOT NULL CHECK (action IN (
        'enroll_device', 'revoke_device', 'update_security_settings',
        'change_recovery_channel', 'export_app_vault', 'recover_account'
    )),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (
        expires_at > issued_at
        AND expires_at <= issued_at + INTERVAL '5 minutes'
    ),
    signing_key_id TEXT NOT NULL CHECK (char_length(signing_key_id) BETWEEN 1 AND 128),
    signature_base64 TEXT NOT NULL CHECK (octet_length(signature_base64) BETWEEN 43 AND 684),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    UNIQUE (challenge_id),
    CONSTRAINT external_step_up_proofs_challenge_user_fk
        FOREIGN KEY (user_id, challenge_id)
        REFERENCES cliptown.external_step_up_challenges(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS external_step_up_proofs_active_idx
    ON cliptown.external_step_up_proofs (user_id, challenge_id, expires_at)
    WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION cliptown.consume_external_step_up(
    p_user_id UUID,
    p_initiating_device_id UUID,
    p_challenge_id UUID,
    p_proof_id TEXT,
    p_action TEXT,
    p_method TEXT,
    p_normalized_route TEXT,
    p_target_resource_id TEXT,
    p_request_body_sha256_base64 TEXT,
    p_now TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, cliptown
AS $$
BEGIN
    IF p_now IS NULL
        OR p_user_id IS DISTINCT FROM cliptown.current_user_id()
        OR p_initiating_device_id IS DISTINCT FROM cliptown.current_device_id()
    THEN
        RETURN false;
    END IF;

    PERFORM 1
    FROM cliptown.external_step_up_challenges AS challenge
    JOIN cliptown.external_step_up_proofs AS proof
        ON proof.user_id = challenge.user_id
        AND proof.challenge_id = challenge.id
    JOIN cliptown.devices AS device
        ON device.user_id = challenge.user_id
        AND device.id = challenge.initiating_device_id
    WHERE challenge.user_id = p_user_id
      AND challenge.initiating_device_id = p_initiating_device_id
      AND challenge.id = p_challenge_id
      AND challenge.action = p_action
      AND challenge.method = p_method
      AND challenge.normalized_route = p_normalized_route
      AND challenge.target_resource_id IS NOT DISTINCT FROM p_target_resource_id
      AND challenge.request_body_sha256_base64 = p_request_body_sha256_base64
      AND challenge.audience = 'cliptown'
      AND challenge.consumed_at IS NULL
      AND challenge.invalidated_at IS NULL
      AND challenge.created_at <= p_now + INTERVAL '5 minutes'
      AND challenge.expires_at > p_now
      AND device.lifecycle_state = 'active'
      AND proof.proof_id = p_proof_id
      AND proof.issuer = 'https://3fa.app'
      AND proof.subject = p_user_id::text
      AND proof.audience = challenge.audience
      AND proof.action = challenge.action
      AND proof.issued_at >= challenge.created_at - INTERVAL '5 minutes'
      AND proof.issued_at <= p_now + INTERVAL '5 minutes'
      AND proof.expires_at <= challenge.expires_at
      AND proof.expires_at > p_now
      AND proof.verified_at <= p_now
      AND proof.consumed_at IS NULL
    FOR UPDATE OF challenge, proof;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE cliptown.external_step_up_challenges
    SET consumed_at = p_now,
        consumed_proof_id = p_proof_id
    WHERE id = p_challenge_id
      AND user_id = p_user_id
      AND consumed_at IS NULL
      AND invalidated_at IS NULL;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE cliptown.external_step_up_proofs
    SET consumed_at = p_now
    WHERE proof_id = p_proof_id
      AND user_id = p_user_id
      AND challenge_id = p_challenge_id
      AND consumed_at IS NULL;

    RETURN FOUND;
END;
$$;

ALTER TABLE cliptown.device_verification_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.app_vault_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.app_vault_record_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.external_step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.external_step_up_proofs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_verification_keys_active_device_select
    ON cliptown.device_verification_keys;
CREATE POLICY device_verification_keys_active_device_select
    ON cliptown.device_verification_keys
    FOR SELECT
    USING (
        user_id = cliptown.current_user_id()
        AND EXISTS (
            SELECT 1
            FROM cliptown.devices AS current_device
            WHERE current_device.user_id = cliptown.current_user_id()
              AND current_device.id = cliptown.current_device_id()
              AND current_device.lifecycle_state = 'active'
        )
    );

DROP POLICY IF EXISTS app_vault_mutations_active_device_select
    ON cliptown.app_vault_mutations;
CREATE POLICY app_vault_mutations_active_device_select
    ON cliptown.app_vault_mutations
    FOR SELECT
    USING (
        user_id = cliptown.current_user_id()
        AND EXISTS (
            SELECT 1
            FROM cliptown.devices AS current_device
            WHERE current_device.user_id = cliptown.current_user_id()
              AND current_device.id = cliptown.current_device_id()
              AND current_device.lifecycle_state = 'active'
        )
    );

DROP POLICY IF EXISTS app_vault_mutations_active_device_insert
    ON cliptown.app_vault_mutations;
CREATE POLICY app_vault_mutations_active_device_insert
    ON cliptown.app_vault_mutations
    FOR INSERT
    WITH CHECK (
        user_id = cliptown.current_user_id()
        AND source_device_id = cliptown.current_device_id()
        AND EXISTS (
            SELECT 1
            FROM cliptown.devices AS current_device
            JOIN cliptown.app_vault_applications AS application
              ON application.app_id = app_id
            WHERE current_device.user_id = cliptown.current_user_id()
              AND current_device.id = cliptown.current_device_id()
              AND current_device.lifecycle_state = 'active'
              AND application.enabled
        )
    );

DROP POLICY IF EXISTS app_vault_record_heads_active_device_select
    ON cliptown.app_vault_record_heads;
CREATE POLICY app_vault_record_heads_active_device_select
    ON cliptown.app_vault_record_heads
    FOR SELECT
    USING (
        user_id = cliptown.current_user_id()
        AND EXISTS (
            SELECT 1
            FROM cliptown.devices AS current_device
            WHERE current_device.user_id = cliptown.current_user_id()
              AND current_device.id = cliptown.current_device_id()
              AND current_device.lifecycle_state = 'active'
        )
    );

DROP POLICY IF EXISTS external_step_up_challenges_initiating_device_select
    ON cliptown.external_step_up_challenges;
CREATE POLICY external_step_up_challenges_initiating_device_select
    ON cliptown.external_step_up_challenges
    FOR SELECT
    USING (
        user_id = cliptown.current_user_id()
        AND initiating_device_id = cliptown.current_device_id()
    );

REVOKE ALL ON TABLE cliptown.device_verification_keys FROM PUBLIC;
REVOKE ALL ON TABLE cliptown.app_vault_applications FROM PUBLIC;
REVOKE ALL ON TABLE cliptown.app_vault_mutations FROM PUBLIC;
REVOKE ALL ON TABLE cliptown.app_vault_record_heads FROM PUBLIC;
REVOKE ALL ON TABLE cliptown.external_step_up_challenges FROM PUBLIC;
REVOKE ALL ON TABLE cliptown.external_step_up_proofs FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA cliptown FROM PUBLIC;
REVOKE ALL ON FUNCTION cliptown.consume_external_step_up(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;

-- END DEN-44 APP VAULT AND EXTERNAL STEP-UP
