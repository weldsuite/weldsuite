//! What the results side shares (`services/response-model.ts`): the versions
//! of a form, the column model of the responses table (merged across
//! versions by block id), the response DTO and the list conditions,
//! including the answer filters evaluated in SQL on the `answers` jsonb.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use sqlx::postgres::{PgArguments, Postgres};
use sqlx::query::QueryScalar;
use weldsuite_kit::validation::js_number_of;

use crate::common::{FormsResult, all, forms_error, iso, parse_ms, text};
use crate::engine::js::{js_trim, number_text, utf16_len};
use crate::engine::{Field, FieldKind, FormDefinition, display_answer, fields_of};

/// `FORM_LIMITS.abandonedAfterSeconds`.
pub(crate) const ABANDONED_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// `FORM_LIMITS.maxExportRows`.
pub(crate) const MAX_EXPORT_ROWS: i64 = 50_000;

/// `VersionInfo`: a version with its parsed definition and fields by id.
pub(crate) struct VersionInfo {
    pub(crate) id: String,
    pub(crate) number: i64,
    pub(crate) definition: FormDefinition,
    pub(crate) fields: Vec<Field>,
}

impl VersionInfo {
    pub(crate) fn field(&self, id: &str) -> Option<&Field> {
        self.fields.iter().find(|field| field.id == id)
    }
}

/// `loadVersions(db, formId)`: every version of a form, oldest first.
pub(crate) async fn load_versions(db: &PgPool, form_id: &str) -> FormsResult<Vec<VersionInfo>> {
    let rows = all(
        db,
        sqlx::query_scalar(
            "select to_jsonb(v) from form_versions v where form_id = $1 order by number asc",
        )
        .bind(form_id),
    )
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let definition = FormDefinition::parse(&row["definition"]).map_err(|_| {
            crate::common::Fail::Internal("forms: a version's definition does not parse".to_owned())
        })?;
        let fields = fields_of(&definition).into_iter().cloned().collect();
        out.push(VersionInfo {
            id: text(&row, "id").to_owned(),
            number: row["number"].as_i64().unwrap_or_default(),
            definition,
            fields,
        });
    }
    Ok(out)
}

/// `latestFields(versions)`: each field as the newest version that has it defines it.
pub(crate) fn latest_fields(versions: &[VersionInfo]) -> HashMap<String, Field> {
    let mut map = HashMap::new();
    for version in versions {
        for field in &version.fields {
            map.insert(field.id.clone(), field.clone());
        }
    }
    map
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/// `META_COLUMNS`: key, label, type.
const META_COLUMNS: &[(&str, &str, &str)] = &[
    ("number", "Number", "number"),
    ("submittedAt", "Submitted", "date"),
    ("status", "Status", "status"),
    ("startedAt", "Started", "date"),
    ("email", "Email", "email"),
    ("score", "Score", "score"),
    ("duration", "Time taken", "duration"),
    ("version", "Version", "number"),
    ("source", "Source", "text"),
    ("device", "Device", "text"),
    ("country", "Country", "text"),
    ("referrer", "Referrer", "text"),
];

/// The same normalising as the platform: `Submitted at` and `submitted_at` are one key.
fn normalise(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn reserved(name: &str) -> bool {
    let key = normalise(name);
    META_COLUMNS
        .iter()
        .any(|(meta, _, _)| normalise(meta) == key)
        || [
            "responsenumber",
            "no",
            "submitted",
            "started",
            "respondentemail",
            "respondent",
            "durationms",
            "timetaken",
            "versionnumber",
        ]
        .contains(&key.as_str())
}

fn part_label(part: &str) -> &str {
    match part {
        "firstName" => "First name",
        "lastName" => "Last name",
        "email" => "Email",
        "phone" => "Phone",
        "company" => "Company",
        "line1" => "Address line 1",
        "line2" => "Address line 2",
        "city" => "City",
        "state" => "State",
        "postalCode" => "Postal code",
        "country" => "Country",
        other => other,
    }
}

/// A column of the responses table and the export (`FormResponseColumn`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Column {
    pub(crate) key: String,
    pub(crate) block_id: Option<String>,
    pub(crate) part: Option<String>,
    pub(crate) label: String,
    pub(crate) kind: String,
    pub(crate) versions: Vec<i64>,
}

impl Column {
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("key".to_owned(), json!(self.key));
        if let Some(block_id) = &self.block_id {
            out.insert("blockId".to_owned(), json!(block_id));
        }
        if let Some(part) = &self.part {
            out.insert("part".to_owned(), json!(part));
        }
        out.insert("label".to_owned(), json!(self.label));
        out.insert("type".to_owned(), json!(self.kind));
        out.insert("versions".to_owned(), json!(self.versions));
        Value::Object(out)
    }
}

