//! The service's inputs (the parsed request bodies, `schemas/legal-entities.ts`)
//! and outputs (its response types and the Drizzle rows it returns).
//!
//! Inputs keep Zod's three states where the service tells them apart
//! (`!== undefined`, `?? null`): [`Field::Absent`] is a key left out,
//! [`Field::Null`] an explicit null. Build them with [`crate::schemas`] from
//! a body, or by hand (`..Default::default()`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_kit::validation::Field;

use crate::access::EntityAccessSource;
use crate::extensions::LegalEntityApp;
use crate::schemas::RegistrationType;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/// `CreateLegalEntityInput`. `address`, `contact`, `branding` and
/// `fiscal_year_config` are the objects as Zod parsed them (unknown keys
/// dropped, strings trimmed).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreateLegalEntityInput {
    pub name: String,
    pub legal_name: Field<String>,
    pub dba: Field<String>,
    pub entity_type: Field<String>,
    /// Upper-cased by the schema.
    pub jurisdiction_code: String,
    pub base_currency: String,
    pub locale: Option<String>,
    pub timezone: Option<String>,
    pub address: Field<Value>,
    pub contact: Field<Value>,
    pub branding: Field<Value>,
    pub fiscal_year_start: Option<i32>,
    pub fiscal_year_config: Field<Value>,
    pub tax_classification: Field<String>,
    /// Make it the workspace default. The first entity always becomes the default.
    pub is_default: Option<bool>,
}

/// `UpdateLegalEntityInput`: everything optional; the default and archive
/// state have their own routes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateLegalEntityInput {
    pub name: Option<String>,
    pub legal_name: Field<String>,
    pub dba: Field<String>,
    pub entity_type: Field<String>,
    pub jurisdiction_code: Option<String>,
    pub base_currency: Option<String>,
    pub locale: Option<String>,
    pub timezone: Option<String>,
    pub address: Field<Value>,
    pub contact: Field<Value>,
    pub branding: Field<Value>,
    pub fiscal_year_start: Option<i32>,
    pub fiscal_year_config: Field<Value>,
    pub tax_classification: Field<String>,
}

impl CreateLegalEntityInput {
    /// The create input read as an update (`coreColumns(input)` takes either).
    pub fn as_update(&self) -> UpdateLegalEntityInput {
        UpdateLegalEntityInput {
            name: Some(self.name.clone()),
            legal_name: self.legal_name.clone(),
            dba: self.dba.clone(),
            entity_type: self.entity_type.clone(),
            jurisdiction_code: Some(self.jurisdiction_code.clone()),
            base_currency: Some(self.base_currency.clone()),
            locale: self.locale.clone(),
            timezone: self.timezone.clone(),
            address: self.address.clone(),
            contact: self.contact.clone(),
            branding: self.branding.clone(),
            fiscal_year_start: self.fiscal_year_start,
            fiscal_year_config: self.fiscal_year_config.clone(),
            tax_classification: self.tax_classification.clone(),
        }
    }
}

/// `ListLegalEntitiesOptions` (the access snapshot is passed separately).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ListLegalEntitiesOptions {
    /// Only entities this app is enabled for.
    pub app: Option<LegalEntityApp>,
    pub include_archived: bool,
}

/// A row of `entities` (`typeof schema.legalEntities.$inferSelect`): the
/// fields the service and routes read, and the whole row as Drizzle returns
/// it in [`EntityRow::row`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub legal_name: Option<String>,
    #[serde(default)]
    pub dba: Option<String>,
    #[serde(default)]
    pub entity_type: Option<String>,
    pub jurisdiction_code: String,
    pub base_currency: String,
    pub locale: String,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub address: Value,
    #[serde(default)]
    pub contact: Value,
    #[serde(default)]
    pub branding: Value,
    #[serde(default)]
    pub tax_identifiers: Value,
    #[serde(default)]
    pub fiscal_year_start: Option<i64>,
    #[serde(default)]
    pub fiscal_year_config: Value,
    #[serde(default)]
    pub tax_classification: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub access_restricted: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    /// The whole row: camelCase keys, ISO timestamps (`asData(row)`).
    #[serde(skip)]
    pub row: Value,
}

