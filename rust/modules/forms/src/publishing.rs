//! Versions and the lifecycle (`services/publishing.ts`): publish (snapshot a
//! version, allocate the public link on the first publish, write the public
//! cache, screen the content), close, reopen and discard the draft's changes.
//! A response points at the version it answered (ADR FORMS-003).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sqlx::types::Json;

use crate::common::{
    Ctx, FormsResult, all, forms_error, forms_error_with, iso, js_slice, not_found, one, opt_text,
    text,
};
use crate::engine::{FormDefinition, fields_of, parse_definition};
use crate::forms::load_row;
use crate::members::{bare_ref, member_refs};
use crate::model::{parsed_definition, parsed_theme};
use crate::public_cache::refresh_public_cache;

// ---------------------------------------------------------------------------
// The content screen (`services/content-screen.ts`)
// ---------------------------------------------------------------------------

static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    let words = [
        "passwords?",
        "passcode",
        "wachtwoord",
        "pincode",
        "pin code",
        r"\bpin\b",
        "cvv",
        "cvc",
        "card number",
        "kaartnummer",
        "creditcard",
        "credit card",
        "security code",
        "beveiligingscode",
        "verification code",
        "verificatiecode",
        "one-time code",
        "recovery phrase",
        "seed phrase",
        "private key",
        "online banking",
        "internetbankieren",
        "bank login",
        "bank log-?in",
    ];
    Regex::new(&format!("(?i-u){}", words.join("|"))).expect("the credential pattern compiles")
});

static BRANDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(microsoft|office ?365|outlook|google|gmail|paypal|apple ?id|icloud|amazon|netflix|facebook|instagram|whatsapp|linkedin|dhl|ups|fedex|postnl|ing|rabobank|abn ?amro|bunq|docusign|wetransfer|dropbox|digid|belastingdienst)\b")
        .expect("the brand pattern compiles")
});

static TAKEOVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(verify|verification|sign ?in|log ?in|login|account|suspended|locked|confirm|security alert|unusual activity|update your|bevestig|inloggen|geblokkeerd)\b")
        .expect("the takeover pattern compiles")
});

