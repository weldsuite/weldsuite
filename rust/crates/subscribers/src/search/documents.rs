//! The indexable-document registry (`services/search/documents.ts` and
//! `custom-object-documents.ts`): one record of a tenant table turned into
//! the text the semantic index embeds. Only the single-record `load` is
//! here; the backfill pages belong to `POST /api/search/reindex`, which is
//! not ported.

use std::fmt::Write as _;

use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{
    companies, crm_leads, crm_opportunities, custom_field_definitions, custom_field_values,
    custom_object_records, custom_objects, helpdesk_articles, helpdesk_tickets, knowledge_pages,
    knowledge_spaces, merge_issues, merge_teams, people, projects, tasks,
};

use super::chunks::compose;
use crate::js;

/// A record as the index sees it (`IndexableDocument`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexableDocument {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub url: String,
    /// The text that is embedded; includes the title.
    pub content: String,
}

/// The entity types with a static loader, in registry order
/// (`INDEXED_ENTITY_TYPES`). WeldMerge pull requests stay out: a repository
/// backfill brings ~300 at once, and the lexical search covers them.
pub const INDEXED_ENTITY_TYPES: [&str; 10] = [
    "knowledge_page",
    "article",
    "ticket",
    "project",
    "task",
    "contact",
    "customer",
    "lead",
    "opportunity",
    "merge_issue",
];

