#!/usr/bin/env python3
"""Fail closed when the app-vault or external step-up SQL boundary drifts."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schema" / "schema.sql"
text = SCHEMA.read_text(encoding="utf-8")

required = (
    "CREATE OR REPLACE FUNCTION cliptown.current_device_id()",
    "CREATE TABLE IF NOT EXISTS cliptown.device_verification_keys",
    "CREATE TABLE IF NOT EXISTS cliptown.app_vault_applications",
    "CREATE OR REPLACE FUNCTION cliptown.app_vault_application_allows(",
    "CREATE TABLE IF NOT EXISTS cliptown.app_vault_mutations",
    "CREATE TABLE IF NOT EXISTS cliptown.app_vault_record_heads",
    "CREATE TABLE IF NOT EXISTS cliptown.external_step_up_challenges",
    "CREATE TABLE IF NOT EXISTS cliptown.external_step_up_proofs",
    "CREATE OR REPLACE FUNCTION cliptown.consume_external_step_up(",
    "app_vault_record_heads_mutation_identity_fk",
    "transaction_timestamp()",
    "'app_vault_key'",
    "ALTER TABLE cliptown.app_vault_mutations ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY app_vault_mutations_active_device_select",
    "CREATE POLICY app_vault_mutations_active_device_insert",
    "CREATE POLICY app_vault_record_heads_active_device_select",
)
missing = [needle for needle in required if needle not in text]
if missing:
    raise SystemExit(f"schema/schema.sql is missing app-vault security contracts: {missing}")


def table_block(table_name: str) -> str:
    marker = f"CREATE TABLE IF NOT EXISTS cliptown.{table_name}"
    start = text.find(marker)
    if start < 0:
        raise SystemExit(f"missing table {table_name}")
    end = text.find("\n);", start)
    if end < 0:
        raise SystemExit(f"unterminated table {table_name}")
    return text[start : end + 3].lower()


mutation = table_block("app_vault_mutations")
forbidden_mutation_columns = (
    " otp_seed ",
    " otp_code ",
    " access_token ",
    " refresh_token ",
    " password ",
    " pin ",
    " provider ",
    " account_label ",
    " title ",
    " preview ",
    " pinned ",
    " blind_terms ",
    " embedding ",
)
leaked = [column.strip() for column in forbidden_mutation_columns if column in mutation]
if leaked:
    raise SystemExit(f"app_vault_mutations leaked clipboard/authentication semantics: {leaked}")

challenge = table_block("external_step_up_challenges")
for field in (
    "method",
    "normalized_route",
    "target_resource_id",
    "request_body_sha256_base64",
    "initiating_device_id",
    "consumed_at",
    "invalidated_at",
):
    if field not in challenge:
        raise SystemExit(f"external_step_up_challenges is not request-bound: missing {field}")

proof = table_block("external_step_up_proofs")
for forbidden in ("access_token", "refresh_token", "cookie", "password", "otp_code", "vault_key"):
    if forbidden in proof:
        raise SystemExit(f"external_step_up_proofs became a credential container: {forbidden}")

if "GRANT SELECT ON TABLE cliptown.app_vault_applications TO PUBLIC" in text:
    raise SystemExit("application policy rows must not be visible through a PUBLIC table grant")
if "SET search_path = pg_catalog, cliptown" not in text:
    raise SystemExit("security-definer helpers must use a fixed search path")

if "p_now TIMESTAMPTZ" in text:
    raise SystemExit("proof consumption must use transaction time, not caller-controlled time")
if "app_vault_record_heads_mutation_identity_fk" not in text:
    raise SystemExit("record heads must bind every identity and ordering field to a mutation")
policy_start = text.index("CREATE POLICY external_step_up_challenges_initiating_device_select")
policy_end = text.index(";", policy_start)
if "lifecycle_state = 'active'" not in text[policy_start:policy_end]:
    raise SystemExit("revoked devices must not read pending step-up challenges")

if "FOR UPDATE OF challenge, proof" not in text:
    raise SystemExit("step-up consumption must lock the challenge and proof together")
if "lifecycle_state = 'active'" not in text:
    raise SystemExit("device-gated policies must require an active device")

print("app-vault and external step-up schema boundaries are fail-closed")
