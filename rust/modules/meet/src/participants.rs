//! The participant resolver (`lib/participant-resolver.ts`) and the person
//! lookup it uses (`findOrCreatePersonByEmail` of `@weldsuite/db`): a meeting
//! attendee or session participant is a workspace member, or a Person found
//! (or created) by email. Best effort: a failure resolves to nothing.

use std::sync::Arc;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use weldsuite_ports::{DynFileStore, PutOptions};

use crate::now;

/// `ResolvedParticipantLink`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Link {
    pub(crate) workspace_member_id: Option<String>,
    pub(crate) person_id: Option<String>,
    pub(crate) avatar_url: Option<String>,
    pub(crate) display_name: Option<String>,
}

/// `ResolverInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Input<'a> {
    pub(crate) email: Option<&'a str>,
    pub(crate) name: Option<&'a str>,
    pub(crate) user_id: Option<&'a str>,
}

/// Where a new person's initials avatar goes (`STORAGE` and `R2_PUBLIC_URL`).
#[derive(Clone)]
pub(crate) struct AvatarStore {
    pub(crate) bucket: Option<Arc<dyn DynFileStore>>,
    pub(crate) public_url: Option<String>,
}

type MemberRow = (String, Option<String>, Option<String>);

fn member_link((id, name, picture): MemberRow) -> Link {
    Link {
        workspace_member_id: Some(id),
        avatar_url: picture,
        display_name: name,
        person_id: None,
    }
}

/// `resolveParticipantLink(tenantDb, env, workspaceId, input)`.
pub(crate) async fn resolve(
    db: &PgPool,
    avatars: &AvatarStore,
    workspace_id: &str,
    input: Input<'_>,
) -> Link {
    match try_resolve(db, avatars, workspace_id, input).await {
        Ok(link) => link,
        Err(error) => {
            tracing::error!(%error, "[ParticipantResolver] failed for workspace {workspace_id}");
            Link::default()
        }
    }
}

async fn try_resolve(
    db: &PgPool,
    avatars: &AvatarStore,
    workspace_id: &str,
    input: Input<'_>,
) -> Result<Link, sqlx::Error> {
    let user_id = input.user_id.map(str::trim);
    let email = input.email.map(|e| e.trim().to_lowercase());
    let name = input.name.map(str::trim);

    if let Some(user_id) = user_id.filter(|u| !u.is_empty() && !u.starts_with("guest:")) {
        let member: Option<MemberRow> = sqlx::query_as(
            "select id, name, picture from workspace_members where user_id = $1 limit 1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await?;
        if let Some(member) = member {
            return Ok(member_link(member));
        }
    }
    if let Some(email) = email.as_deref().filter(|e| !e.is_empty()) {
        let member: Option<MemberRow> = sqlx::query_as(
            "select id, name, picture from workspace_members where lower(email) = $1 limit 1",
        )
        .bind(email)
        .fetch_optional(db)
        .await?;
        if let Some(member) = member {
            return Ok(member_link(member));
        }
    }
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        return Ok(Link::default());
    };
    let Some(person) = find_or_create_person(db, &email, name).await? else {
        return Ok(Link::default());
    };

    let mut avatar_url = None;
    if !person.created {
        let existing: Option<Option<String>> = sqlx::query_scalar(
            "select avatar_url from people where id = $1 and deleted_at is null limit 1",
        )
        .bind(&person.id)
        .fetch_optional(db)
        .await?;
        avatar_url = existing.flatten();
    }
    // `resolved.displayName || name`.
    let display_name = Some(person.display_name.clone())
        .filter(|d| !d.is_empty())
        .or_else(|| name.map(str::to_owned));

    let needs_avatar = person.created || avatar_url.as_deref().is_none_or(str::is_empty);
    if needs_avatar
        && let (Some(files), Some(public_url)) =
            (avatars.bucket.clone(), avatars.public_url.as_deref())
    {
        let seed = name
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                email
                    .split('@')
                    .next()
                    .filter(|local| !local.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| email.clone());
        let svg = weldsuite_mail_domain::contacts::initials_avatar_svg(&seed);
        let key = format!(
            "workspaces/{workspace_id}/avatars/people/{}/logo.svg",
            person.id
        );
        let options = PutOptions::content_type("image/svg+xml");
        match files.put_boxed(&key, svg.into_bytes(), &options).await {
            Ok(_) => {
                let url = format!("{public_url}/{key}");
                if let Err(error) = sqlx::query(
                    "update people set avatar_url = $2, updated_at = $3::timestamp
                     where id = $1 and deleted_at is null",
                )
                .bind(&person.id)
                .bind(&url)
                .bind(now())
                .execute(db)
                .await
                {
                    tracing::error!(%error, "[ParticipantResolver] avatar generation failed for workspace {workspace_id}");
                }
                avatar_url = Some(url);
            }
            Err(error) => {
                tracing::error!(%error, "[ParticipantResolver] avatar generation failed for workspace {workspace_id}");
            }
        }
    }
    Ok(Link {
        workspace_member_id: None,
        person_id: Some(person.id),
        avatar_url,
        display_name,
    })
}

