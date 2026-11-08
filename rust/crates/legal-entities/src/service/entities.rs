//! Entities: list, read, create, update, default, archive, delete, usage.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use super::types::{
    CreateLegalEntityInput, EntityRow, LegalEntity, LegalEntityMyAccess, LegalEntityUsage,
    ListLegalEntitiesOptions, UpdateLegalEntityInput,
};
use super::{
    Columns, LegalEntityError, Param, insert_returning, js_truthy, now_iso, read_row,
    update_returning,
};
use crate::access::{
    EntityAccess, can_see_entity, entity_access_source, entity_role_id, visible_entity_ids,
};
use crate::extensions::{
    LegalEntityApp, LegalEntityCoreChange, enabled_apps_by_entity, locked_core_change,
};

pub(super) fn entity_row(value: Value) -> Result<EntityRow, LegalEntityError> {
    let (mut row, json): (EntityRow, Value) = read_row(value)?;
    row.row = json;
    Ok(row)
}

/// A live entity (`loadEntityRow`).
pub(super) async fn load_entity_row(
    db: &PgPool,
    id: &str,
) -> Result<Option<EntityRow>, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from entities t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(entity_row).transpose()
}

/// `requireEntityRow`: `NOT_FOUND` "Legal entity not found".
pub(super) async fn require_entity_row(
    db: &PgPool,
    id: &str,
) -> Result<EntityRow, LegalEntityError> {
    load_entity_row(db, id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))
}