/// `field.title || field.ref`.
pub(crate) fn field_title(field: &Field) -> &str {
    if field.title.is_empty() {
        &field.r#ref
    } else {
        &field.title
    }
}

/// `buildColumns(versions)`: number, submitted and email first, then every
/// field of every version (a field removed later stays), the hidden fields,
/// then the rest of the metadata.
pub(crate) fn build_columns(versions: &[VersionInfo]) -> Vec<Column> {
    let mut answers: Vec<Column> = Vec::new();
    let mut hidden: Vec<(String, Vec<i64>)> = Vec::new();
    for version in versions {
        for field in &version.fields {
            let parts: Vec<Option<&'static str>> = if field.kind.is_composite() {
                field
                    .parts()
                    .into_iter()
                    .filter(|part| part.enabled)
                    .map(|part| Some(part.name))
                    .collect()
            } else {
                vec![None]
            };
            for part in parts {
                let key = part.map_or_else(|| field.id.clone(), |p| format!("{}.{p}", field.id));
                let label = part.map_or_else(
                    || field_title(field).to_owned(),
                    |p| format!("{} · {}", field_title(field), part_label(p)),
                );
                if let Some(existing) = answers.iter_mut().find(|c| c.key == key) {
                    existing.versions.push(version.number);
                    existing.label = label;
                    field.kind.type_name().clone_into(&mut existing.kind);
                } else {
                    answers.push(Column {
                        key,
                        block_id: Some(field.id.clone()),
                        part: part.map(str::to_owned),
                        label,
                        kind: field.kind.type_name().to_owned(),
                        versions: vec![version.number],
                    });
                }
            }
        }
        for field in &version.definition.hidden {
            match hidden.iter_mut().find(|(name, _)| *name == field.name) {
                Some((_, list)) => list.push(version.number),
                None => hidden.push((field.name.clone(), vec![version.number])),
            }
        }
    }
    let all: Vec<i64> = versions.iter().map(|v| v.number).collect();
    let meta = |key: &str| {
        let (_, label, kind) = META_COLUMNS
            .iter()
            .find(|(k, _, _)| *k == key)
            .copied()
            .unwrap_or((key, key, "text"));
        Column {
            key: key.to_owned(),
            block_id: None,
            part: None,
            label: label.to_owned(),
            kind: kind.to_owned(),
            versions: all.clone(),
        }
    };
    let mut out = vec![meta("number"), meta("submittedAt"), meta("email")];
    out.extend(answers);
    // A hidden field named like a metadata column would be shadowed by it in the table: it stays out.
    out.extend(
        hidden
            .into_iter()
            .filter(|(name, _)| !reserved(name))
            .map(|(name, versions)| Column {
                key: name.clone(),
                block_id: None,
                part: None,
                label: name,
                kind: "hidden".to_owned(),
                versions,
            }),
    );
    for key in [
        "score",
        "duration",
        "status",
        "startedAt",
        "version",
        "source",
        "device",
        "country",
        "referrer",
    ] {
        out.push(meta(key));
    }
    out
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// Milliseconds of a row's ISO timestamp field (`0` when missing).
pub(crate) fn ms(row: &Value, key: &str) -> i64 {
    row[key].as_str().and_then(parse_ms).unwrap_or_default()
}

/// `isAbandoned(row, now)`.
pub(crate) fn is_abandoned(row: &Value, now_ms: i64) -> bool {
    text(row, "status") == "in_progress" && now_ms - ms(row, "updatedAt") >= ABANDONED_AFTER_MS
}

