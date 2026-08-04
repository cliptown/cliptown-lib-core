use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "memebank_transfer_idempotency", schema_name = "cliptown")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub subject_id: Uuid,
    pub idempotency_key: String,
    pub operation: String,
    pub normalized_route: String,
    pub request_digest_base64url: String,
    pub transfer_id: Option<Uuid>,
    pub response_state: Option<String>,
    pub created_at: DateTimeWithTimeZone,
    pub expires_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
