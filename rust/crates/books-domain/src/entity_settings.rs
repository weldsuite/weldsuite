//! An entity's `jurisdiction_settings` jsonb as the keys Rust-only features
//! keep in it are read and written (`differences`, `emailTemplates`,
//! `reminders`): one read of the whole object, one write that keeps the rest.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::entities;

/// The keys phase 4 keeps in `jurisdiction_settings` besides `differences`.
pub const DELIVERY_KEYS: [&str; 2] = [crate::email_templates::KEY, crate::reminders::KEY];

/// The entity's whole `jurisdictionSettings` (`None` for no such entity).
///
/// # Errors
///
/// The database's.
pub async fn load(db: &PgPool, entity_id: &str) -> Result<Option<Value>, DbErr> {
    let row = entities::Entity::find_by_id(entity_id.to_owned())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| row.jurisdiction_settings.unwrap_or(Value::Null)))
}

/// `settings` (an entity update's new `jurisdictionSettings`) with the keys
/// of `stored` named in `keys` carried over, unless the update names its own.
pub fn keep_keys(settings: Value, stored: Option<&Value>, keys: &[&str]) -> Value {
    let (Value::Object(mut all), Some(Value::Object(stored))) = (settings.clone(), stored) else {
        return settings;
    };
    for key in keys {
        if !all.contains_key(*key)
            && let Some(value) = stored.get(*key)
        {
            all.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(all)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_update_that_replaces_the_settings_keeps_the_delivery_keys() {
        let stored = json!({ "reminders": { "enabled": true }, "emailTemplates": {}, "other": 1 });
        let out = keep_keys(json!({ "stateCode": "X" }), Some(&stored), &DELIVERY_KEYS);
        assert_eq!(out["reminders"]["enabled"], true);
        assert!(out.get("emailTemplates").is_some());
        assert!(out.get("other").is_none());
        let own = keep_keys(
            json!({ "reminders": { "enabled": false } }),
            Some(&stored),
            &DELIVERY_KEYS,
        );
        assert_eq!(own["reminders"]["enabled"], false);
    }
}