/// Where the caller acts in an entity (`LegalEntityMyAccess`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityMyAccess {
    pub source: EntityAccessSource,
    /// The role the caller acts with inside the entity; `None` = their workspace role.
    pub role_id: Option<String>,
    pub role_name: Option<String>,
}

/// `LegalEntity`: an entity as the API returns it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntity {
    pub id: String,
    pub name: String,
    pub legal_name: Option<String>,
    pub dba: Option<String>,
    pub entity_type: Option<String>,
    pub jurisdiction_code: String,
    pub base_currency: String,
    pub locale: String,
    pub timezone: Option<String>,
    pub address: Value,
    pub contact: Value,
    /// `{ logoUrl, primaryColor, accentColor }` when any is set, else null.
    pub branding: Value,
    pub fiscal_year_start: Option<i64>,
    pub fiscal_year_config: Value,
    pub tax_classification: Option<String>,
    pub is_default: bool,
    pub is_active: bool,
    pub access_restricted: bool,
    /// Apps enabled for this entity.
    pub enabled_apps: Vec<LegalEntityApp>,
    pub created_at: String,
    pub updated_at: String,
    /// Present on reads made for the signed-in member.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_access: Option<LegalEntityMyAccess>,
}

/// `LegalEntityUsage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityUsage {
    pub app: LegalEntityApp,
    pub enabled: bool,
    /// The app holds data for this entity, so it cannot be deleted.
    pub has_data: bool,
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/// `CreateRegistrationInput`. `number` is as the body sent it (trimmed);
/// the service normalizes and checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateRegistrationInput {
    pub registration_type: RegistrationType,
    pub number: String,
    /// Upper-cased by the schema.
    pub country: Field<String>,
    /// US state or IN state code for state-level registrations.
    pub region: Field<String>,
    pub label: Field<String>,
    pub valid_from: Field<String>,
    pub valid_to: Field<String>,
    pub is_primary: Option<bool>,
}

impl CreateRegistrationInput {
    /// A registration of `registration_type` with `number` and nothing else.
    pub fn new(registration_type: RegistrationType, number: impl Into<String>) -> Self {
        Self {
            registration_type,
            number: number.into(),
            country: Field::Absent,
            region: Field::Absent,
            label: Field::Absent,
            valid_from: Field::Absent,
            valid_to: Field::Absent,
            is_primary: None,
        }
    }
}

/// `UpdateRegistrationInput`: the type cannot change; the number is checked
/// against the stored type.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateRegistrationInput {
    pub number: Option<String>,
    pub country: Field<String>,
    pub region: Field<String>,
    pub label: Field<String>,
    pub valid_from: Field<String>,
    pub valid_to: Field<String>,
    pub is_primary: Option<bool>,
}