/// `screenForm(title, def)`: why the form is held, or `None`.
pub(crate) fn screen_form(title: &str, def: &FormDefinition) -> Option<String> {
    let fields = fields_of(def);
    for field in &fields {
        if CREDENTIAL.is_match(&field.title) {
            return Some(format!(
                "A question asks for a credential: \"{}\"",
                js_slice(&field.title, 120)
            ));
        }
    }
    let welcome = def.welcome.as_ref().map_or("", |w| w.title.as_str());
    let headlines = std::iter::once(title)
        .chain(std::iter::once(welcome))
        .chain(fields.iter().map(|f| f.title.as_str()));
    for text in headlines {
        if BRANDS.is_match(text) && TAKEOVER.is_match(text) {
            return Some(format!(
                "Looks like it imitates a brand: \"{}\"",
                js_slice(text, 120)
            ));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/// The theme a new version is published with: the form's own, else the
/// workspace default, else the defaults.
async fn theme_snapshot(ctx: &Ctx, form: &Value) -> FormsResult<Value> {
    let chosen: Option<Value> = match opt_text(form, "themeId") {
        Some(id) => {
            sqlx::query_scalar("select tokens from form_themes where id = $1 limit 1")
                .bind(id)
                .fetch_optional(&ctx.db)
                .await?
        }
        None => None,
    };
    let tokens = match chosen {
        Some(tokens) => Some(tokens),
        None => {
            sqlx::query_scalar("select tokens from form_themes where is_default = true limit 1")
                .fetch_optional(&ctx.db)
                .await?
        }
    };
    Ok(parsed_theme(&tokens.unwrap_or(Value::Null)))
}

/// `allocateLink(ctx, formId)`: a fresh 10-character base62 id in the master
/// registry; retried on the rare collision.
async fn allocate_link(ctx: &Ctx, form_id: &str) -> FormsResult<String> {
    for _ in 0..8 {
        let public_id = weldsuite_kit::random_string(10, weldsuite_kit::id::ALPHANUMERIC);
        let inserted: Option<String> = sqlx::query_scalar(
            "insert into form_link_registry (id, public_id, workspace_id, clerk_org_id, form_id) \
             values ($1, $2, $3, $4, $5) on conflict (public_id) do nothing returning id",
        )
        .bind(weldsuite_kit::generate_id("fln"))
        .bind(&public_id)
        .bind(&ctx.workspace_id)
        .bind(&ctx.clerk_org_id)
        .bind(form_id)
        .fetch_optional(ctx.master()?)
        .await?;
        if inserted.is_some() {
            return Ok(public_id);
        }
    }
    Err(forms_error(
        503,
        "LINK_ALLOCATION_FAILED",
        "Could not allocate a public link. Try again.",
    ))
}

/// `publishForm(ctx, form, userId)`: the form row and `{ id, number }` of the
/// new version. 422 `INVALID_DEFINITION` (details: the engine's issues) or
/// `NO_QUESTIONS`.
pub(crate) async fn publish_form(
    ctx: &Ctx,
    form: &Value,
    user_id: &str,
) -> FormsResult<(Value, Value)> {
    let definition = match parse_definition(&form["definition"]) {
        Ok(definition) => definition,
        Err(issues) => {
            return Err(forms_error_with(
                422,
                "INVALID_DEFINITION",
                "The form has problems that must be fixed before it can be published.",
                json!({ "issues": issues }),
            ));
        }
    };
    if fields_of(&definition).is_empty() {
        return Err(forms_error(
            422,
            "NO_QUESTIONS",
            "Add at least one question before publishing.",
        ));
    }
    let form_id = text(form, "id").to_owned();
    let public_id = match opt_text(form, "publicId") {
        Some(public_id) => public_id,
        None => allocate_link(ctx, &form_id).await?,
    };
    let latest: Option<i32> =
        sqlx::query_scalar("select max(number) from form_versions where form_id = $1")
            .bind(&form_id)
            .fetch_one(&ctx.db)
            .await?;
    let number = i64::from(latest.unwrap_or(0)) + 1;
    let version_id = weldsuite_kit::generate_id("fve");
    let now = iso(ctx.now_ms());
    let theme = theme_snapshot(ctx, form).await?;
    let stored = serde_json::to_value(&definition)?;
    weldsuite_db::atomically(
        &ctx.db,
        [
            sqlx::query(
                "insert into form_versions (id, form_id, number, definition, theme, published_by_user_id, published_at) \
                 values ($1, $2, $3, $4, $5, $6, $7::timestamptz)",
            )
            .bind(version_id.clone())
            .bind(form_id.clone())
            .bind(i32::try_from(number).unwrap_or(i32::MAX))
            .bind(Json(stored))
            .bind(Json(theme))
            .bind(user_id.to_owned())
            .bind(now.clone()),
            sqlx::query(
                "update forms set status = 'published', public_id = $2, published_version_id = $3, \
                 published_at = $4::timestamptz, closed_at = null, has_unpublished_changes = false, \
                 updated_at = $4::timestamptz where id = $1",
            )
            .bind(form_id.clone())
            .bind(public_id.clone())
            .bind(version_id.clone())
            .bind(now.clone()),
        ],
    )
    .await?;
    let row = load_row(ctx, &form_id).await?;

    // The content screen holds a suspicious form for staff; it never un-holds one.
    if let Some(reason) = screen_form(text(&row, "title"), &definition) {
        sqlx::query(
            "update form_link_registry set held_at = $2::timestamptz, held_reason = $3 where public_id = $1",
        )
        .bind(&public_id)
        .bind(&now)
        .bind(reason)
        .execute(ctx.master()?)
        .await?;
    }
    refresh_public_cache(ctx, &row).await?;
    Ok((row, json!({ "id": version_id, "number": number })))
}

/// `closeForm(ctx, form)`: 409 `NOT_PUBLISHED` for a form that is not live.
pub(crate) async fn close_form(ctx: &Ctx, form: &Value) -> FormsResult<Value> {
    if text(form, "status") != "published" {
        return Err(forms_error(
            409,
            "NOT_PUBLISHED",
            "Only a published form can be closed.",
        ));
    }
    let now = iso(ctx.now_ms());
    sqlx::query("update forms set status = 'closed', closed_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1")
        .bind(text(form, "id"))
        .bind(&now)
        .execute(&ctx.db)
        .await?;
    let row = load_row(ctx, text(form, "id")).await?;
    refresh_public_cache(ctx, &row).await?;
    Ok(row)
}

/// `reopenForm(ctx, form)`: 409 `NOT_CLOSED`.
pub(crate) async fn reopen_form(ctx: &Ctx, form: &Value) -> FormsResult<Value> {
    if text(form, "status") != "closed" || form["publishedVersionId"].is_null() {
        return Err(forms_error(
            409,
            "NOT_CLOSED",
            "Only a closed form can be reopened.",
        ));
    }
    sqlx::query("update forms set status = 'published', closed_at = null, updated_at = $2::timestamptz where id = $1")
        .bind(text(form, "id"))
        .bind(iso(ctx.now_ms()))
        .execute(&ctx.db)
        .await?;
    let row = load_row(ctx, text(form, "id")).await?;
    refresh_public_cache(ctx, &row).await?;
    Ok(row)
}

/// `discardChanges(ctx, form)`: the draft goes back to the published version.
pub(crate) async fn discard_changes(ctx: &Ctx, form: &Value) -> FormsResult<Value> {
    let Some(version_id) = opt_text(form, "publishedVersionId") else {
        return Err(forms_error(
            409,
            "NOT_PUBLISHED",
            "This form has no published version to go back to.",
        ));
    };
    let definition: Option<Value> =
        sqlx::query_scalar("select definition from form_versions where id = $1 limit 1")
            .bind(&version_id)
            .fetch_optional(&ctx.db)
            .await?;
    let Some(definition) = definition else {
        return Err(not_found("Version"));
    };
    sqlx::query(
        "update forms set definition = $2, has_unpublished_changes = false, revision = revision + 1, \
         updated_at = $3::timestamptz where id = $1",
    )
    .bind(text(form, "id"))
    .bind(Json(parsed_definition(&definition)))
    .bind(iso(ctx.now_ms()))
    .execute(&ctx.db)
    .await?;
    load_row(ctx, text(form, "id")).await
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// `listVersions(ctx, formId)`: newest first, with who published each and
/// how many responses it has.
pub(crate) async fn list_versions(ctx: &Ctx, form_id: &str) -> FormsResult<Vec<Value>> {
    let versions = all(
        &ctx.db,
        sqlx::query_scalar(
            "select jsonb_build_object('id', id, 'number', number, 'published_at', published_at, \
             'published_by_user_id', published_by_user_id) from form_versions \
             where form_id = $1 order by number desc",
        )
        .bind(form_id),
    )
    .await?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "select version_id, count(*)::int8 from form_responses where form_id = $1 group by version_id",
    )
    .bind(form_id)
    .fetch_all(&ctx.db)
    .await?;
    let refs = member_refs(
        &ctx.db,
        &versions
            .iter()
            .map(|v| text(v, "publishedByUserId").to_owned())
            .collect::<Vec<_>>(),
    )
    .await?;
    Ok(versions
        .iter()
        .map(|v| {
            let by = text(v, "publishedByUserId");
            let count = counts
                .iter()
                .find(|(id, _)| id == text(v, "id"))
                .map_or(0, |(_, n)| *n);
            json!({
                "id": v["id"],
                "number": v["number"],
                "publishedAt": v["publishedAt"],
                "publishedBy": refs.get(by).cloned().unwrap_or_else(|| bare_ref(by)),
                "responseCount": count,
            })
        })
        .collect())
}

/// `getVersion(ctx, formId, versionId)`.
pub(crate) async fn get_version(ctx: &Ctx, form_id: &str, version_id: &str) -> FormsResult<Value> {
    let summaries = list_versions(ctx, form_id).await?;
    let Some(mut summary) = summaries.into_iter().find(|v| v["id"] == version_id) else {
        return Err(not_found("Version"));
    };
    let row = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(v) from form_versions v where id = $1 limit 1")
            .bind(version_id),
    )
    .await?
    .ok_or_else(|| not_found("Version"))?;
    if let Value::Object(fields) = &mut summary {
        fields.insert(
            "definition".to_owned(),
            parsed_definition(&row["definition"]),
        );
        let theme = if row["theme"].is_null() {
            Value::Null
        } else {
            parsed_theme(&row["theme"])
        };
        fields.insert("theme".to_owned(), theme);
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(titles: &[&str]) -> FormDefinition {
        let blocks: Vec<Value> = titles
            .iter()
            .enumerate()
            .map(|(i, title)| {
                json!({ "id": format!("b_{i}"), "ref": format!("q{i}"), "type": "short_text", "title": title, "properties": {} })
            })
            .collect();
        FormDefinition::parse(&json!({
            "blocks": blocks,
            "endings": [{ "id": "e_done", "ref": "thanks", "title": "Thanks" }],
        }))
        .expect("a definition")
    }

    #[test]
    fn the_screen_holds_credentials_and_brand_lures() {
        let held = screen_form(
            "Account check",
            &definition(&["Enter your password to continue"]),
        );
        assert!(held.is_some_and(|reason| reason.contains("credential")));
        assert!(screen_form("Microsoft: verify your account", &definition(&["Name"])).is_some());
        assert!(screen_form("Which Google product do you use?", &definition(&["Name"])).is_none());
        assert!(screen_form("Spin class", &definition(&["Your shopping list"])).is_none());
    }
}