/// `resolveIndexedType(eventEntityType)`: the search type an event indexes
/// under. `co_…` passes through; `person` and `company` alias `contact` and
/// `customer`.
pub fn resolve_indexed_type(event_entity_type: &str) -> Option<String> {
    if event_entity_type.starts_with("co_") {
        return Some(event_entity_type.to_owned());
    }
    let aliased = match event_entity_type {
        "person" => "contact",
        "company" => "customer",
        other => other,
    };
    INDEXED_ENTITY_TYPES
        .contains(&aliased)
        .then(|| aliased.to_owned())
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `buildResultUrl(type, id)` for the indexed types.
pub fn result_url(entity_type: &str, id: &str) -> String {
    let encoded = encode_uri_component(id);
    match entity_type {
        "contact" => format!("/weldcrm/people?stack=person:{encoded}"),
        "customer" => format!("/weldcrm/companies?stack=company:{encoded}"),
        "lead" => format!("/weldcrm?entity=lead:{encoded}"),
        "opportunity" => format!("/weldcrm?entity=opportunity:{encoded}"),
        "ticket" => format!("/welddesk/inbox?entity=ticket:{encoded}"),
        "article" => format!("/welddesk/help-center/articles/{id}"),
        "knowledge_page" => format!("/weldknow/page/{id}"),
        "project" => format!("/weldflow/project/{id}"),
        "task" => format!("/weldflow/task/{id}"),
        "merge_issue" => format!("/weldmerge/issues/{encoded}"),
        _ => String::new(),
    }
}

/// `a || b`: `a` unless it is null or empty.
fn or<'a>(a: Option<&'a str>, b: Option<&'a str>) -> Option<&'a str> {
    a.filter(|text| !text.is_empty()).or(b)
}

/// The display name of a person-shaped row: the full name, else first and
/// last, else the e-mail.
fn person_display(
    full: Option<&str>,
    first: Option<&str>,
    last: Option<&str>,
    email: Option<&str>,
) -> String {
    let full = full.map(js::trim).filter(|name| !name.is_empty());
    if let Some(full) = full {
        return full.to_owned();
    }
    let joined = [first, last]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let joined = js::trim(&joined);
    if !joined.is_empty() {
        return joined.to_owned();
    }
    email.unwrap_or_default().to_owned()
}

/// Title, subtitle and content of a mapped row (`toDocument`), or `None`.
type Mapped = Option<(String, Option<String>, String)>;

type Text = Option<String>;

#[allow(
    clippy::too_many_lines,
    reason = "one arm per loader, as the registry in documents.ts"
)]
async fn map_static(db: &PgPool, entity_type: &str, id: &str) -> Result<Option<Mapped>, DbErr> {
    let db = &orm(db);
    let mapped = match entity_type {
        "knowledge_page" => {
            let row = knowledge_page(db, id).await?;
            row.map(|(title, text, space)| {
                Some((
                    or(title.as_deref(), Some("Untitled"))
                        .unwrap_or_default()
                        .to_owned(),
                    space,
                    compose(&[title.as_deref(), text.as_deref()]),
                ))
            })
        }
        "article" => {
            use helpdesk_articles::Column;
            let row: Option<(Text, Text, Text, Text)> = helpdesk_articles::Entity::find()
                .select_only()
                .columns([
                    Column::Title,
                    Column::Excerpt,
                    Column::Content,
                    Column::CategoryName,
                ])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(title, excerpt, content, category)| {
                Some((
                    or(title.as_deref(), Some("Article"))
                        .unwrap_or_default()
                        .to_owned(),
                    category,
                    compose(&[title.as_deref(), excerpt.as_deref(), content.as_deref()]),
                ))
            })
        }
        "ticket" => {
            use helpdesk_tickets::Column;
            let row: Option<(Text, Text, Text, Text)> = helpdesk_tickets::Entity::find()
                .select_only()
                .columns([
                    Column::Subject,
                    Column::Description,
                    Column::TicketNumber,
                    Column::CustomerName,
                ])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(subject, description, number, customer)| {
                let title = match subject.as_deref().filter(|s| !s.is_empty()) {
                    Some(subject) => subject.to_owned(),
                    None => js::trim(&format!("Ticket {}", number.as_deref().unwrap_or_default()))
                        .to_owned(),
                };
                let subtitle = match number.as_deref().filter(|n| !n.is_empty()) {
                    Some(number) => Some(format!("#{number}")),
                    None => customer.clone(),
                };
                Some((
                    title,
                    subtitle,
                    compose(&[
                        subject.as_deref(),
                        customer.as_deref(),
                        description.as_deref(),
                    ]),
                ))
            })
        }
        "project" => {
            use projects::Column;
            let row: Option<(Text, Text, Text)> = projects::Entity::find()
                .select_only()
                .columns([Column::Name, Column::Code, Column::Description])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(name, code, description)| {
                Some((
                    or(name.as_deref(), Some("Project"))
                        .unwrap_or_default()
                        .to_owned(),
                    code.clone(),
                    compose(&[name.as_deref(), code.as_deref(), description.as_deref()]),
                ))
            })
        }
        "task" => {
            use tasks::Column;
            let row: Option<(Text, Option<i32>, Text)> = tasks::Entity::find()
                .select_only()
                .columns([Column::Title, Column::Number, Column::Description])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(title, number, description)| {
                Some((
                    or(title.as_deref(), Some("Task"))
                        .unwrap_or_default()
                        .to_owned(),
                    number.map(|n| n.to_string()),
                    compose(&[title.as_deref(), description.as_deref()]),
                ))
            })
        }
        "contact" => {
            use people::Column;
            let row: Option<(Text, Text, Text, Text, Text)> = people::Entity::find()
                .select_only()
                .columns([
                    Column::FullName,
                    Column::FirstName,
                    Column::LastName,
                    Column::Email,
                    Column::Title,
                ])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(full, first, last, email, title)| {
                let display = person_display(
                    full.as_deref(),
                    first.as_deref(),
                    last.as_deref(),
                    email.as_deref(),
                );
                (!display.is_empty()).then(|| {
                    let subtitle = or(title.as_deref(), email.as_deref())
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let content = compose(&[Some(&display), title.as_deref(), email.as_deref()]);
                    (display, subtitle, content)
                })
            })
        }
        "customer" => {
            use companies::Column;
            let row: Option<(Text, Text, Text)> = companies::Entity::find()
                .select_only()
                .columns([Column::Name, Column::TradingName, Column::Email])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(name, trading, email)| {
                let display = [name.as_deref(), trading.as_deref()]
                    .into_iter()
                    .flatten()
                    .map(js::trim)
                    .find(|n| !n.is_empty())
                    .unwrap_or_default()
                    .to_owned();
                (!display.is_empty()).then(|| {
                    let subtitle = match trading.as_deref().filter(|t| !t.is_empty()) {
                        Some(trading) if Some(trading) != name.as_deref() => {
                            Some(trading.to_owned())
                        }
                        _ => email.clone(),
                    };
                    let content = compose(&[name.as_deref(), trading.as_deref(), email.as_deref()]);
                    (display, subtitle, content)
                })
            })
        }
        "lead" => {
            use crm_leads::Column;
            let row: Option<(Text, Text, Text, Text, Text)> = crm_leads::Entity::find()
                .select_only()
                .columns([
                    Column::FullName,
                    Column::FirstName,
                    Column::LastName,
                    Column::CompanyName,
                    Column::Email,
                ])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(full, first, last, company, email)| {
                let display = person_display(
                    full.as_deref(),
                    first.as_deref(),
                    last.as_deref(),
                    email.as_deref(),
                );
                (!display.is_empty()).then(|| {
                    let subtitle = or(company.as_deref(), email.as_deref())
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let content = compose(&[Some(&display), company.as_deref(), email.as_deref()]);
                    (display, subtitle, content)
                })
            })
        }
        "opportunity" => {
            use crm_opportunities::Column;
            let row: Option<(Text, Text, Text)> = crm_opportunities::Entity::find()
                .select_only()
                .columns([Column::Name, Column::CustomerName, Column::Stage])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(db)
                .await?;
            row.map(|(name, customer, stage)| {
                let name = name.filter(|n| !n.is_empty())?;
                let subtitle = or(customer.as_deref(), stage.as_deref())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let content = compose(&[Some(&name), customer.as_deref(), stage.as_deref()]);
                Some((name, subtitle, content))
            })
        }
        "merge_issue" => {
            let row = merge_issue(db, id).await?;
            row.map(|(title, number, description, team_key)| {
                let key = format!("{team_key}-{number}");
                Some((
                    or(title.as_deref(), Some(&key))
                        .unwrap_or_default()
                        .to_owned(),
                    Some(key.clone()),
                    compose(&[Some(&key), title.as_deref(), description.as_deref()]),
                ))
            })
        }
        _ => return Ok(None),
    };
    Ok(Some(mapped.flatten()))
}