/// `downloadPath(formId, responseId, fileId)`.
pub(crate) fn download_path(form_id: &str, response_id: &str, file_id: &str) -> String {
    format!("/api/forms/forms/{form_id}/responses/{response_id}/files/{file_id}")
}

/// JavaScript's truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{}` when the column is null.
fn object_or_empty(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}

/// `toResponseDto(row, { versionNumber, files, respondent, now })`.
pub(crate) fn to_response_dto(
    row: &Value,
    version_number: i64,
    files: &[Value],
    respondent: Option<Value>,
    now_ms: i64,
) -> Value {
    let m = &row["metadata"];
    let mut metadata = Map::new();
    for key in [
        "referrer", "utm", "source", "device", "browser", "os", "country",
    ] {
        if truthy(&m[key]) {
            metadata.insert(key.to_owned(), m[key].clone());
        }
    }
    let files: Vec<Value> = files
        .iter()
        .map(|f| {
            json!({
                "fileId": f["id"],
                "name": f["name"],
                "size": f["sizeBytes"],
                "type": f["contentType"],
                "blockId": f["blockId"],
                "kind": f["kind"],
                "downloadPath": download_path(text(f, "formId"), text(f, "responseId"), text(f, "id")),
            })
        })
        .collect();
    json!({
        "id": row["id"],
        "formId": row["formId"],
        "versionId": row["versionId"],
        "versionNumber": version_number,
        "number": row["number"],
        "status": row["status"],
        "answers": object_or_empty(&row["answers"]),
        "hidden": object_or_empty(&row["hidden"]),
        "variables": object_or_empty(&row["variables"]),
        "score": row["score"],
        "endingId": row["endingId"],
        "respondentEmail": row["respondentEmail"],
        "respondent": respondent.unwrap_or(Value::Null),
        "personId": row["personId"],
        "invitationId": row["invitationId"],
        "lastBlockId": row["lastBlockId"],
        "answeredCount": row["answeredCount"],
        "abandoned": is_abandoned(row, now_ms),
        "metadata": metadata,
        "files": files,
        "startedAt": row["startedAt"],
        "submittedAt": row["submittedAt"],
        "durationMs": row["durationMs"],
        "updatedAt": row["updatedAt"],
    })
}

/// `String(value)` for a JSON value.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => n.as_f64().map(number_text).unwrap_or_default(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `answerCell(field, raw, part)`: an answer as text, for the export and the
/// cells; the part of a contact or address answer when given.
pub(crate) fn answer_cell(
    field: Option<&Field>,
    raw: Option<&Value>,
    part: Option<&str>,
) -> String {
    let Some(raw) = raw.filter(|raw| !raw.is_null()) else {
        return String::new();
    };
    if let Some(part) = part {
        let value = match raw {
            Value::Object(fields) => fields.get(part),
            _ => return String::new(),
        };
        return match value {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_string(value),
        };
    }
    if let Some(field) = field {
        return display_answer(field, Some(raw));
    }
    match raw {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => js_string(raw),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/// A bound value of a built query.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Bind {
    Text(String),
    Texts(Vec<String>),
    Int(i64),
}

/// A `where` clause with its binds, numbered from `$1`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Where {
    pub(crate) parts: Vec<String>,
    pub(crate) binds: Vec<Bind>,
}

impl Where {
    /// The placeholder of a new bind.
    pub(crate) fn param(&mut self, bind: Bind) -> String {
        self.binds.push(bind);
        format!("${}", self.binds.len())
    }

    pub(crate) fn push(&mut self, part: String) {
        self.parts.push(part);
    }

    /// The conditions joined with `and`.
    pub(crate) fn sql(&self) -> String {
        if self.parts.is_empty() {
            "true".to_owned()
        } else {
            self.parts.join(" and ")
        }
    }
}

/// Binds every value of `binds` on a scalar query, in order.
pub(crate) fn bind_all<'q, O>(
    mut query: QueryScalar<'q, Postgres, O, PgArguments>,
    binds: &'q [Bind],
) -> QueryScalar<'q, Postgres, O, PgArguments> {
    for bind in binds {
        query = match bind {
            Bind::Text(text) => query.bind(text),
            Bind::Texts(texts) => query.bind(texts),
            Bind::Int(n) => query.bind(n),
        };
    }
    query
}