/// `{ logoUrl, primaryColor, accentColor }` of the stored branding when any
/// of them is set (keys that are absent stay absent), else null.
fn branding_view(branding: &Value) -> Value {
    let Value::Object(stored) = branding else {
        return Value::Null;
    };
    let keys = ["logoUrl", "primaryColor", "accentColor"];
    if !keys
        .iter()
        .any(|key| stored.get(*key).is_some_and(js_truthy))
    {
        return Value::Null;
    }
    let mut view = Map::new();
    for key in keys {
        if let Some(value) = stored.get(key) {
            view.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(view)
}

/// `toLegalEntity(row, enabledApps, access)`.
fn to_legal_entity(
    row: &EntityRow,
    enabled_apps: Vec<LegalEntityApp>,
    access: Option<&EntityAccess>,
) -> LegalEntity {
    LegalEntity {
        id: row.id.clone(),
        name: row.name.clone(),
        legal_name: row.legal_name.clone(),
        dba: row.dba.clone(),
        entity_type: row.entity_type.clone(),
        jurisdiction_code: row.jurisdiction_code.clone(),
        base_currency: row.base_currency.clone(),
        locale: row.locale.clone(),
        timezone: row.timezone.clone(),
        address: row.address.clone(),
        contact: row.contact.clone(),
        branding: branding_view(&row.branding),
        fiscal_year_start: row.fiscal_year_start,
        fiscal_year_config: row.fiscal_year_config.clone(),
        tax_classification: row.tax_classification.clone(),
        is_default: row.is_default == Some(true),
        is_active: row.is_active != Some(false),
        access_restricted: row.access_restricted,
        enabled_apps,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        my_access: access.map(|access| LegalEntityMyAccess {
            source: entity_access_source(access, &row.id),
            role_id: entity_role_id(access, Some(&row.id)).map(str::to_owned),
            role_name: None,
        }),
    }
}

/// `roleNames(db, ids)`: `roles.id` → `roles.name`.
pub(super) async fn role_names(
    db: &PgPool,
    role_ids: &[String],
) -> Result<HashMap<String, String>, LegalEntityError> {
    if role_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id, name from roles where id = any($1)")
            .bind(role_ids)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// `withRoleNames(db, entities)`: fill `myAccess.roleName`.
async fn with_role_names(
    db: &PgPool,
    mut entities: Vec<LegalEntity>,
) -> Result<Vec<LegalEntity>, LegalEntityError> {
    let mut role_ids: Vec<String> = Vec::new();
    for role_id in entities
        .iter()
        .filter_map(|entity| entity.my_access.as_ref()?.role_id.clone())
    {
        if !role_ids.contains(&role_id) {
            role_ids.push(role_id);
        }
    }
    if role_ids.is_empty() {
        return Ok(entities);
    }
    let names = role_names(db, &role_ids).await?;
    for entity in &mut entities {
        if let Some(access) = entity.my_access.as_mut()
            && let Some(role_id) = &access.role_id
        {
            access.role_name = names.get(role_id).cloned();
        }
    }
    Ok(entities)
}

/// `listLegalEntities(db, { access, app, includeArchived })`: with `access`,
/// only what the member sees, with `myAccess`. Default first, then by name.
pub async fn list_legal_entities(
    db: &PgPool,
    access: Option<&EntityAccess>,
    options: ListLegalEntitiesOptions,
) -> Result<Vec<LegalEntity>, LegalEntityError> {
    let visible = match access {
        Some(access) => {
            let visible = visible_entity_ids(access);
            if visible.is_empty() {
                return Ok(Vec::new());
            }
            Some(visible)
        }
        None => None,
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from entities t
         where t.deleted_at is null
           and ($1 or t.is_active is not false)
           and ($2::text[] is null or t.id = any($2))
         order by t.is_default desc, t.name asc, t.id asc",
    )
    .bind(options.include_archived)
    .bind(visible)
    .fetch_all(db)
    .await?;
    let rows = rows
        .into_iter()
        .map(entity_row)
        .collect::<Result<Vec<_>, _>>()?;
    let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let mut apps = enabled_apps_by_entity(db, &ids).await?;
    let entities = rows
        .iter()
        .map(|row| to_legal_entity(row, apps.remove(&row.id).unwrap_or_default(), access))
        .filter(|entity| {
            options
                .app
                .is_none_or(|app| entity.enabled_apps.contains(&app))
        })
        .collect();
    with_role_names(db, entities).await
}

/// One entity (`getLegalEntity`), or `None` when it is deleted, unknown or
/// (with `access`) not visible to the member.
pub async fn get_legal_entity(
    db: &PgPool,
    id: &str,
    access: Option<&EntityAccess>,
) -> Result<Option<LegalEntity>, LegalEntityError> {
    if let Some(access) = access
        && !can_see_entity(access, Some(id))
    {
        return Ok(None);
    }
    let Some(row) = load_entity_row(db, id).await? else {
        return Ok(None);
    };
    let mut apps = enabled_apps_by_entity(db, std::slice::from_ref(&row.id)).await?;
    let entity = to_legal_entity(&row, apps.remove(&row.id).unwrap_or_default(), access);
    Ok(with_role_names(db, vec![entity]).await?.pop())
}

/// `getDefaultLegalEntityRow`.
pub async fn get_default_legal_entity_row(
    db: &PgPool,
) -> Result<Option<EntityRow>, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from entities t
         where t.is_default = true and t.deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    row.map(entity_row).transpose()
}

/// `getDefaultLegalEntity`.
pub async fn get_default_legal_entity(
    db: &PgPool,
    access: Option<&EntityAccess>,
) -> Result<Option<LegalEntity>, LegalEntityError> {
    match get_default_legal_entity_row(db).await? {
        Some(row) => get_legal_entity(db, &row.id, access).await,
        None => Ok(None),
    }
}

fn default_locale(country: &str) -> &'static str {
    match country {
        "NL" => "nl-NL",
        "BE" => "nl-BE",
        "DE" => "de-DE",
        "FR" => "fr-FR",
        "US" => "en-US",
        "IN" => "en-IN",
        "BR" => "pt-BR",
        _ => "en-GB",
    }
}

fn text_field(field: &Field<String>) -> Option<Param> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Param::Text(None)),
        Field::Set(value) => Some(Param::Text(Some(value.clone()))),
    }
}

fn json_field(field: &Field<Value>) -> Option<Param> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Param::Json(None)),
        Field::Set(value) => Some(Param::Json(Some(value.clone()))),
    }
}

/// `coreColumns(input, existing)`: the core columns of a create/update
/// input. Document texts in `branding` are WeldBooks' and are kept as they are.
fn core_columns(input: &UpdateLegalEntityInput, existing: Option<&EntityRow>) -> Columns {
    let mut out = Columns::default();
    let mut set = |column: &'static str, param: Option<Param>| {
        if let Some(param) = param {
            out.set(column, param);
        }
    };
    set("name", input.name.clone().map(|v| Param::Text(Some(v))));
    set("legal_name", text_field(&input.legal_name));
    set("dba", text_field(&input.dba));
    set("entity_type", text_field(&input.entity_type));
    set(
        "jurisdiction_code",
        input
            .jurisdiction_code
            .clone()
            .map(|v| Param::Text(Some(v))),
    );
    set(
        "base_currency",
        input.base_currency.clone().map(|v| Param::Text(Some(v))),
    );
    set("locale", input.locale.clone().map(|v| Param::Text(Some(v))));
    set(
        "timezone",
        input.timezone.clone().map(|v| Param::Text(Some(v))),
    );
    set("address", json_field(&input.address));
    set("contact", json_field(&input.contact));
    set(
        "fiscal_year_start",
        input.fiscal_year_start.map(|v| Param::Int(Some(v))),
    );
    set("fiscal_year_config", json_field(&input.fiscal_year_config));
    set("tax_classification", text_field(&input.tax_classification));
    if !input.branding.is_absent() {
        let mut branding = match &input.branding {
            Field::Set(Value::Object(fields)) => fields.clone(),
            _ => Map::new(),
        };
        if let Some(Value::Object(stored)) = existing.map(|row| &row.branding) {
            for key in ["footerText", "paymentInstructions", "termsAndConditions"] {
                if let Some(value) = stored.get(key) {
                    branding.insert(key.to_owned(), value.clone());
                }
            }
        }
        set("branding", Some(Param::Json(Some(Value::Object(branding)))));
    }
    out
}