/// A knowledge page of an open team space, both live: title, text, space.
async fn knowledge_page(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<(Text, Text, Text)>, DbErr> {
    use knowledge_pages::Column as P;
    use knowledge_spaces::Column as S;
    knowledge_pages::Entity::find()
        .select_only()
        .columns([P::Title, P::ContentText])
        .column(S::Name)
        .join(
            JoinType::InnerJoin,
            knowledge_pages::Entity::belongs_to(knowledge_spaces::Entity)
                .from(P::SpaceId)
                .to(S::Id)
                .into(),
        )
        .filter(P::DeletedAt.is_null())
        .filter(S::DeletedAt.is_null())
        .filter(S::Kind.eq("team"))
        .filter(S::Visibility.eq("open"))
        .filter(P::Id.eq(id))
        .into_tuple()
        .one(db)
        .await
}

/// A merge issue, visible while neither the issue nor its team is deleted:
/// title, number, description, team key.
async fn merge_issue(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<(Text, i32, Text, String)>, DbErr> {
    use merge_issues::Column as I;
    use merge_teams::Column as T;
    merge_issues::Entity::find()
        .select_only()
        .columns([I::Title, I::Number, I::Description])
        .column(T::Key)
        .join(
            JoinType::InnerJoin,
            merge_issues::Entity::belongs_to(merge_teams::Entity)
                .from(I::TeamId)
                .to(T::Id)
                .into(),
        )
        .filter(I::DeletedAt.is_null())
        .filter(T::DeletedAt.is_null())
        .filter(I::Id.eq(id))
        .into_tuple()
        .one(db)
        .await
}

/// A loader for `entity_type`: `None` when there is none (not an indexed
/// type, or a custom object without search), else what `load` returned.
pub enum Loaded {
    NoLoader,
    Missing,
    Document(IndexableDocument),
}

/// `getDocumentLoader(type).load(db, id)`, or the custom object's loader for
/// a `co_<slug>` key (`getCustomObjectLoader`).
pub async fn load_document(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
) -> Result<Loaded, DbErr> {
    if weldsuite_events::is_custom_object_entity_key(entity_type) {
        return load_custom_object(db, entity_type, entity_id).await;
    }
    let Some(mapped) = map_static(db, entity_type, entity_id).await? else {
        return Ok(Loaded::NoLoader);
    };
    Ok(match mapped {
        Some((title, subtitle, content)) if !content.is_empty() => {
            Loaded::Document(IndexableDocument {
                entity_type: entity_type.to_owned(),
                entity_id: entity_id.to_owned(),
                url: result_url(entity_type, entity_id),
                title,
                subtitle,
                content,
            })
        }
        _ => Loaded::Missing,
    })
}

/// Field types whose values are embedded (`SEMANTIC_FIELD_TYPES`).
const SEMANTIC_FIELD_TYPES: [&str; 7] = [
    "text",
    "textarea",
    "url",
    "email",
    "phone",
    "single_select",
    "multi_select",
];

struct Definition {
    id: String,
    slug: String,
    name: String,
    field_type: String,
    sort_order: Option<i32>,
}

/// `getDefinitionsForEntityType`: the object's live field definitions, in
/// the table's order.
async fn field_definitions(
    db: &DatabaseConnection,
    entity_key: &str,
) -> Result<Vec<Definition>, DbErr> {
    use custom_field_definitions::Column;
    let rows: Vec<(String, String, String, String, Option<i32>)> =
        custom_field_definitions::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Slug,
                Column::Name,
                Column::FieldType,
                Column::SortOrder,
            ])
            .filter(Column::EntityType.eq(entity_key))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, slug, name, field_type, sort_order)| Definition {
            id,
            slug,
            name,
            field_type,
            sort_order,
        })
        .collect())
}

