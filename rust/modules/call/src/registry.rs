//! The master phone number registry (`lib/phone-registry.ts`): which
//! workspace (Clerk org id) a dialled number belongs to, for inbound calls.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::master::phone_number_registry as registry;

/// `normalizeE164(raw)`: digits with a leading `+`.
pub(crate) fn normalize_e164(raw: &str) -> String {
    let trimmed = weldsuite_kit::validation::js_trim(raw);
    let digits = |text: &str| -> String { text.chars().filter(char::is_ascii_digit).collect() };
    if let Some(rest) = trimmed.strip_prefix('+') {
        return format!("+{}", digits(rest));
    }
    let only = digits(trimmed);
    if only.is_empty() {
        trimmed.to_owned()
    } else {
        format!("+{only}")
    }
}

/// One registry entry to write.
pub(crate) struct Entry<'a> {
    pub(crate) phone_number: &'a str,
    pub(crate) clerk_org_id: &'a str,
    pub(crate) voip_phone_number_id: &'a str,
    pub(crate) is_active: bool,
}

/// `upsertPhoneNumberRegistry(env, args)`: a select, then an update or an
/// insert, as the worker does.
pub(crate) async fn upsert(master: Option<&PgPool>, entry: Entry<'_>) -> Result<(), String> {
    let master = orm(master.ok_or("no master database")?);
    let phone_number = normalize_e164(entry.phone_number);
    let now = utc_now();
    let existing: Option<String> = registry::Entity::find()
        .select_only()
        .column(registry::Column::PhoneNumber)
        .filter(registry::Column::PhoneNumber.eq(&phone_number))
        .limit(1)
        .into_tuple()
        .one(&master)
        .await
        .map_err(|error| error.to_string())?;
    if existing.is_some() {
        registry::Entity::update_many()
            .col_expr(registry::Column::ClerkOrgId, Expr::value(entry.clerk_org_id))
            .col_expr(
                registry::Column::VoipPhoneNumberId,
                Expr::value(entry.voip_phone_number_id),
            )
            .col_expr(registry::Column::IsActive, Expr::value(entry.is_active))
            .col_expr(registry::Column::UpdatedAt, Expr::value(now))
            .filter(registry::Column::PhoneNumber.eq(&phone_number))
            .exec(&master)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    registry::Entity::insert(registry::ActiveModel {
        phone_number: Set(phone_number),
        clerk_org_id: Set(entry.clerk_org_id.to_owned()),
        voip_phone_number_id: Set(entry.voip_phone_number_id.to_owned()),
        is_active: Set(entry.is_active),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec_without_returning(&master)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// A workspace's own registry row: the number, the workspace (Clerk org id)
/// and the number's row in its tenant (`OwnRegistryRow`).
pub(crate) struct OwnRow<'a> {
    pub(crate) phone_number: &'a str,
    pub(crate) clerk_org_id: &'a str,
    pub(crate) voip_phone_number_id: &'a str,
}

/// The caller's own entry: the number, the workspace and the tenant row.
fn own(row: &OwnRow<'_>) -> Condition {
    Condition::all()
        .add(registry::Column::PhoneNumber.eq(normalize_e164(row.phone_number)))
        .add(registry::Column::ClerkOrgId.eq(row.clerk_org_id))
        .add(registry::Column::VoipPhoneNumberId.eq(row.voip_phone_number_id))
}

/// `deactivatePhoneNumberRegistry(env, row)`: switch the caller's own entry
/// off. Another workspace's entry for the number is left alone.
pub(crate) async fn deactivate(master: Option<&PgPool>, row: OwnRow<'_>) -> Result<(), String> {
    let master = orm(master.ok_or("no master database")?);
    registry::Entity::update_many()
        .col_expr(registry::Column::IsActive, Expr::value(false))
        .col_expr(registry::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(own(&row))
        .exec(&master)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// `releasePhoneNumberRegistry(env, row)`: delete the caller's own entry.
pub(crate) async fn release(master: Option<&PgPool>, row: OwnRow<'_>) -> Result<(), String> {
    let master = orm(master.ok_or("no master database")?);
    registry::Entity::delete_many()
        .filter(own(&row))
        .exec(&master)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// `claimPhoneNumberRegistry(env, row)`: claim a number in one conditional
/// write. True when the number was free, or the existing entry is this
/// workspace's own and names this row or one of `reclaim_ids`; an entry of
/// another workspace holds the number (false, nothing written).
pub(crate) async fn claim(
    master: Option<&PgPool>,
    row: OwnRow<'_>,
    reclaim_ids: &[String],
) -> Result<bool, String> {
    let master = orm(master.ok_or("no master database")?);
    let mut ids: Vec<String> = vec![row.voip_phone_number_id.to_owned()];
    ids.extend(reclaim_ids.iter().cloned());
    let now = utc_now();
    // `on conflict (phone_number) do update … where` the entry is ours: the
    // insert, or the update its condition lets through, is the claim.
    let claimed = registry::Entity::insert(registry::ActiveModel {
        phone_number: Set(normalize_e164(row.phone_number)),
        clerk_org_id: Set(row.clerk_org_id.to_owned()),
        voip_phone_number_id: Set(row.voip_phone_number_id.to_owned()),
        is_active: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(registry::Column::PhoneNumber)
            .update_columns([
                registry::Column::VoipPhoneNumberId,
                registry::Column::IsActive,
                registry::Column::UpdatedAt,
            ])
            .action_cond_where(
                Condition::all()
                    .add(registry::Column::ClerkOrgId.eq(row.clerk_org_id))
                    .add(registry::Column::VoipPhoneNumberId.is_in(ids)),
            )
            .to_owned(),
    )
    .exec_without_returning(&master)
    .await
    .map_err(|error| error.to_string())?;
    Ok(claimed > 0)
}

/// `lookupPhoneNumberRegistry(masterDb, phoneNumber)`: the active entry's
/// `(clerkOrgId, voipPhoneNumberId)`.
pub(crate) async fn lookup(
    master: &PgPool,
    phone_number: &str,
) -> Result<Option<(String, String)>, DbErr> {
    let row: Option<(String, String, bool)> = registry::Entity::find()
        .select_only()
        .columns([
            registry::Column::ClerkOrgId,
            registry::Column::VoipPhoneNumberId,
            registry::Column::IsActive,
        ])
        .filter(registry::Column::PhoneNumber.eq(normalize_e164(phone_number)))
        .limit(1)
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(row
        .filter(|(_, _, active)| *active)
        .map(|(org, id, _)| (org, id)))
}

#[cfg(test)]
mod tests {
    use super::normalize_e164;

    #[test]
    fn numbers_normalise_like_the_worker() {
        assert_eq!(normalize_e164(" +31 (20) 123-4567 "), "+31201234567");
        assert_eq!(normalize_e164("0031 20 1234567"), "+0031201234567");
        assert_eq!(normalize_e164("unknown"), "unknown");
    }
}
