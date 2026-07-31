use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "external_step_up_proofs", schema_name = "cliptown")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub proof_id: String,
    pub user_id: Uuid,
    pub challenge_id: Uuid,
    pub issuer: String,
    pub subject: String,
    pub audience: String,
    pub approving_external_device_id: String,
    pub action: String,
    pub issued_at: DateTimeWithTimeZone,
    pub expires_at: DateTimeWithTimeZone,
    pub signing_key_id: String,
    pub signature_base64: String,
    pub verified_at: DateTimeWithTimeZone,
    pub consumed_at: Option<DateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