/// `likePattern(text)`: `%text%` with `%`, `_` and `\` escaped.
pub(crate) fn like_pattern(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `ResponseAnswerFilter`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AnswerFilter {
    pub(crate) block_id: String,
    pub(crate) part: Option<String>,
    pub(crate) operator: String,
    pub(crate) value: Option<Value>,
}

const FILTER_OPERATORS: &[&str] = &[
    "is",
    "is_not",
    "contains",
    "any_of",
    "none_of",
    "greater_than",
    "less_than",
    "is_answered",
    "is_empty",
];

#[allow(clippy::option_option, reason = "invalid, left out or set")]
fn short_text(value: Option<&Value>, max: usize) -> Option<Option<String>> {
    match value {
        None => Some(None),
        Some(Value::String(text)) if utf16_len(text) <= max => Some(Some(text.clone())),
        Some(_) => None,
    }
}

/// `responseAnswerFilterSchema.safeParse(item)`: the filter, or `None`.
pub(crate) fn read_filter(item: &Value) -> Option<AnswerFilter> {
    let fields = item.as_object()?;
    let block_id = match fields.get("blockId") {
        Some(Value::String(text)) if utf16_len(text) <= 30 => text.clone(),
        _ => return None,
    };
    let part = short_text(fields.get("part"), 30)?;
    let operator = match fields.get("operator") {
        Some(Value::String(op)) if FILTER_OPERATORS.contains(&op.as_str()) => op.clone(),
        _ => return None,
    };
    let value = match fields.get("value") {
        None => None,
        Some(Value::String(text)) if utf16_len(text) <= 500 => Some(Value::String(text.clone())),
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {
            Some(Value::Number(n.clone()))
        }
        Some(Value::Bool(flag)) => Some(Value::Bool(*flag)),
        Some(Value::Array(items))
            if items.len() <= 100
                && items
                    .iter()
                    .all(|i| i.as_str().is_some_and(|t| utf16_len(t) <= 30)) =>
        {
            Some(Value::Array(items.clone()))
        }
        Some(_) => return None,
    };
    Some(AnswerFilter {
        block_id,
        part,
        operator,
        value,
    })
}

/// `parseAnswerFilters(raw)`.
pub(crate) fn parse_answer_filters(raw: Option<&str>) -> FormsResult<Vec<AnswerFilter>> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(Vec::new());
    };
    let not_array = || forms_error(400, "BAD_REQUEST", "\"filters\" must be a JSON array.");
    let json: Value = serde_json::from_str(raw).map_err(|_| not_array())?;
    let Value::Array(items) = json else {
        return Err(not_array());
    };
    if items.len() > 20 {
        return Err(forms_error(
            400,
            "BAD_REQUEST",
            "At most 20 filters can be combined.",
        ));
    }
    items
        .iter()
        .map(|item| {
            read_filter(item)
                .ok_or_else(|| forms_error(400, "BAD_REQUEST", "A filter is not valid."))
        })
        .collect()
}

/// How a filter reads the stored value (`Kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FilterKind {
    Text,
    Numeric,
    Boolean,
    Choice,
    Presence,
}

/// `kindOf(field, part)`.
pub(crate) fn kind_of(field: Option<&Field>, part: Option<&str>) -> FilterKind {
    let Some(field) = field else {
        return FilterKind::Text;
    };
    let kind = &field.kind;
    if kind.is_composite() {
        return if part.is_some() {
            FilterKind::Text
        } else {
            FilterKind::Presence
        };
    }
    if kind.is_choice() {
        return FilterKind::Choice;
    }
    if kind.is_numeric() {
        return FilterKind::Numeric;
    }
    if kind.is_boolean() {
        return FilterKind::Boolean;
    }
    if kind.is_text() || matches!(kind, FieldKind::Date(_)) {
        return FilterKind::Text;
    }
    FilterKind::Presence
}

/// `asArray(value)`.
fn as_array(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(js_string).collect(),
        None => Vec::new(),
        Some(other) => vec![js_string(other)],
    }
}

fn not_applicable(operator: &str) -> crate::common::Fail {
    forms_error(
        400,
        "BAD_REQUEST",
        format!("Operator \"{operator}\" does not apply to this field."),
    )
}

