const SCHEMA: &str = include_str!("../schema/schema.sql");

#[test]
fn memebank_transfer_schema_is_subject_owned_ciphertext_only_and_revoked_from_public() {
    let start = SCHEMA
        .find("-- BEGIN DEN-1578 MEMEBANK TRANSFER API")
        .expect("DEN-1578 schema marker");
    let end = SCHEMA[start..]
        .find("-- END DEN-1578 MEMEBANK TRANSFER API")
        .map(|offset| start + offset)
        .expect("DEN-1578 schema end marker");
    let section = &SCHEMA[start..end];

    for required in [
        "CREATE TABLE IF NOT EXISTS cliptown.memebank_transfers",
        "CREATE TABLE IF NOT EXISTS cliptown.memebank_transfer_idempotency",
        "ALTER TABLE cliptown.memebank_transfers ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE cliptown.memebank_transfer_idempotency ENABLE ROW LEVEL SECURITY",
        "CREATE POLICY memebank_transfers_owner_policy",
        "CREATE POLICY memebank_transfer_idempotency_owner_policy",
        "subject_id = cliptown.current_user_id()",
        "UNIQUE (subject_id, idempotency_key)",
        "REVOKE ALL ON cliptown.memebank_transfers FROM PUBLIC",
        "REVOKE ALL ON cliptown.memebank_transfer_idempotency FROM PUBLIC",
        "payload_ciphertext_base64",
        "metadata_ciphertext_base64",
    ] {
        assert!(
            section.contains(required),
            "missing schema invariant: {required}"
        );
    }

    for forbidden in [
        "access_token",
        "refresh_token",
        "otp_code",
        "otp_seed",
        "private_key",
        "signed_url",
        "plaintext_caption",
        "plaintext_ocr",
        "app_installed",
        "deep_link",
        "local_path",
    ] {
        assert!(
            !section.to_ascii_lowercase().contains(forbidden),
            "credential/plaintext/app-presence field leaked into schema: {forbidden}"
        );
    }
}

#[test]
fn transfer_state_and_retention_constraints_remain_fail_closed() {
    let start = SCHEMA
        .find("-- BEGIN DEN-1578 MEMEBANK TRANSFER API")
        .expect("DEN-1578 schema marker");
    let section = &SCHEMA[start..];

    assert!(section.contains("contract_version = 1"));
    assert!(section.contains("content_length BETWEEN 0 AND 16777216"));
    assert!(section.contains("expires_at <= created_at + INTERVAL '30 days'"));
    assert!(section.contains("state IN ("));
    for state in [
        "'pending'",
        "'acknowledged'",
        "'ignored'",
        "'rejected'",
        "'expired'",
        "'cancelled'",
    ] {
        assert!(section.contains(state), "missing transfer state: {state}");
    }
}