/// `ResolvedPerson`.
struct Person {
    id: String,
    display_name: String,
    created: bool,
}

/// `splitDisplayName`.
fn split_display_name(display_name: &str) -> (String, String) {
    let tokens: Vec<&str> = display_name.split_whitespace().collect();
    match tokens.as_slice() {
        [] => (String::new(), String::new()),
        [one] => ((*one).to_owned(), String::new()),
        [first @ .., last] => (first.join(" "), (*last).to_owned()),
    }
}

/// `deriveNames(email, { displayName })`.
fn derive_names(email: &str, display_name: Option<&str>) -> (String, String) {
    if let Some(display) = display_name.map(str::trim).filter(|d| !d.is_empty()) {
        let (first, last) = split_display_name(display);
        if !first.is_empty() || !last.is_empty() {
            return (first, last);
        }
    }
    let local = email.split('@').next().unwrap_or(email);
    let first = if local.is_empty() { email } else { local };
    (first.to_owned(), String::new())
}

/// `findOrCreatePersonByEmail(db, { email, displayName }, generateId)`.
async fn find_or_create_person(
    db: &PgPool,
    email: &str,
    display_name: Option<&str>,
) -> Result<Option<Person>, sqlx::Error> {
    // `normalizeEmail`.
    let email = email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') || email.encode_utf16().count() > 255 {
        return Ok(None);
    }
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, display_name from people where lower(email) = $1 and deleted_at is null limit 1",
    )
    .bind(&email)
    .fetch_optional(db)
    .await?;
    if let Some((id, display_name)) = existing {
        return Ok(Some(Person {
            id,
            display_name,
            created: false,
        }));
    }
    let (first, last) = derive_names(&email, display_name);
    let full_name = if last.is_empty() {
        first.clone()
    } else {
        format!("{first} {last}").trim().to_owned()
    };
    let combined = format!("{first} {last}").trim().to_owned();
    let display = if !combined.is_empty() {
        combined
    } else if !full_name.is_empty() {
        full_name.clone()
    } else {
        email.clone()
    };
    let id = generate_id("person");
    let now = now();
    sqlx::query(
        "insert into people (id, created_at, updated_at, version, first_name, last_name,
             full_name, display_name, email, status, in_crm)
         values ($1, $2::timestamp, $2::timestamp, 1, $3, $4, $5, $6, $7, 'active', false)",
    )
    .bind(&id)
    .bind(&now)
    .bind(Some(first).filter(|f| !f.is_empty()))
    .bind(Some(last).filter(|l| !l.is_empty()))
    .bind(Some(full_name).filter(|f| !f.is_empty()))
    .bind(&display)
    .bind(&email)
    .execute(db)
    .await?;
    Ok(Some(Person {
        id,
        display_name: display,
        created: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_derive_like_the_person_resolver() {
        assert_eq!(
            derive_names("ann@example.com", Some("Ann Marie Smith")),
            ("Ann Marie".to_owned(), "Smith".to_owned())
        );
        assert_eq!(
            derive_names("ann@example.com", None),
            ("ann".to_owned(), String::new())
        );
        assert_eq!(
            derive_names("ann@example.com", Some("  ")),
            ("ann".to_owned(), String::new())
        );
    }
}