/// `createLegalEntity`: the first entity becomes the default, as does one
/// created with `is_default`.
pub async fn create_legal_entity(
    db: &PgPool,
    input: &CreateLegalEntityInput,
) -> Result<EntityRow, LegalEntityError> {
    let id = generate_id("ent");
    let country = input.jurisdiction_code.as_str();
    let existing_default: Option<String> = sqlx::query_scalar(
        "select id from entities where is_default = true and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    let make_default = existing_default.is_none() || input.is_default == Some(true);

    if make_default && let Some(existing) = &existing_default {
        sqlx::query(
            "update entities set is_default = false, updated_at = $1::timestamp where id = $2",
        )
        .bind(now_iso())
        .bind(existing)
        .execute(db)
        .await?;
    }
    let mut columns = Columns::default();
    columns.set("id", Param::Text(Some(id)));
    for (column, param) in core_columns(&input.as_update(), None).0 {
        columns.set(column, param);
    }
    columns.set("name", Param::Text(Some(input.name.clone())));
    columns.set("jurisdiction_code", Param::Text(Some(country.to_owned())));
    columns.set(
        "base_currency",
        Param::Text(Some(input.base_currency.clone())),
    );
    columns.set(
        "locale",
        Param::Text(Some(
            input
                .locale
                .clone()
                .unwrap_or_else(|| default_locale(country).to_owned()),
        )),
    );
    columns.set(
        "timezone",
        Param::Text(
            input
                .timezone
                .clone()
                .or_else(|| (country == "NL").then(|| "Europe/Amsterdam".to_owned())),
        ),
    );
    columns.set("is_default", Param::Bool(Some(make_default)));
    columns.set("is_active", Param::Bool(Some(true)));
    entity_row(insert_returning(db, "entities", columns).await?)
}

/// Keys of a `jsonb` object in Postgres's order: shorter keys first, then
/// by bytes.
fn stored_key_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// Keys of a parsed `fiscalYearConfig` in the schema's order.
fn schema_key_order(a: &str, b: &str) -> std::cmp::Ordering {
    let rank = |key: &str| {
        ["type", "endMonth", "weekday", "rule"]
            .iter()
            .position(|known| *known == key)
            .unwrap_or(usize::MAX)
    };
    rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
}

/// `JSON.stringify(value)` with the object's keys in `order`.
fn json_text(value: &Value, order: fn(&str, &str) -> std::cmp::Ordering) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_by(|a, b| order(a, b));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        fields
                            .get(key)
                            .map_or_else(String::new, |v| json_text(v, order))
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|item| json_text(item, order)).collect();
            format!("[{}]", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// `coreChange(existing, patch)`: which history-bearing fields a patch
/// changes, codes compared case-insensitively. The fiscal year config is
/// compared as `JSON.stringify` text, key order included, as TypeScript
/// does: a config from the schema (its key order) never reads equal to the
/// stored `jsonb` (Postgres's key order), so sending one counts as a change.
fn core_change(existing: &EntityRow, patch: &Columns) -> LegalEntityCoreChange {
    let differs = |column: &str, current: &str| match patch.get(column) {
        Some(Param::Text(next)) => {
            next.as_deref().unwrap_or_default().to_uppercase() != current.to_uppercase()
        }
        _ => false,
    };
    let start_changed = match patch.get("fiscal_year_start") {
        Some(Param::Int(next)) => next.map(i64::from) != existing.fiscal_year_start,
        _ => false,
    };
    let config_changed = match patch.get("fiscal_year_config") {
        Some(Param::Json(next)) => {
            let next = next.clone().unwrap_or(Value::Null);
            json_text(&next, schema_key_order)
                != json_text(&existing.fiscal_year_config, stored_key_order)
        }
        _ => false,
    };
    LegalEntityCoreChange {
        jurisdiction_code: differs("jurisdiction_code", &existing.jurisdiction_code),
        base_currency: differs("base_currency", &existing.base_currency),
        fiscal_year: start_changed || config_changed,
    }
}

/// `updateLegalEntity`: CONFLICT when an app enabled for the entity forbids
/// the change ([`locked_core_change`]). Nothing to change answers the row as
/// it is.
pub async fn update_legal_entity(
    db: &PgPool,
    id: &str,
    input: &UpdateLegalEntityInput,
) -> Result<EntityRow, LegalEntityError> {
    let existing = require_entity_row(db, id).await?;
    let mut patch = core_columns(input, Some(&existing));
    if patch.is_empty() {
        return Ok(existing);
    }
    if let Some(locked) = locked_core_change(db, id, core_change(&existing, &patch)).await? {
        return Err(LegalEntityError::conflict(locked));
    }
    patch.set("updated_at", Param::Timestamp(Some(now_iso())));
    let row = update_returning(db, "entities", patch, id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))?;
    entity_row(row)
}

