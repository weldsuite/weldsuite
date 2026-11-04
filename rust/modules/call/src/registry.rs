//! The master phone number registry (`lib/phone-registry.ts`): which
//! workspace (Clerk org id) a dialled number belongs to, for inbound calls.

use weldsuite_db::PgPool;

use crate::now;

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
    let master = master.ok_or("no master database")?;
    let phone_number = normalize_e164(entry.phone_number);
    let now = now();
    let existing: Option<String> = sqlx::query_scalar(
        "select phone_number from phone_number_registry where phone_number = $1 limit 1",
    )
    .bind(&phone_number)
    .fetch_optional(master)
    .await
    .map_err(|error| error.to_string())?;
    if existing.is_some() {
        sqlx::query(
            "update phone_number_registry set clerk_org_id = $2, voip_phone_number_id = $3,
                 is_active = $4, updated_at = $5::timestamp
             where phone_number = $1",
        )
        .bind(&phone_number)
        .bind(entry.clerk_org_id)
        .bind(entry.voip_phone_number_id)
        .bind(entry.is_active)
        .bind(&now)
        .execute(master)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    sqlx::query(
        "insert into phone_number_registry
             (phone_number, clerk_org_id, voip_phone_number_id, is_active, created_at, updated_at)
         values ($1, $2, $3, $4, $5::timestamp, $5::timestamp)",
    )
    .bind(&phone_number)
    .bind(entry.clerk_org_id)
    .bind(entry.voip_phone_number_id)
    .bind(entry.is_active)
    .bind(&now)
    .execute(master)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// `deactivatePhoneNumberRegistry(env, phoneNumber)`.
pub(crate) async fn deactivate(master: Option<&PgPool>, phone_number: &str) -> Result<(), String> {
    let master = master.ok_or("no master database")?;
    sqlx::query(
        "update phone_number_registry set is_active = false, updated_at = $2::timestamp
         where phone_number = $1",
    )
    .bind(normalize_e164(phone_number))
    .bind(now())
    .execute(master)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// `lookupPhoneNumberRegistry(masterDb, phoneNumber)`: the active entry's
/// `(clerkOrgId, voipPhoneNumberId)`.
pub(crate) async fn lookup(
    master: &PgPool,
    phone_number: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, String, bool)> = sqlx::query_as(
        "select clerk_org_id, voip_phone_number_id, is_active from phone_number_registry
         where phone_number = $1 limit 1",
    )
    .bind(normalize_e164(phone_number))
    .fetch_optional(master)
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
