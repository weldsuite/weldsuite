//! `upsertMailContacts` (`./contacts` over `@weldsuite/db/lib/mail-contacts`):
//! the addresses of a message into the shared `people` table, with an
//! initials avatar in the public bucket for every row it creates. Never
//! fails the send it runs for: errors are logged.

use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, PutOptions};
use weldsuite_schema::tenant::people;

use crate::outbound::clock::{now_ms, timestamp};

/// `MailContactAddress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactAddress {
    pub email: String,
    pub name: Option<String>,
}

impl ContactAddress {
    pub fn new(email: &str) -> Self {
        Self {
            email: email.to_owned(),
            name: None,
        }
    }
}

fn normalize_email(raw: &str) -> Option<String> {
    let trimmed = crate::text::js_trim(raw).to_lowercase();
    if trimmed.is_empty() || !trimmed.contains('@') || crate::text::utf16_len(&trimmed) > 255 {
        return None;
    }
    Some(trimmed)
}

/// `deriveNames(email, displayName)`.
fn derive_names(email: &str, display_name: Option<&str>) -> (String, String) {
    if let Some(name) = display_name.filter(|n| !crate::text::js_trim(n).is_empty()) {
        let tokens: Vec<&str> = name.split_whitespace().collect();
        let split = match tokens.as_slice() {
            [] => (String::new(), String::new()),
            [one] => ((*one).to_owned(), String::new()),
            [rest @ .., last] => (rest.join(" "), (*last).to_owned()),
        };
        if !split.0.is_empty() {
            return split;
        }
    }
    let local = email.split('@').next().unwrap_or(email);
    (
        if local.is_empty() { email } else { local }.to_owned(),
        String::new(),
    )
}

/// `generateInitialsAvatarSvg(name)`.
pub fn initials_avatar_svg(name: &str) -> String {
    const COLORS: [&str; 10] = [
        "#4F46E5", "#7C3AED", "#EC4899", "#EF4444", "#F97316", "#EAB308", "#22C55E", "#14B8A6",
        "#06B6D4", "#3B82F6",
    ];
    // `name.codePointAt(i)` over UTF-16 indexes, in 32-bit arithmetic.
    let units: Vec<u16> = name.encode_utf16().collect();
    let mut hash: i32 = 0;
    for i in 0..units.len() {
        let unit = units[i];
        let point = if (0xd800..0xdc00).contains(&unit)
            && i + 1 < units.len()
            && (0xdc00..0xe000).contains(&units[i + 1])
        {
            0x10000 + ((i32::from(unit) - 0xd800) << 10) + (i32::from(units[i + 1]) - 0xdc00)
        } else {
            i32::from(unit)
        };
        hash = point.wrapping_add(hash.wrapping_shl(5).wrapping_sub(hash));
    }
    let bg = COLORS[usize::try_from(hash.unsigned_abs() % 10).unwrap_or(0)];
    let initials: String = name
        .split_whitespace()
        .filter_map(|w| w.chars().next())
        .collect::<String>();
    let initials = crate::text::utf16_prefix(&initials, 2).to_uppercase();
    let initials = if initials.is_empty() {
        "?".to_owned()
    } else {
        initials
    };
    let size = if crate::text::utf16_len(&initials) > 1 {
        "48"
    } else {
        "56"
    };
    [
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"128\" viewBox=\"0 0 128 128\">".to_owned(),
        format!("<rect width=\"128\" height=\"128\" rx=\"16\" fill=\"{bg}\"/>"),
        "<text x=\"64\" y=\"64\" text-anchor=\"middle\" dominant-baseline=\"central\"".to_owned(),
        " font-family=\"system-ui,sans-serif\" font-weight=\"600\"".to_owned(),
        format!(" font-size=\"{size}\" fill=\"#fff\">"),
        initials,
        "</text>".to_owned(),
        "</svg>".to_owned(),
    ]
    .concat()
}