/// `setDefaultLegalEntity`: CONFLICT for an archived entity; mirrors the
/// default into `settings.default_entity_id` when WeldBooks is enabled for it.
pub async fn set_default_legal_entity(
    db: &PgPool,
    id: &str,
) -> Result<EntityRow, LegalEntityError> {
    let entity = require_entity_row(db, id).await?;
    if entity.is_active == Some(false) {
        return Err(LegalEntityError::conflict(
            "An archived legal entity cannot be the default",
        ));
    }
    if entity.is_default == Some(true) {
        return Ok(entity);
    }
    let now = now_iso();
    sqlx::query(
        "update entities set is_default = false, updated_at = $1::timestamp
         where is_default = true and id <> $2",
    )
    .bind(&now)
    .bind(id)
    .execute(db)
    .await?;
    let mut columns = Columns::default();
    columns.set("is_default", Param::Bool(Some(true)));
    columns.set("updated_at", Param::Timestamp(Some(now.clone())));
    let row = update_returning(db, "entities", columns, id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))?;
    // Release 1 mirror: WeldBooks still reads settings.default_entity_id.
    if LegalEntityApp::Weldbooks.is_enabled_for(db, id).await? {
        sqlx::query("update settings set default_entity_id = $1, updated_at = $2::timestamp")
            .bind(id)
            .bind(&now)
            .execute(db)
            .await?;
    }
    entity_row(row)
}

/// `setLegalEntityArchived`: the default cannot be archived.
pub async fn set_legal_entity_archived(
    db: &PgPool,
    id: &str,
    archived: bool,
) -> Result<EntityRow, LegalEntityError> {
    let entity = require_entity_row(db, id).await?;
    if archived && entity.is_default == Some(true) {
        return Err(LegalEntityError::conflict(
            "Make another legal entity the default before archiving this one",
        ));
    }
    let mut columns = Columns::default();
    columns.set("is_active", Param::Bool(Some(!archived)));
    columns.set("updated_at", Param::Timestamp(Some(now_iso())));
    let row = update_returning(db, "entities", columns, id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))?;
    entity_row(row)
}

/// `legalEntityUsage`: per app, whether it is enabled and holds data.
pub async fn legal_entity_usage(
    db: &PgPool,
    id: &str,
) -> Result<Vec<LegalEntityUsage>, LegalEntityError> {
    require_entity_row(db, id).await?;
    let mut usage = Vec::new();
    for app in LegalEntityApp::ALL {
        let enabled = app.is_enabled_for(db, id).await?;
        let has_data = if enabled {
            app.has_data(db, id).await?
        } else {
            false
        };
        usage.push(LegalEntityUsage {
            app,
            enabled,
            has_data,
        });
    }
    Ok(usage)
}