/// `answerFilterSql(filter, fields)`: one answer filter as SQL on
/// `form_responses.answers`, its values bound on `w`.
#[allow(
    clippy::too_many_lines,
    reason = "one branch per kind of field, as the worker"
)]
pub(crate) fn answer_filter_sql(
    filter: &AnswerFilter,
    fields: &HashMap<String, Field>,
    w: &mut Where,
) -> FormsResult<String> {
    let field = fields.get(&filter.block_id);
    let kind = kind_of(field, filter.part.as_deref());
    let block = w.param(Bind::Text(filter.block_id.clone()));
    let node = format!("(answers -> {block}::text)");
    let text_expr = match &filter.part {
        Some(part) => {
            let part = w.param(Bind::Text(part.clone()));
            format!("({node} ->> {part}::text)")
        }
        None => format!("(answers ->> {block}::text)"),
    };
    let operator = filter.operator.as_str();
    let value = filter.value.as_ref();

    if operator == "is_answered" || operator == "is_empty" {
        let answered = match kind {
            FilterKind::Text => format!("({text_expr} is not null and btrim({text_expr}) <> '')"),
            FilterKind::Presence => format!(
                "({node} is not null and {node} <> 'null'::jsonb and {node} <> '[]'::jsonb and {node} <> '{{}}'::jsonb)"
            ),
            _ => format!("({node} is not null and {node} <> 'null'::jsonb)"),
        };
        return Ok(if operator == "is_answered" {
            answered
        } else {
            format!("(not {answered})")
        });
    }

    let Some(value) = value else {
        return Err(forms_error(400, "BAD_REQUEST", "A filter needs a value."));
    };

    match kind {
        FilterKind::Choice => {
            let ids = format!("({node} -> 'choiceIds')");
            let other = format!("({node} ->> 'other')");
            let list = as_array(Some(value));
            let any = |w: &mut Where| {
                let list = w.param(Bind::Texts(list.clone()));
                format!("coalesce(jsonb_exists_any({ids}, {list}::text[]), false)")
            };
            match operator {
                "any_of" | "is" => Ok(if list.is_empty() {
                    "false".to_owned()
                } else {
                    any(w)
                }),
                "none_of" | "is_not" => Ok(if list.is_empty() {
                    "true".to_owned()
                } else {
                    format!("(not {})", any(w))
                }),
                "contains" => {
                    let pattern = w.param(Bind::Text(like_pattern(&js_string(value))));
                    Ok(format!("{other} ilike {pattern}"))
                }
                _ => Err(not_applicable(operator)),
            }
        }
        FilterKind::Numeric => {
            let num = format!(
                "(case when jsonb_typeof({node}) = 'number' then (answers ->> {block}::text)::numeric end)"
            );
            let n = js_number_of(Some(value));
            if !n.is_finite() {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "A number is needed for this filter.",
                ));
            }
            let (op, fallback) = match operator {
                "is" => ("=", "false"),
                "is_not" => ("<>", "true"),
                "greater_than" => (">", "false"),
                "less_than" => ("<", "false"),
                _ => return Err(not_applicable(operator)),
            };
            let n = w.param(Bind::Text(number_text(n)));
            Ok(format!("coalesce({num} {op} {n}::numeric, {fallback})"))
        }
        FilterKind::Boolean => {
            let wanted = match value {
                Value::Bool(flag) => *flag,
                Value::String(text) => text == "true" || text == "yes",
                Value::Number(n) => n.as_f64() == Some(1.0),
                _ => false,
            };
            let literal = w.param(Bind::Text(wanted.to_string()));
            let bool_expr = format!("coalesce({node} = {literal}::jsonb, false)");
            match operator {
                "is" => Ok(bool_expr),
                "is_not" => Ok(format!("(not {bool_expr})")),
                _ => Err(not_applicable(operator)),
            }
        }
        FilterKind::Text => {
            let v = js_string(value);
            let lowered = format!("lower(btrim({text_expr}))");
            let normalised = |list: Vec<String>| -> Vec<String> {
                list.iter().map(|x| js_trim(x).to_lowercase()).collect()
            };
            match operator {
                "is" | "any_of" => {
                    let list = if operator == "is" {
                        vec![v]
                    } else {
                        as_array(Some(value))
                    };
                    if list.is_empty() {
                        return Ok("false".to_owned());
                    }
                    let list = w.param(Bind::Texts(normalised(list)));
                    Ok(format!("coalesce({lowered} = any({list}::text[]), false)"))
                }
                "is_not" | "none_of" => {
                    let list = if operator == "is_not" {
                        vec![v]
                    } else {
                        as_array(Some(value))
                    };
                    if list.is_empty() {
                        return Ok("true".to_owned());
                    }
                    let list = w.param(Bind::Texts(normalised(list)));
                    Ok(format!("coalesce({lowered} <> all({list}::text[]), true)"))
                }
                "contains" => {
                    let pattern = w.param(Bind::Text(like_pattern(&v.to_lowercase())));
                    Ok(format!(
                        "coalesce(lower({text_expr}) like {pattern}, false)"
                    ))
                }
                "greater_than" => {
                    let v = w.param(Bind::Text(v));
                    Ok(format!("coalesce({text_expr} > {v}, false)"))
                }
                "less_than" => {
                    let v = w.param(Bind::Text(v));
                    Ok(format!("coalesce({text_expr} < {v}, false)"))
                }
                _ => Err(not_applicable(operator)),
            }
        }
        FilterKind::Presence => Err(forms_error(
            400,
            "BAD_REQUEST",
            "This field can only be filtered on whether it was answered.",
        )),
    }
}

