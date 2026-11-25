//! Versions and the lifecycle (`services/publishing.ts`): publish (snapshot a
//! version, allocate the public link on the first publish, write the public
//! cache, screen the content), close, reopen and discard the draft's changes.
//! A response points at the version it answered (ADR FORMS-003).

use std::sync::LazyLock;

use regex::Regex;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, atomically_with, orm};
use weldsuite_schema::master::form_link_registry;
use weldsuite_schema::tenant::{form_responses, form_themes, form_versions, forms};

use crate::common::{
    Ctx, FormsResult, forms_error, forms_error_with, instant, js_slice, not_found, opt_text,
    row_json, text,
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
    let theme_tokens = || {
        form_themes::Entity::find()
            .select_only()
            .column(form_themes::Column::Tokens)
    };
    let db = orm(&ctx.db);
    let chosen: Option<Value> = match opt_text(form, "themeId") {
        Some(id) => {
            theme_tokens()
                .filter(form_themes::Column::Id.eq(id))
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let tokens = match chosen {
        Some(tokens) => Some(tokens),
        None => {
            theme_tokens()
                .filter(form_themes::Column::IsDefault.eq(true))
                .into_tuple()
                .one(&db)
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
        let inserted = form_link_registry::Entity::insert(form_link_registry::ActiveModel {
            id: Set(weldsuite_kit::generate_id("fln")),
            public_id: Set(public_id.clone()),
            workspace_id: Set(ctx.workspace_id.clone()),
            clerk_org_id: Set(ctx.clerk_org_id.clone()),
            form_id: Set(form_id.to_owned()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(form_link_registry::Column::PublicId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&orm(ctx.master()?))
        .await?;
        if inserted > 0 {
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
    let latest: Option<i32> = form_versions::Entity::find()
        .select_only()
        .column_as(
            Expr::from(Func::max(Expr::col(form_versions::Column::Number))),
            "max",
        )
        .filter(form_versions::Column::FormId.eq(&form_id))
        .into_tuple::<Option<i32>>()
        .one(&orm(&ctx.db))
        .await?
        .flatten();
    let number = i64::from(latest.unwrap_or(0)) + 1;
    let version_id = weldsuite_kit::generate_id("fve");
    let now = instant(ctx.now_ms());
    let theme = theme_snapshot(ctx, form).await?;
    let stored = serde_json::to_value(&definition)?;
    let version = form_versions::ActiveModel {
        id: Set(version_id.clone()),
        form_id: Set(form_id.clone()),
        number: Set(i32::try_from(number).unwrap_or(i32::MAX)),
        definition: Set(stored),
        theme: Set(Some(theme)),
        published_by_user_id: Set(user_id.to_owned()),
        published_at: Set(now),
    };
    let publish = forms::Entity::update_many()
        .col_expr(forms::Column::Status, Expr::value("published"))
        .col_expr(forms::Column::PublicId, Expr::value(public_id.clone()))
        .col_expr(
            forms::Column::PublishedVersionId,
            Expr::value(version_id.clone()),
        )
        .col_expr(forms::Column::PublishedAt, Expr::value(now))
        .col_expr(forms::Column::ClosedAt, Expr::value(None::<OffsetDateTime>))
        .col_expr(forms::Column::HasUnpublishedChanges, Expr::value(false))
        .col_expr(forms::Column::UpdatedAt, Expr::value(now))
        .filter(forms::Column::Id.eq(form_id.clone()));
    atomically_with(&ctx.db, |tx| {
        Box::pin(async move {
            let db = OrmConn::new(tx);
            form_versions::Entity::insert(version)
                .exec_without_returning(&db)
                .await?;
            publish.exec(&db).await?;
            FormsResult::Ok(())
        })
    })
    .await?;
    let row = load_row(ctx, &form_id).await?;

    // The content screen holds a suspicious form for staff; it never un-holds one.
    if let Some(reason) = screen_form(text(&row, "title"), &definition) {
        form_link_registry::Entity::update_many()
            .col_expr(form_link_registry::Column::HeldAt, Expr::value(now))
            .col_expr(form_link_registry::Column::HeldReason, Expr::value(reason))
            .filter(form_link_registry::Column::PublicId.eq(&public_id))
            .exec(&orm(ctx.master()?))
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
    let now = instant(ctx.now_ms());
    forms::Entity::update_many()
        .col_expr(forms::Column::Status, Expr::value("closed"))
        .col_expr(forms::Column::ClosedAt, Expr::value(now))
        .col_expr(forms::Column::UpdatedAt, Expr::value(now))
        .filter(forms::Column::Id.eq(text(form, "id")))
        .exec(&orm(&ctx.db))
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
    forms::Entity::update_many()
        .col_expr(forms::Column::Status, Expr::value("published"))
        .col_expr(forms::Column::ClosedAt, Expr::value(None::<OffsetDateTime>))
        .col_expr(forms::Column::UpdatedAt, Expr::value(instant(ctx.now_ms())))
        .filter(forms::Column::Id.eq(text(form, "id")))
        .exec(&orm(&ctx.db))
        .await?;
    let row = load_row(ctx, text(form, "id")).await?;
    refresh_public_cache(ctx, &row).await?;
    Ok(row)
}

/// `discardChanges(ctx, form)`: the draft goes back to the published version.
pub(crate) async fn discard_changes(ctx: &Ctx, form: &Value) -> FormsResult<Value> {
    use sea_orm::ExprTrait as _;
    let Some(version_id) = opt_text(form, "publishedVersionId") else {
        return Err(forms_error(
            409,
            "NOT_PUBLISHED",
            "This form has no published version to go back to.",
        ));
    };
    let db = orm(&ctx.db);
    let definition: Option<Value> = form_versions::Entity::find()
        .select_only()
        .column(form_versions::Column::Definition)
        .filter(form_versions::Column::Id.eq(&version_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(definition) = definition else {
        return Err(not_found("Version"));
    };
    forms::Entity::update_many()
        .col_expr(
            forms::Column::Definition,
            Expr::value(parsed_definition(&definition)),
        )
        .col_expr(forms::Column::HasUnpublishedChanges, Expr::value(false))
        .col_expr(
            forms::Column::Revision,
            Expr::col(forms::Column::Revision).add(1),
        )
        .col_expr(forms::Column::UpdatedAt, Expr::value(instant(ctx.now_ms())))
        .filter(forms::Column::Id.eq(text(form, "id")))
        .exec(&db)
        .await?;
    load_row(ctx, text(form, "id")).await
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// A version as the list shows it.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionSummary {
    id: String,
    number: i32,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    published_at: OffsetDateTime,
    published_by_user_id: String,
}

/// `listVersions(ctx, formId)`: newest first, with who published each and
/// how many responses it has.
pub(crate) async fn list_versions(ctx: &Ctx, form_id: &str) -> FormsResult<Vec<Value>> {
    let db = orm(&ctx.db);
    let versions = form_versions::Entity::find()
        .select_only()
        .columns([
            form_versions::Column::Id,
            form_versions::Column::Number,
            form_versions::Column::PublishedAt,
            form_versions::Column::PublishedByUserId,
        ])
        .filter(form_versions::Column::FormId.eq(form_id))
        .order_by_desc(form_versions::Column::Number)
        .into_model::<VersionSummary>()
        .all(&db)
        .await?
        .into_iter()
        .map(row_json)
        .collect::<FormsResult<Vec<Value>>>()?;
    let counts: Vec<(String, i64)> = form_responses::Entity::find()
        .select_only()
        .column(form_responses::Column::VersionId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(form_responses::Column::FormId.eq(form_id))
        .group_by(form_responses::Column::VersionId)
        .into_tuple()
        .all(&db)
        .await?;
    let refs = member_refs(
        ctx,
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
    let row = form_versions::Entity::find_by_id(version_id)
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()?
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