/// `upsertMailContactsBatch(db, addresses)`: `(contact id, email, created)`.
async fn upsert_batch(
    db: &PgPool,
    addresses: &[ContactAddress],
) -> Result<Vec<(String, String, bool)>, DbErr> {
    let mut by_email: Vec<(String, Option<String>)> = Vec::new();
    for address in addresses {
        let Some(email) = normalize_email(&address.email) else {
            continue;
        };
        match by_email.iter_mut().find(|(e, _)| *e == email) {
            Some((_, name)) if name.is_none() && address.name.is_some() => {
                name.clone_from(&address.name);
            }
            Some(_) => {}
            None => by_email.push((email, address.name.clone())),
        }
    }
    if by_email.is_empty() {
        return Ok(Vec::new());
    }
    let emails: Vec<String> = by_email.iter().map(|(e, _)| e.clone()).collect();
    let conn = orm(db);
    let existing: Vec<(String, Option<String>)> = people::Entity::find()
        .select_only()
        .columns([people::Column::Id, people::Column::Email])
        .filter(sea_orm::ExprTrait::is_in(
            Expr::from(Func::lower(Expr::col((people::Entity, people::Column::Email)))),
            emails,
        ))
        .filter(people::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&conn)
        .await?;
    let existing: HashMap<String, String> = existing
        .into_iter()
        .filter_map(|(id, email)| email.map(|e| (e.to_lowercase(), id)))
        .collect();
    let now = timestamp(now_ms());
    let mut results = Vec::new();
    let mut rows = Vec::new();
    for (email, name) in by_email {
        if let Some(id) = existing.get(&email) {
            results.push((id.clone(), email, false));
            continue;
        }
        let id = generate_id("person");
        let (first, last) = derive_names(&email, name.as_deref());
        let full = if last.is_empty() {
            first.clone()
        } else {
            format!("{first} {last}").trim().to_owned()
        };
        let display = {
            let combined = format!("{first} {last}").trim().to_owned();
            if combined.is_empty() {
                email.clone()
            } else {
                combined
            }
        };
        rows.push((id.clone(), first, last, full, display, email.clone()));
        results.push((id, email, true));
    }
    for (id, first, last, full, display, email) in rows {
        // Row by row, as the batch's per-row fallback: a concurrent insert of
        // the same address loses to the winner.
        // `nullif(name, '')`: an empty name part is stored as null.
        let part = |text: String| Some(text).filter(|text| !text.is_empty());
        let person = people::ActiveModel {
            id: Set(id),
            first_name: Set(part(first)),
            last_name: Set(part(last)),
            full_name: Set(part(full)),
            display_name: Set(display),
            email: Set(Some(email.clone())),
            status: Set("active".to_owned()),
            in_crm: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            version: Set(1),
            ..Default::default()
        };
        let inserted = people::Entity::insert(person)
            .exec_without_returning(&conn)
            .await;
        if inserted.is_err() {
            let winner: Option<String> = people::Entity::find()
                .select_only()
                .column(people::Column::Id)
                .filter(people::Column::Email.eq(&email))
                .filter(people::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&conn)
                .await?;
            if let (Some(winner), Some(at)) = (
                winner,
                results
                    .iter()
                    .position(|(_, e, created)| *e == email && *created),
            ) {
                results[at] = (winner, email, false);
            }
        }
    }
    Ok(results)
}

/// `upsertMailContacts(env, db, workspaceId, message)`. `public` and
/// `public_url` are `STORAGE` and `R2_PUBLIC_URL`: without both, no avatars.
pub async fn upsert_mail_contacts(
    db: &PgPool,
    org: &str,
    addresses: &[ContactAddress],
    public: Option<&Arc<dyn DynFileStore>>,
    public_url: Option<&str>,
) {
    let results = match upsert_batch(db, addresses).await {
        Ok(results) => results,
        Err(error) => {
            tracing::error!(%error, org, "[mail-contacts] upsertMailContacts failed");
            return;
        }
    };
    let (Some(storage), Some(public_url)) = (public, public_url) else {
        return;
    };
    for (contact_id, email, created) in results {
        if !created {
            continue;
        }
        let name = addresses
            .iter()
            .find(|a| normalize_email(&a.email).as_deref() == Some(email.as_str()))
            .and_then(|a| {
                a.name
                    .as_deref()
                    .map(crate::text::js_trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| email.split('@').next().unwrap_or(&email).to_owned());
        let key = format!("workspaces/{org}/avatars/people/{contact_id}/logo.svg");
        let svg = initials_avatar_svg(&name);
        let options = PutOptions {
            content_type: Some("image/svg+xml".to_owned()),
            ..PutOptions::default()
        };
        if let Err(error) = storage.put_boxed(&key, svg.into_bytes(), &options).await {
            tracing::error!(%error, email, "[mail-contacts] Failed to generate avatar");
            continue;
        }
        let url = format!("{public_url}/{key}");
        if let Err(error) = people::Entity::update_many()
            .col_expr(people::Column::AvatarUrl, Expr::value(url))
            .filter(people::Column::Id.eq(&contact_id))
            .exec(&orm(db))
            .await
        {
            tracing::error!(%error, email, "[mail-contacts] Failed to save avatar");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_avatars() {
        assert_eq!(
            derive_names("anna@x.com", Some("Anna de Vries")),
            ("Anna de".to_owned(), "Vries".to_owned())
        );
        assert_eq!(
            derive_names("anna@x.com", None),
            ("anna".to_owned(), String::new())
        );
        let svg = initials_avatar_svg("Anna Vries");
        assert!(svg.contains(">AV</text>"));
        assert!(svg.contains("font-size=\"48\""));
        assert!(initials_avatar_svg("bob").contains(">B</text>"));
    }
}