/// `ResponseFilterQuery`: what narrows a list, an export or a summary.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResponseFilter {
    pub(crate) status: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) q: Option<String>,
    pub(crate) version_id: Option<String>,
    pub(crate) person_id: Option<String>,
    pub(crate) invitation_id: Option<String>,
    pub(crate) filters: Option<String>,
}

const WHEN: &str = "coalesce(submitted_at, started_at)";

/// `responseConditions(formId, query, fields)`: the form, the status,
/// dates, search, version, person, invitation and answer filters.
pub(crate) fn response_conditions(
    form_id: &str,
    query: &ResponseFilter,
    fields: &HashMap<String, Field>,
) -> FormsResult<Where> {
    let mut w = Where::default();
    let form = w.param(Bind::Text(form_id.to_owned()));
    w.push(format!("form_id = {form}"));
    if let Some(status) = query.status.as_deref().filter(|s| *s != "all") {
        let status = w.param(Bind::Text(status.to_owned()));
        w.push(format!("status = {status}"));
    }
    if let Some(from) = query.from.as_deref() {
        let at = w.param(Bind::Text(iso(parse_ms(from).unwrap_or_default())));
        w.push(format!("{WHEN} >= {at}::timestamptz"));
    }
    if let Some(to) = query.to.as_deref() {
        let at = w.param(Bind::Text(iso(parse_ms(to).unwrap_or_default())));
        w.push(format!("{WHEN} <= {at}::timestamptz"));
    }
    if let Some(q) = query.q.as_deref().map(js_trim).filter(|q| !q.is_empty()) {
        let like = like_pattern(&q.to_lowercase());
        let a = w.param(Bind::Text(like.clone()));
        let b = w.param(Bind::Text(like));
        w.push(format!(
            "(search_text ilike {a} or respondent_email ilike {b})"
        ));
    }
    for (column, value) in [
        ("version_id", &query.version_id),
        ("person_id", &query.person_id),
        ("invitation_id", &query.invitation_id),
    ] {
        if let Some(value) = value {
            let value = w.param(Bind::Text(value.clone()));
            w.push(format!("{column} = {value}"));
        }
    }
    for filter in parse_answer_filters(query.filters.as_deref())? {
        let sql = answer_filter_sql(&filter, fields, &mut w)?;
        w.push(sql);
    }
    Ok(w)
}

