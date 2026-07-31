use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "app_vault_mutations", schema_name = "cliptown")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub server_sequence: i64,
    pub user_id: Uuid,
    pub app_id: String,
    pub mutation_id: String,
    pub namespace: String,
    pub opaque_record_id: String,
    pub payload_algorithm: Option<String>,
    pub payload_nonce_base64: Option<String>,
    pub payload_ciphertext_base64: Option<String>,
    pub payload_associated_data_hash_base64: Option<String>,
    pub payload_key_id: Option<String>,
    pub deleted: bool,
    pub source_device_id: Uuid,
    pub logical_clock: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub device_signature_base64: String,
    pub received_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