/// `getValuesForEntities` for one record: field id, `value_text`,
/// `value_json`.
async fn field_values(
    db: &DatabaseConnection,
    entity_key: &str,
    record_id: &str,
) -> Result<Vec<(String, Text, Option<Value>)>, DbErr> {
    use custom_field_values::Column;
    custom_field_values::Entity::find()
        .select_only()
        .columns([Column::FieldId, Column::ValueText, Column::ValueJson])
        .filter(Column::EntityType.eq(entity_key))
        .filter(Column::EntityId.is_in([record_id]))
        .into_tuple()
        .all(db)
        .await
}

async fn load_custom_object(
    db: &PgPool,
    entity_key: &str,
    entity_id: &str,
) -> Result<Loaded, DbErr> {
    let db = &orm(db);
    // `getCustomObjectByEntityKey`; a tenant without the WeldObjects tables
    // has no custom objects (`isMissingTable`).
    let object: Option<(String, String, bool)> = match custom_objects::Entity::find()
        .select_only()
        .columns([
            custom_objects::Column::Slug,
            custom_objects::Column::LabelSingular,
            custom_objects::Column::EnableSearch,
        ])
        .filter(custom_objects::Column::EntityKey.eq(entity_key))
        .filter(custom_objects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await
    {
        Ok(object) => object,
        Err(error) if weldsuite_db::is_missing_table(&error) => return Ok(Loaded::NoLoader),
        Err(error) => return Err(error),
    };
    let Some((slug, label, true)) = object else {
        return Ok(Loaded::NoLoader);
    };

    let record: Option<(String, Text)> = custom_object_records::Entity::find()
        .select_only()
        .columns([
            custom_object_records::Column::Id,
            custom_object_records::Column::Title,
        ])
        .filter(custom_object_records::Column::Id.eq(entity_id))
        .filter(custom_object_records::Column::EntityKey.eq(entity_key))
        .filter(custom_object_records::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    let Some((record_id, title)) = record else {
        return Ok(Loaded::Missing);
    };

    // `getDefinitionsForEntityType`, in the table's order, then
    // `getValuesForEntities` for the one record.
    let definitions = field_definitions(db, entity_key).await?;
    let Some(title) = title.as_deref().map(js::trim).filter(|t| !t.is_empty()) else {
        return Ok(Loaded::Missing);
    };
    let mut values: Vec<(String, Value)> = Vec::new();
    if !definitions.is_empty() {
        for (field_id, text, json) in field_values(db, entity_key, &record_id).await? {
            let Some(definition) = definitions.iter().find(|d| d.id == field_id) else {
                continue;
            };
            // `readValue`: multi_select (and file) in `value_json`; the
            // other embedded types in `value_text`.
            let value = if definition.field_type == "multi_select" {
                json.unwrap_or(Value::Null)
            } else {
                text.map_or(Value::Null, Value::String)
            };
            if let Some(slot) = values.iter_mut().find(|(slug, _)| *slug == definition.slug) {
                slot.1 = value;
            } else {
                values.push((definition.slug.clone(), value));
            }
        }
    }

    let content = render_content(&label, &definitions, title, &values);
    if content.is_empty() {
        return Ok(Loaded::Missing);
    }
    Ok(Loaded::Document(IndexableDocument {
        entity_type: entity_key.to_owned(),
        entity_id: record_id.clone(),
        title: title.to_owned(),
        subtitle: Some(label),
        url: format!("/objects/{slug}/{record_id}"),
        content,
    }))
}

/// `renderContent`: `Label: title`, then `Field: value` for each embedded
/// field by `sortOrder` (a stable sort, as `Array.prototype.sort`).
fn render_content(
    label: &str,
    definitions: &[Definition],
    title: &str,
    values: &[(String, Value)],
) -> String {
    let mut lines = vec![format!("{label}: {title}")];
    let mut ordered: Vec<&Definition> = definitions.iter().collect();
    ordered.sort_by_key(|d| d.sort_order.unwrap_or(0));
    for definition in ordered {
        if !SEMANTIC_FIELD_TYPES.contains(&definition.field_type.as_str()) {
            continue;
        }
        let Some((_, raw)) = values.iter().find(|(slug, _)| *slug == definition.slug) else {
            continue;
        };
        let value = match raw {
            Value::Null => continue,
            Value::String(text) if text.is_empty() => continue,
            Value::Array(items) => js::join(items, ", "),
            other => js::as_text(other),
        };
        if js::trim(&value).is_empty() {
            continue;
        }
        lines.push(format!("{}: {value}", definition.name));
    }
    let joined = lines.join("\n");
    let mut out = String::with_capacity(joined.len());
    let mut in_run = false;
    for c in joined.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js::trim(&out).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_types_resolve_like_typescript() {
        assert_eq!(resolve_indexed_type("person").as_deref(), Some("contact"));
        assert_eq!(resolve_indexed_type("company").as_deref(), Some("customer"));
        assert_eq!(
            resolve_indexed_type("co_machine").as_deref(),
            Some("co_machine")
        );
        assert_eq!(resolve_indexed_type("invoice"), None);
        assert_eq!(
            resolve_indexed_type("merge_issue").as_deref(),
            Some("merge_issue")
        );
        assert_eq!(resolve_indexed_type("merge_pull_request"), None);
        assert_eq!(resolve_indexed_type("merge_comment"), None);
    }

    #[test]
    fn urls_match_build_result_url() {
        assert_eq!(
            result_url("contact", "a b"),
            "/weldcrm/people?stack=person:a%20b"
        );
        assert_eq!(result_url("task", "t1"), "/weldflow/task/t1");
        assert_eq!(
            result_url("merge_issue", "mis_1"),
            "/weldmerge/issues/mis_1"
        );
    }
}