/// `responseOrder(sort)`.
pub(crate) fn response_order(sort: Option<&str>) -> String {
    match sort {
        Some("oldest") => format!("{WHEN} asc, id asc"),
        Some("score_desc") => format!("score desc nulls last, {WHEN} desc, id desc"),
        Some("score_asc") => format!("score asc nulls last, {WHEN} desc, id desc"),
        _ => format!("{WHEN} desc, id desc"),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn def(blocks: &Value) -> FormDefinition {
        FormDefinition::parse(&json!({
            "blocks": blocks,
            "hidden": [{ "name": "utm_source" }, { "name": "status" }],
            "endings": [{ "id": "e_done", "ref": "thanks", "title": "Thanks" }],
        }))
        .unwrap()
    }

    fn version(number: i64, definition: FormDefinition) -> VersionInfo {
        let fields = fields_of(&definition).into_iter().cloned().collect();
        VersionInfo {
            id: format!("fve_{number}"),
            number,
            definition,
            fields,
        }
    }

    #[test]
    fn columns_merge_versions_and_skip_shadowed_hidden_fields() {
        let v1 = version(
            1,
            def(
                &json!([{ "id": "b_name", "ref": "name", "type": "short_text", "title": "Your name", "properties": {} }]),
            ),
        );
        let v2 = version(
            2,
            def(&json!([
                { "id": "b_name", "ref": "name", "type": "short_text", "title": "Full name", "properties": {} },
                { "id": "b_c", "ref": "contact", "type": "contact_info", "title": "Contact", "properties": { "fields": { "phone": { "enabled": false, "required": false } } } }
            ])),
        );
        let columns = build_columns(&[v1, v2]);
        let keys: Vec<&str> = columns.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(&keys[..3], ["number", "submittedAt", "email"]);
        let name = columns.iter().find(|c| c.key == "b_name").unwrap();
        assert_eq!(
            (name.label.as_str(), name.versions.clone()),
            ("Full name", vec![1, 2])
        );
        assert!(keys.contains(&"b_c.email") && !keys.contains(&"b_c.phone"));
        assert_eq!(keys.iter().filter(|k| **k == "status").count(), 1);
        assert_eq!(
            columns
                .iter()
                .find(|c| c.key == "b_c.firstName")
                .unwrap()
                .label,
            "Contact · First name"
        );
    }

    #[test]
    fn filters_read_like_the_schema() {
        assert!(
            read_filter(&json!({ "blockId": "b", "operator": "is", "value": ["a"] })).is_some()
        );
        assert!(read_filter(&json!({ "blockId": "b", "operator": "bogus" })).is_none());
        assert!(read_filter(&json!({ "blockId": "b", "operator": "is", "value": null })).is_none());
        assert!(read_filter(&json!({ "blockId": "b", "operator": "is", "value": [1] })).is_none());
        assert!(parse_answer_filters(Some("nope")).is_err());
        assert!(parse_answer_filters(Some("{}")).is_err());
        assert_eq!(parse_answer_filters(Some("[]")).unwrap(), vec![]);
        assert_eq!(like_pattern("a_b%"), "%a\\_b\\%%");
    }

    #[test]
    fn filter_kinds_follow_the_field_type() {
        let d = def(&json!([
            { "id": "b_t", "ref": "t", "type": "short_text", "title": "T", "properties": {} },
            { "id": "b_n", "ref": "n", "type": "rating", "title": "N", "properties": { "steps": 5 } },
            { "id": "b_c", "ref": "c", "type": "contact_info", "title": "C", "properties": {} },
            { "id": "b_r", "ref": "r", "type": "ranking", "title": "R", "properties": { "choices": [{ "id": "r_a", "label": "A" }, { "id": "r_b", "label": "B" }] } }
        ]));
        let field = |id: &str| fields_of(&d).into_iter().find(|f| f.id == id).cloned();
        assert_eq!(kind_of(field("b_t").as_ref(), None), FilterKind::Text);
        assert_eq!(kind_of(field("b_n").as_ref(), None), FilterKind::Numeric);
        assert_eq!(kind_of(field("b_c").as_ref(), None), FilterKind::Presence);
        assert_eq!(
            kind_of(field("b_c").as_ref(), Some("email")),
            FilterKind::Text
        );
        assert_eq!(kind_of(field("b_r").as_ref(), None), FilterKind::Presence);
        assert_eq!(kind_of(None, None), FilterKind::Text);
        assert_eq!(js_string(&json!(["a", "b"])), "a,b");
        assert_eq!(answer_cell(None, Some(&json!({ "x": 1 })), Some("x")), "1");
    }
}