/// `deleteLegalEntity`: soft delete. Refused for the default and while any
/// app holds data for the entity; its member rows go with it.
pub async fn delete_legal_entity(db: &PgPool, id: &str) -> Result<EntityRow, LegalEntityError> {
    let entity = require_entity_row(db, id).await?;
    if entity.is_default == Some(true) {
        return Err(LegalEntityError::conflict(
            "Make another legal entity the default before deleting this one",
        ));
    }
    let in_use: Vec<&str> = legal_entity_usage(db, id)
        .await?
        .into_iter()
        .filter(|usage| usage.has_data)
        .map(|usage| usage.app.as_str())
        .collect();
    if !in_use.is_empty() {
        return Err(LegalEntityError::conflict(format!(
            "This legal entity still has data in {}; archive it instead",
            in_use.join(", ")
        )));
    }
    let now = now_iso();
    let mut columns = Columns::default();
    columns.set("deleted_at", Param::Timestamp(Some(now.clone())));
    columns.set("is_active", Param::Bool(Some(false)));
    columns.set("updated_at", Param::Timestamp(Some(now)));
    let row = update_returning(db, "entities", columns, id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))?;
    sqlx::query("delete from legal_entity_members where entity_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    entity_row(row)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(fiscal_year_config: Value, branding: Value) -> EntityRow {
        EntityRow {
            id: "ent_1".to_owned(),
            name: "Acme".to_owned(),
            legal_name: None,
            dba: None,
            entity_type: None,
            jurisdiction_code: "NL".to_owned(),
            base_currency: "EUR".to_owned(),
            locale: "nl-NL".to_owned(),
            timezone: None,
            address: Value::Null,
            contact: Value::Null,
            branding,
            tax_identifiers: Value::Null,
            fiscal_year_start: Some(1),
            fiscal_year_config,
            tax_classification: None,
            is_default: Some(true),
            is_active: None,
            access_restricted: false,
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            deleted_at: None,
            row: Value::Null,
        }
    }

    #[test]
    fn branding_shows_only_the_core_keys_and_only_when_one_is_set() {
        assert_eq!(branding_view(&Value::Null), Value::Null);
        assert_eq!(
            branding_view(&json!({ "footerText": "x", "logoUrl": "" })),
            Value::Null
        );
        assert_eq!(
            branding_view(&json!({ "footerText": "x", "logoUrl": "", "primaryColor": "#000" })),
            json!({ "logoUrl": "", "primaryColor": "#000" })
        );
    }

    #[test]
    fn updates_keep_weldbooks_document_texts_in_branding() {
        let existing = row(
            Value::Null,
            json!({ "logoUrl": "a", "footerText": "Thanks" }),
        );
        let input = UpdateLegalEntityInput {
            branding: Field::Set(json!({ "primaryColor": "#fff" })),
            ..UpdateLegalEntityInput::default()
        };
        let columns = core_columns(&input, Some(&existing));
        assert!(matches!(
            columns.get("branding"),
            Some(Param::Json(Some(value))) if *value == json!({ "primaryColor": "#fff", "footerText": "Thanks" })
        ));
        let cleared = UpdateLegalEntityInput {
            branding: Field::Null,
            ..UpdateLegalEntityInput::default()
        };
        assert!(matches!(
            core_columns(&cleared, Some(&existing)).get("branding"),
            Some(Param::Json(Some(value))) if *value == json!({ "footerText": "Thanks" })
        ));
        assert!(core_columns(&UpdateLegalEntityInput::default(), Some(&existing)).is_empty());
    }

    #[test]
    fn codes_compare_case_insensitively_and_a_sent_config_always_changes() {
        let stored = json!({ "type": "fifty_two_fifty_three", "endMonth": 12, "weekday": 6, "rule": "last" });
        let existing = row(stored.clone(), Value::Null);
        let same_country = UpdateLegalEntityInput {
            jurisdiction_code: Some("nl".to_owned()),
            fiscal_year_start: Some(1),
            ..UpdateLegalEntityInput::default()
        };
        assert_eq!(
            core_change(&existing, &core_columns(&same_country, Some(&existing))),
            LegalEntityCoreChange::default()
        );
        let resent = UpdateLegalEntityInput {
            fiscal_year_config: Field::Set(stored),
            ..UpdateLegalEntityInput::default()
        };
        assert!(core_change(&existing, &core_columns(&resent, Some(&existing))).fiscal_year);
        let cleared_twice = UpdateLegalEntityInput {
            fiscal_year_config: Field::Null,
            ..UpdateLegalEntityInput::default()
        };
        let no_config = row(Value::Null, Value::Null);
        assert!(
            !core_change(&no_config, &core_columns(&cleared_twice, Some(&no_config))).fiscal_year
        );
        let new_start = UpdateLegalEntityInput {
            fiscal_year_start: Some(4),
            base_currency: Some("USD".to_owned()),
            ..UpdateLegalEntityInput::default()
        };
        let change = core_change(&existing, &core_columns(&new_start, Some(&existing)));
        assert!(change.fiscal_year && change.base_currency && !change.jurisdiction_code);
    }

    #[test]
    fn default_locales() {
        assert_eq!(default_locale("BE"), "nl-BE");
        assert_eq!(default_locale("ES"), "en-GB");
    }
}