/// A row of `legal_entity_registrations`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationRow {
    pub id: String,
    pub entity_id: String,
    #[serde(rename = "type")]
    pub registration_type: String,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    pub number: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub valid_from: Option<String>,
    #[serde(default)]
    pub valid_to: Option<String>,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub verified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// `LegalEntityRegistration`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityRegistration {
    pub id: String,
    pub entity_id: String,
    /// The stored type (one of [`RegistrationType`]'s values).
    #[serde(rename = "type")]
    pub registration_type: String,
    pub number: String,
    pub country: Option<String>,
    pub region: Option<String>,
    pub label: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub is_primary: bool,
    pub verified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<RegistrationRow> for LegalEntityRegistration {
    fn from(row: RegistrationRow) -> Self {
        Self {
            id: row.id,
            entity_id: row.entity_id,
            registration_type: row.registration_type,
            number: row.number,
            country: row.country,
            region: row.region,
            label: row.label,
            valid_from: row.valid_from,
            valid_to: row.valid_to,
            is_primary: row.is_primary,
            verified_at: row.verified_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

/// `CreateBankAccountInput`, as Zod parsed it: `iban` compact and
/// upper-cased, `bic` upper-cased, `account_number` without spaces and
/// dashes; empty strings stay empty (the service stores them as null).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreateBankAccountInput {
    pub name: String,
    pub account_holder_name: Field<String>,
    pub iban: Field<String>,
    pub bic: Field<String>,
    pub bank_name: Field<String>,
    pub currency: Option<String>,
    pub account_type: Field<String>,
    pub routing_number: Field<String>,
    /// Write-only. Stored encrypted; responses carry only the last four digits.
    pub account_number: Field<String>,
    /// NACHA origination: immediate origin and destination, company id, balanced file.
    pub ach_settings: Field<Value>,
    pub is_default: Option<bool>,
    pub is_active: Option<bool>,
}

/// `UpdateBankAccountInput`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateBankAccountInput {
    pub name: Option<String>,
    pub account_holder_name: Field<String>,
    pub iban: Field<String>,
    pub bic: Field<String>,
    pub bank_name: Field<String>,
    pub currency: Option<String>,
    pub account_type: Field<String>,
    pub routing_number: Field<String>,
    pub account_number: Field<String>,
    pub ach_settings: Field<Value>,
    pub is_default: Option<bool>,
    pub is_active: Option<bool>,
}

/// A row of `bank_accounts` (the core columns).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankAccountRow {
    pub id: String,
    pub entity_id: String,
    pub name: String,
    #[serde(default)]
    pub iban: Option<String>,
    #[serde(default)]
    pub bic: Option<String>,
    #[serde(default)]
    pub bank_name: Option<String>,
    #[serde(default)]
    pub account_holder_name: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub account_type: Option<String>,
    #[serde(default)]
    pub routing_number: Option<String>,
    #[serde(default)]
    pub account_number_encrypted: Option<String>,
    #[serde(default)]
    pub account_number_last4: Option<String>,
    #[serde(default)]
    pub ach_settings: Value,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// `LegalEntityBankAccount`: a core bank account as the API returns it,
/// never the encrypted number.
// The response shape: its flags are the TypeScript type's.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityBankAccount {
    pub id: String,
    pub entity_id: String,
    pub name: String,
    pub account_holder_name: Option<String>,
    pub iban: Option<String>,
    pub bic: Option<String>,
    pub bank_name: Option<String>,
    pub currency: Option<String>,
    pub account_type: Option<String>,
    pub routing_number: Option<String>,
    pub account_number_last4: Option<String>,
    pub has_account_number: bool,
    pub ach_settings: Value,
    pub is_default: bool,
    pub is_active: bool,
    /// WeldBooks has a settings row for it (it is in the ledger).
    pub in_weldbooks: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `revealBankAccountNumber`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealBankAccount<'a> {
    pub entity_id: &'a str,
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub reason: Option<&'a str>,
}

/// The full number of an authorised reveal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedAccountNumber {
    pub account_number: String,
    pub routing_number: Option<String>,
}

// ---------------------------------------------------------------------------
// Per-entity access
// ---------------------------------------------------------------------------

/// `LegalEntityAccessMember`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityAccessMember {
    pub user_id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
    /// Their workspace role, for context in the UI.
    pub workspace_role: String,
    pub workspace_role_name: Option<String>,
    pub role_id: Option<String>,
    pub role_name: Option<String>,
    pub granted_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `LegalEntityAccess`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityAccess {
    pub entity_id: String,
    pub restricted: bool,
    pub members: Vec<LegalEntityAccessMember>,
}

/// The signed-in member's effective access inside one entity
/// (`LegalEntityEffectiveAccess`, `GET /:id/my-access`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalEntityEffectiveAccess {
    pub entity_id: String,
    pub source: EntityAccessSource,
    pub role_id: Option<String>,
    pub role_name: Option<String>,
    /// Effective permission keys inside this entity (role ∪ teams ∪ personal extras).
    pub permissions: Vec<String>,
    pub denies: Vec<String>,
    pub is_owner: bool,
}

/// A row of `legal_entity_members`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMemberRow {
    pub id: String,
    pub entity_id: String,
    pub user_id: String,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub granted_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `setEntityMember`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetEntityMember<'a> {
    pub entity_id: &'a str,
    pub user_id: &'a str,
    /// A `roles` row; `None` = the member's workspace role.
    pub role_id: Option<&'a str>,
    pub granted_by: &'a str,
}

/// `setEntityMember`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetEntityMemberResult {
    pub created: bool,
    pub member: EntityMemberRow,
}
