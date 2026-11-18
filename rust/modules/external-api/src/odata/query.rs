//! Query options of the feed (`routes/v1/odata/query.ts`): parsing (`$top`,
//! `$skip`, `$skiptoken`, `$select`, `$orderby`, `$filter`, `$count`,
//! `$format`), the SELECT built from them, and paging.
//!
//! Paging: with no `$orderby` rows come in key order and the skiptoken is a
//! keyset position (`key > last`); with `$orderby` the key is appended as the
//! tie-breaker and the skiptoken is an offset. A token is base64url JSON,
//! `{"k":"<last key>"}` or `{"o":<offset>}`, and is only ours to read.
//!
//! A row is read as one JSON text, `[key, [values…], …]`
//! (`json_build_array`, which keeps each value as PostgreSQL prints it): the
//! values in the order of the properties asked for, in groups, as a function
//! call takes at most 100 arguments. The worker reads one column per
//! property; the values are the same.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::StatusCode;
use weldsuite_core_domain::js::{Js, js_string};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{js_number, js_trim};

use super::catalog::{EdmType, EntitySet, Property, catalog, is_plain_column};
use super::error::ODataError;
use super::filter::{Node, parse_filter};
use super::sql::{Param, Statement, push_filter};
use crate::auth::atob;

pub(crate) const MAX_ORDERBY_TERMS: usize = 5;

/// Values per `json_build_array` call (PostgreSQL allows 100 arguments).
const ROW_GROUP: usize = 90;

/// `MAX_SKIP_OFFSET`: the largest offset a skiptoken may carry. The page's
/// `OFFSET` is cast to `int` (2^31 - 1).
const MAX_SKIP_OFFSET: f64 = 2_147_483_647.0;

/// `OrderTerm`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct OrderTerm<'a> {
    pub(crate) prop: &'a Property,
    pub(crate) desc: bool,
}

/// `SkipToken`: the last key served, or the offset to go on from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SkipToken {
    Key(String),
    Offset(i64),
}

/// `QueryOptions`.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct QueryOptions<'a> {
    pub(crate) top: Option<i64>,
    pub(crate) skip: Option<i64>,
    pub(crate) skiptoken: Option<SkipToken>,
    /// `None`: every property.
    pub(crate) select: Option<Vec<&'a Property>>,
    pub(crate) orderby: Vec<OrderTerm<'a>>,
    pub(crate) filter: Option<Node<'a>>,
    pub(crate) count: bool,
}

/// Options that are valid `OData` but not served.
const UNSUPPORTED: [&str; 7] = [
    "$expand",
    "$apply",
    "$search",
    "$compute",
    "$levels",
    "$deltatoken",
    "$schemaversion",
];
const KNOWN: [&str; 8] = [
    "$top",
    "$skip",
    "$skiptoken",
    "$select",
    "$orderby",
    "$filter",
    "$count",
    "$format",
];

/// `Surface`: what the options are asked of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Surface {
    Collection,
    Count,
    Entity,
}

impl Surface {
    /// `ALLOWED[surface]`.
    fn allows(self, name: &str) -> bool {
        match self {
            Self::Collection => KNOWN.contains(&name),
            Self::Count => matches!(name, "$filter" | "$format"),
            Self::Entity => matches!(name, "$select" | "$format"),
        }
    }
}

fn bad_request(message: impl Into<String>) -> ODataError {
    ODataError::bad_request(message)
}

/// `nonNegativeInt(name, raw)`: `/^\d{1,9}$/`.
fn non_negative_int(name: &str, raw: &str) -> Result<i64, ODataError> {
    if raw.is_empty() || raw.len() > 9 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad_request(format!(
            "{name} must be a non-negative integer"
        )));
    }
    raw.parse()
        .map_err(|_| bad_request(format!("{name} must be a non-negative integer")))
}

/// `encodeSkipToken(token)`.
pub(crate) fn encode_skip_token(token: &SkipToken) -> String {
    let json = match token {
        SkipToken::Key(key) => format!(
            "{{\"k\":{}}}",
            serde_json::to_string(key).unwrap_or_default()
        ),
        SkipToken::Offset(offset) => format!("{{\"o\":{offset}}}"),
    };
    URL_SAFE_NO_PAD.encode(json)
}

/// The `\uXXXX` escape at `at`, as its UTF-16 unit.
fn unicode_escape(text: &str, at: usize) -> Option<u32> {
    let hex = text.get(at..at + 6)?.strip_prefix("\\u")?;
    if hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        u32::from_str_radix(hex, 16).ok()
    } else {
        None
    }
}

/// A JSON text with each `\uXXXX` escape that is half a surrogate pair
/// written as the escape of U+FFFD. `JSON.parse` keeps such a half in its string, and it
/// becomes U+FFFD on its way to the database; `serde_json` refuses the text.
fn without_unpaired_surrogates(text: &str) -> std::borrow::Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut out = String::new();
    // Every cut is at a backslash or after an escape's ASCII: between characters.
    let (mut copied, mut at) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(unit) = unicode_escape(text, at) else {
            // Another escape (`\\`, `\"`, …): its character is not a new escape.
            at += 2;
            continue;
        };
        let paired = (0xd800..0xdc00).contains(&unit)
            && unicode_escape(text, at + 6).is_some_and(|low| (0xdc00..0xe000).contains(&low));
        if paired {
            at += 12;
        } else {
            if (0xd800..0xe000).contains(&unit) {
                out.push_str(&text[copied..at]);
                out.push_str("\\ufffd");
                copied = at + 6;
            }
            at += 6;
        }
    }
    if copied == 0 {
        return std::borrow::Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    std::borrow::Cow::Owned(out)
}

/// `decodeSkipToken(raw)`: `{ k: string }` with no `o`, or `{ o: a whole
/// number from 0 to MAX_SKIP_OFFSET }` with no `k`; anything else is not
/// ours. A key with a NUL character is refused too: Postgres takes none in a
/// text parameter.
pub(crate) fn decode_skip_token(raw: &str) -> Result<SkipToken, ODataError> {
    let invalid = || bad_request("Invalid $skiptoken");
    let bytes = atob(&raw.replace('-', "+").replace('_', "/")).ok_or_else(invalid)?;
    // `new TextDecoder().decode(bytes)`: lossy, and a byte order mark is dropped.
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let Ok(Js::Object(entries)) = serde_json::from_str::<Js>(&without_unpaired_surrogates(text))
    else {
        return Err(invalid());
    };
    // `JSON.parse` keeps the last of a repeated key.
    let member = |name: &str| {
        entries
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    };
    match (member("k"), member("o")) {
        (Some(Js::String(key)), None) if !key.contains('\0') => Ok(SkipToken::Key(key.clone())),
        #[allow(clippy::cast_possible_truncation)]
        (None, Some(Js::Number(offset)))
            if offset.fract() == 0.0 && (0.0..=MAX_SKIP_OFFSET).contains(offset) =>
        {
            Ok(SkipToken::Offset(*offset as i64))
        }
        _ => Err(invalid()),
    }
}

/// `parseSelect(raw, set)`.
fn parse_select<'a>(
    raw: &str,
    set: &'a EntitySet,
) -> Result<Option<Vec<&'a Property>>, ODataError> {
    let names: Vec<&str> = raw.split(',').map(js_trim).collect();
    if names.iter().any(|name| name.is_empty()) {
        return Err(bad_request("$select has an empty item"));
    }
    if names.contains(&"*") {
        return Ok(None);
    }
    for name in &names {
        if name.contains(['/', '.']) {
            return Err(ODataError::not_implemented(format!(
                "$select paths are not supported ('{name}')"
            )));
        }
        if set.property(name).is_none() {
            return Err(bad_request(format!("Unknown property '{name}' in $select")));
        }
    }
    Ok(Some(
        set.properties
            .iter()
            .filter(|prop| names.contains(&prop.name.as_str()))
            .collect(),
    ))
}

/// JavaScript's `\s`.
fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?$/`: the name and whether it
/// sorts descending.
fn order_term(term: &str) -> Option<(&str, bool)> {
    let length = term
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    let (name, rest) = term.split_at(length);
    if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    if rest.is_empty() {
        return Some((name, false));
    }
    let direction = rest.trim_start_matches(is_js_space);
    if direction.len() == rest.len() {
        return None;
    }
    match direction {
        "asc" => Some((name, false)),
        "desc" => Some((name, true)),
        _ => None,
    }
}

/// `parseOrderBy(raw, set)`.
fn parse_order_by<'a>(raw: &str, set: &'a EntitySet) -> Result<Vec<OrderTerm<'a>>, ODataError> {
    let terms: Vec<&str> = raw.split(',').map(js_trim).collect();
    if terms.len() > MAX_ORDERBY_TERMS {
        return Err(bad_request(format!(
            "$orderby has more than {MAX_ORDERBY_TERMS} terms"
        )));
    }
    terms
        .into_iter()
        .map(|term| {
            let Some((name, desc)) = order_term(term) else {
                if term.contains(['/', '(']) {
                    return Err(ODataError::not_implemented(
                        "$orderby supports property names only",
                    ));
                }
                return Err(bad_request(format!("Invalid $orderby term '{term}'")));
            };
            let Some(prop) = set.property(name) else {
                return Err(bad_request(format!(
                    "Unknown property '{name}' in $orderby"
                )));
            };
            if !prop.sortable {
                return Err(bad_request(format!(
                    "Property '{}' cannot be used in $orderby",
                    prop.name
                )));
            }
            Ok(OrderTerm { prop, desc })
        })
        .collect()
}

/// `/^(json|application\/json)(;.*)?$/i` on the trimmed value.
fn is_json_format(format: &str) -> bool {
    let format = js_trim(format);
    let after = |prefix: &str| {
        format
            .get(..prefix.len())
            .filter(|head| head.eq_ignore_ascii_case(prefix))
            .map(|_| &format[prefix.len()..])
    };
    // `.` stops at a line terminator.
    let parameters = |rest: &str| {
        rest.is_empty()
            || (rest.starts_with(';') && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
    };
    after("json").is_some_and(parameters) || after("application/json").is_some_and(parameters)
}

/// `parseQueryOptions(params, set, surface)`: the request's query string
/// (decoded, in order) as options.
pub(crate) fn parse_query_options<'a>(
    params: &[(String, String)],
    set: &'a EntitySet,
    surface: Surface,
) -> Result<QueryOptions<'a>, ODataError> {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    for (name, value) in params {
        // Custom query options are ignored, as OData allows.
        if !name.starts_with('$') {
            continue;
        }
        if UNSUPPORTED.contains(&name.to_lowercase().as_str()) {
            return Err(ODataError::not_implemented(format!(
                "{name} is not supported"
            )));
        }
        if !KNOWN.contains(&name.as_str()) {
            return Err(bad_request(format!("Unknown query option '{name}'")));
        }
        if seen.iter().any(|(given, _)| given == name) {
            return Err(bad_request(format!("{name} is given more than once")));
        }
        if !surface.allows(name) {
            return Err(bad_request(format!("{name} is not allowed here")));
        }
        seen.push((name, value));
    }
    let option = |name: &str| {
        seen.iter()
            .find(|(given, _)| *given == name)
            .map(|(_, value)| *value)
    };

    if let Some(format) = option("$format")
        && !is_json_format(format)
    {
        return Err(ODataError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("$format={format} is not supported, only json"),
        ));
    }

    let mut options = QueryOptions::default();
    if let Some(top) = option("$top") {
        options.top = Some(non_negative_int("$top", top)?);
    }
    if let Some(skip) = option("$skip") {
        options.skip = Some(non_negative_int("$skip", skip)?);
    }
    if let Some(token) = option("$skiptoken") {
        options.skiptoken = Some(decode_skip_token(token)?);
    }
    if let Some(select) = option("$select") {
        options.select = parse_select(select, set)?;
    }
    if let Some(orderby) = option("$orderby") {
        options.orderby = parse_order_by(orderby, set)?;
    }
    if let Some(filter) = option("$filter") {
        options.filter = Some(parse_filter(filter, set)?);
    }
    if let Some(count) = option("$count") {
        options.count = match count {
            "true" => true,
            "false" => false,
            _ => return Err(bad_request("$count must be true or false")),
        };
    }

    if let Some(token) = &options.skiptoken {
        let keyset = matches!(token, SkipToken::Key(_));
        if keyset != options.orderby.is_empty() {
            return Err(bad_request("This $skiptoken does not belong to this query"));
        }
    }
    Ok(options)
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/// What can go wrong while reading rows.
#[derive(Debug)]
pub(crate) enum ReadError {
    Database(sqlx::Error),
    /// A row or a catalogue entry that cannot be: answered as a 500.
    Unreadable,
}

impl From<sqlx::Error> for ReadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `selectItem(set, prop)`, without its alias: the value as it is served.
fn push_value(out: &mut Statement, set: &EntitySet, prop: &Property) {
    match prop.edm {
        EdmType::DateTimeOffset => {
            out.push("to_char(");
            out.column(set, prop);
            out.push(", 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')");
        }
        EdmType::StringCollection => {
            out.push("COALESCE(");
            out.column(set, prop);
            out.push(", '[]'::jsonb)::text");
        }
        EdmType::Int64 => {
            out.column(set, prop);
            out.push("::text");
        }
        EdmType::Double => {
            out.column(set, prop);
            out.push("::float8");
        }
        EdmType::String | EdmType::Int32 | EdmType::Boolean => out.column(set, prop),
    }
}

/// `SELECT <the row as JSON text> FROM <table>`: the key (always read, for
/// the position; not served unless selected), then the properties in groups.
fn push_select(out: &mut Statement, set: &EntitySet, key: &Property, properties: &[&Property]) {
    out.push("SELECT json_build_array(");
    out.column(set, key);
    for group in properties.chunks(ROW_GROUP) {
        out.push(", json_build_array(");
        for (index, prop) in group.iter().enumerate() {
            if index > 0 {
                out.push(", ");
            }
            push_value(out, set, prop);
        }
        out.push(")");
    }
    out.push(")::text FROM ");
    out.table(set);
}

/// `whereOf(set, conditions)`: ` WHERE` before the first condition, ` AND`
/// before the others.
#[derive(Default)]
struct Conditions {
    any: bool,
}

impl Conditions {
    fn next(&mut self, out: &mut Statement) {
        out.push(if self.any { " AND " } else { " WHERE " });
        self.any = true;
    }

    /// The soft-delete rule and the filter, which every statement of a set
    /// starts with.
    fn of(out: &mut Statement, set: &EntitySet, filter: Option<&Node<'_>>) -> Self {
        let mut conditions = Self::default();
        // A rule that is not a plain column is left out, as the worker does.
        if set.soft_delete.as_deref().is_some_and(is_plain_column) {
            conditions.next(out);
            out.soft_delete(set);
        }
        if let Some(filter) = filter {
            conditions.next(out);
            push_filter(out, filter, set);
        }
        conditions
    }
}

/// `toJsonValue(prop, raw)`: a database value as the JSON value of its type.
fn to_json_value(prop: &Property, raw: Js) -> Result<Js, ReadError> {
    if raw == Js::Null {
        return Ok(if prop.edm == EdmType::StringCollection {
            Js::Array(Vec::new())
        } else {
            Js::Null
        });
    }
    Ok(match prop.edm {
        EdmType::StringCollection => match raw {
            Js::String(text) => serde_json::from_str(&text).map_err(|_| ReadError::Unreadable)?,
            other => other,
        },
        EdmType::Int32 | EdmType::Int64 | EdmType::Double => match raw {
            Js::Number(_) => raw,
            // `Number(raw)`.
            Js::String(text) => Js::Number(js_number(&text)),
            Js::Bool(flag) => Js::Number(f64::from(u8::from(flag))),
            _ => Js::Number(f64::NAN),
        },
        EdmType::Boolean => Js::Bool(match raw {
            Js::Bool(flag) => flag,
            Js::String(text) => text == "t" || text == "true",
            _ => false,
        }),
        EdmType::String | EdmType::DateTimeOffset => raw,
    })
}

/// A row as `[key, entity]`: `toEntity(properties, row)` and its `__key`.
fn read_row(text: &str, properties: &[&Property]) -> Result<(Js, Js), ReadError> {
    let Ok(Js::Array(parts)) = serde_json::from_str::<Js>(text) else {
        return Err(ReadError::Unreadable);
    };
    let mut parts = parts.into_iter();
    let key = parts.next().ok_or(ReadError::Unreadable)?;
    let mut values = Vec::with_capacity(properties.len());
    for group in parts {
        let Js::Array(group) = group else {
            return Err(ReadError::Unreadable);
        };
        values.extend(group);
    }
    if values.len() != properties.len() {
        return Err(ReadError::Unreadable);
    }
    let entity = properties
        .iter()
        .zip(values)
        .map(|(prop, raw)| Ok((prop.name.clone(), to_json_value(prop, raw)?)))
        .collect::<Result<Vec<_>, ReadError>>()?;
    Ok((key, Js::Object(entity)))
}

/// `PageResult`.
#[derive(Debug)]
pub(crate) struct Page {
    pub(crate) rows: Vec<Js>,
    /// Position after the last row served, when there is more.
    pub(crate) next: Option<SkipToken>,
    /// `top` left to serve after this page (only when `$top` was given).
    pub(crate) remaining_top: Option<i64>,
    /// Rows matching the filter (only when `$count=true`).
    pub(crate) total: Option<i64>,
}

/// What `fetchPage` asks the database: the page's statement, the rows wanted
/// and the offset it starts at.
pub(crate) struct PagePlan {
    pub(crate) statement: Statement,
    pub(crate) wanted: i64,
    pub(crate) base_offset: i64,
}

/// The page statement of `fetchPage`.
pub(crate) fn page_plan(
    set: &EntitySet,
    options: &QueryOptions<'_>,
    properties: &[&Property],
) -> Result<PagePlan, ReadError> {
    let key = set.key_property().ok_or(ReadError::Unreadable)?;
    let page_size = catalog().page_size;
    let token = options.skiptoken.as_ref();

    let mut out = Statement::default();
    push_select(&mut out, set, key, properties);
    let mut conditions = Conditions::of(&mut out, set, options.filter.as_ref());
    if let Some(SkipToken::Key(last)) = token {
        conditions.next(&mut out);
        out.column(set, key);
        out.push(" > ");
        out.bind(Param::Text(last.clone()), "text");
    }

    out.push(" ORDER BY ");
    for (index, term) in options.orderby.iter().enumerate() {
        if index > 0 {
            out.push(", ");
        }
        out.column(set, term.prop);
        out.push(if term.desc {
            " DESC NULLS LAST"
        } else {
            " ASC NULLS FIRST"
        });
    }
    if !options.orderby.iter().any(|term| term.prop.name == set.key) {
        if !options.orderby.is_empty() {
            out.push(", ");
        }
        out.column(set, key);
        out.push(" ASC");
    }

    // A skiptoken is the position; `$skip` only applies to the first page.
    let base_offset = match token {
        Some(SkipToken::Offset(offset)) => *offset,
        Some(SkipToken::Key(_)) => 0,
        None => options.skip.unwrap_or(0),
    };
    let wanted = options.top.unwrap_or(page_size).min(page_size);
    // One row more than we serve tells whether to link on, unless `$top`
    // ends inside this page.
    let probe = i64::from(options.top.is_none_or(|top| top > page_size));
    out.push(" LIMIT ");
    out.bind(
        Param::Int(i32::try_from(wanted + probe).unwrap_or(i32::MAX)),
        "int",
    );
    out.push(" OFFSET ");
    out.bind(Param::BigInt(base_offset), "int");
    Ok(PagePlan {
        statement: out,
        wanted,
        base_offset,
    })
}

/// `SELECT count(*) FROM <table> WHERE …`: the rows the filter matches.
pub(crate) fn count_statement(set: &EntitySet, filter: Option<&Node<'_>>) -> Statement {
    let mut out = Statement::default();
    out.push("SELECT count(*) FROM ");
    out.table(set);
    Conditions::of(&mut out, set, filter);
    out
}

/// The statement of `fetchEntity`.
pub(crate) fn entity_statement(
    set: &EntitySet,
    key_value: &str,
    properties: &[&Property],
) -> Result<Statement, ReadError> {
    let key = set.key_property().ok_or(ReadError::Unreadable)?;
    let mut out = Statement::default();
    push_select(&mut out, set, key, properties);
    Conditions::of(&mut out, set, None).next(&mut out);
    out.column(set, key);
    out.push(" = ");
    out.bind(Param::Text(key_value.to_owned()), "text");
    out.push(" LIMIT 1");
    Ok(out)
}

/// The properties a request serves: its `$select`, else all of them.
fn served_properties<'a>(set: &'a EntitySet, select: Option<&[&'a Property]>) -> Vec<&'a Property> {
    select.map_or_else(|| set.properties.iter().collect(), <[_]>::to_vec)
}

/// `fetchPage(db, set, options)`: the page the options ask for.
pub(crate) async fn fetch_page(
    db: &PgPool,
    set: &EntitySet,
    options: &QueryOptions<'_>,
) -> Result<Page, ReadError> {
    let properties = served_properties(set, options.select.as_deref());
    let PagePlan {
        statement,
        wanted,
        base_offset,
    } = page_plan(set, options, &properties)?;

    let fetched = if wanted == 0 {
        Vec::new()
    } else {
        statement.texts(db).await?
    };
    let total = if options.count {
        Some(
            count_statement(set, options.filter.as_ref())
                .count(db)
                .await?,
        )
    } else {
        None
    };

    let wanted = usize::try_from(wanted).unwrap_or(usize::MAX);
    let more = fetched.len() > wanted;
    let mut rows = Vec::with_capacity(fetched.len().min(wanted));
    let mut last_key = None;
    for text in fetched.iter().take(wanted) {
        let (key, entity) = read_row(text, &properties)?;
        last_key = Some(key);
        rows.push(entity);
    }
    let served = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let next = match last_key {
        Some(key) if more => Some(if options.orderby.is_empty() {
            // `String(last.__key)`.
            SkipToken::Key(js_string(&key))
        } else {
            SkipToken::Offset(base_offset + served)
        }),
        _ => None,
    };
    Ok(Page {
        rows,
        next,
        remaining_top: options.top.map(|top| (top - served).max(0)),
        total,
    })
}

/// `countRows(db, set, filter)`: `/$count`.
pub(crate) async fn count_rows(
    db: &PgPool,
    set: &EntitySet,
    filter: Option<&Node<'_>>,
) -> Result<i64, ReadError> {
    Ok(count_statement(set, filter).count(db).await?)
}

/// `fetchEntity(db, set, key, select)`: one entity by key, or `None`.
pub(crate) async fn fetch_entity(
    db: &PgPool,
    set: &EntitySet,
    key: &str,
    select: Option<&[&Property]>,
) -> Result<Option<Js>, ReadError> {
    let properties = served_properties(set, select);
    let row = entity_statement(set, key, &properties)?.text(db).await?;
    row.map(|text| read_row(&text, &properties).map(|(_, entity)| entity))
        .transpose()
}

#[cfg(test)]
mod tests {
    use weldsuite_core_domain::js::stringify;

    use super::super::catalog::find_entity_set;
    use super::super::sql::testing::assert_only_catalogue_text;
    use super::*;

    fn set(name: &str) -> &'static EntitySet {
        find_entity_set(name).expect("the set")
    }

    fn pairs(options: &[(&str, &str)]) -> Vec<(String, String)> {
        options
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn options(
        name: &str,
        given: &[(&str, &str)],
        surface: Surface,
    ) -> Result<QueryOptions<'static>, ODataError> {
        parse_query_options(&pairs(given), set(name), surface)
    }

    fn collection(given: &[(&str, &str)]) -> QueryOptions<'static> {
        match options("Conversations", given, Surface::Collection) {
            Ok(options) => options,
            Err(error) => panic!("{given:?}: {}", error.message),
        }
    }

    /// The refusal of a collection request: its status and message.
    fn refused(given: &[(&str, &str)]) -> (u16, String) {
        match options("Conversations", given, Surface::Collection) {
            Ok(_) => panic!("expected {given:?} to be refused"),
            Err(error) => (error.status.as_u16(), error.message),
        }
    }

    fn plan(given: &[(&str, &str)]) -> PagePlan {
        let options = collection(given);
        let conversations = set("Conversations");
        let properties = served_properties(conversations, options.select.as_deref());
        page_plan(conversations, &options, &properties).expect("a plan")
    }

    #[test]
    fn skip_tokens_round_trip_as_base64url_json() {
        let key = SkipToken::Key("msg_01000".to_owned());
        assert_eq!(encode_skip_token(&key), "eyJrIjoibXNnXzAxMDAwIn0");
        assert_eq!(decode_skip_token("eyJrIjoibXNnXzAxMDAwIn0"), Ok(key));
        let offset = SkipToken::Offset(2000);
        assert_eq!(encode_skip_token(&offset), "eyJvIjoyMDAwfQ");
        assert_eq!(decode_skip_token("eyJvIjoyMDAwfQ"), Ok(offset));
        // A key is JSON-escaped, and the alphabet is the URL-safe one.
        let odd = SkipToken::Key("a\"b\\c?>~é".to_owned());
        let encoded = encode_skip_token(&odd);
        assert!(!encoded.contains(['+', '/', '=']));
        assert_eq!(decode_skip_token(&encoded), Ok(odd));
        // Padding and the standard alphabet are read too, as `atob` does.
        assert_eq!(decode_skip_token("eyJvIjo1fQ=="), Ok(SkipToken::Offset(5)));
    }

    #[test]
    fn a_token_that_is_not_ours_is_refused() {
        let encode = |json: &str| URL_SAFE_NO_PAD.encode(json);
        for json in [
            "{\"x\":1}",
            "{\"o\":-1}",
            "{\"o\":1.5}",
            "{\"o\":\"5\"}",
            "{\"o\":9007199254740992}",
            // More than `OFFSET … ::int` takes.
            "{\"o\":2147483648}",
            "{\"o\":123456789012}",
            "{\"o\":1e10}",
            "{\"o\":null}",
            "{\"o\":true}",
            "{\"k\":5}",
            "{\"k\":null}",
            "{\"k\":[\"a\"]}",
            // A NUL in the key: Postgres refuses it in a text parameter.
            "{\"k\":\"a\\u0000b\"}",
            "{\"k\":\"\\u0000\"}",
            "{\"k\":\"a\",\"o\":1}",
            "{\"k\":\"a\",\"o\":null}",
            "[1]",
            "null",
            "\"k\"",
            "{",
            "",
        ] {
            assert_eq!(
                decode_skip_token(&encode(json)).map_err(|error| error.message),
                Err("Invalid $skiptoken".to_owned()),
                "{json}"
            );
        }
        assert!(decode_skip_token("garbage!!").is_err());
        assert!(decode_skip_token("a").is_err());
        // The largest offset is a position still.
        assert_eq!(
            decode_skip_token(&encode("{\"o\":2147483647}")),
            Ok(SkipToken::Offset(2_147_483_647))
        );
        // Other members are ignored, and the last of a repeated key counts.
        assert_eq!(
            decode_skip_token(&encode("{\"k\":\"a\",\"z\":[1]}")),
            Ok(SkipToken::Key("a".to_owned()))
        );
        assert_eq!(
            decode_skip_token(&encode("{\"o\":1,\"o\":7}")),
            Ok(SkipToken::Offset(7))
        );
    }

    /// `JSON.parse` keeps half a surrogate pair; bound to a statement it is U+FFFD.
    #[test]
    fn half_a_surrogate_pair_in_a_token_is_read_as_javascript_binds_it() {
        // A UTF-16 unit as a JSON text escapes it, and a token with a key.
        let unit = |hex: &str| format!("\\u{hex}");
        let key = |value: &str| format!("{{\"k\":\"{value}\"}}");
        let (high, low, replaced) = (unit("d83d"), unit("de00"), unit("fffd"));
        let fixed = |text: &str| without_unpaired_surrogates(text).into_owned();
        assert_eq!(fixed(&key(&high)), key(&replaced));
        assert_eq!(
            fixed(&key(&format!("{low}x"))),
            key(&format!("{replaced}x"))
        );
        assert_eq!(
            fixed(&key(&format!("{high}{high}{low}{low}"))),
            key(&format!("{replaced}{high}{low}{replaced}"))
        );
        // After an escaped backslash an escape is still one, in either case of hex.
        assert_eq!(
            fixed(&key(&format!("\\\\{}", unit("D83D")))),
            key(&format!("\\\\{replaced}"))
        );
        // A whole pair, other escapes and an escaped backslash before a `u` stay.
        for text in [
            key(&format!("{high}{low}")),
            key(&format!("{}\\n\\\\ud83d", unit("00e9"))),
            key("\\\\\\\\ud83d \u{e9}"),
            key("a"),
            "\\".to_owned(),
            String::new(),
        ] {
            assert!(
                matches!(
                    without_unpaired_surrogates(&text),
                    std::borrow::Cow::Borrowed(_)
                ),
                "{text}"
            );
        }
        let encode = |json: &str| URL_SAFE_NO_PAD.encode(json);
        assert_eq!(
            decode_skip_token(&encode(&key(&format!("a{high}")))),
            Ok(SkipToken::Key("a\u{fffd}".to_owned()))
        );
        assert_eq!(
            decode_skip_token(&encode(&key(&format!("{high}{low}")))),
            Ok(SkipToken::Key("\u{1f600}".to_owned()))
        );
    }

    #[test]
    fn select_keeps_the_catalogue_order_and_refuses_what_is_not_a_property() {
        let names = |given: &str| {
            collection(&[("$select", given)])
                .select
                .map(|props| props.iter().map(|p| p.name.clone()).collect::<Vec<_>>())
        };
        assert_eq!(names("title,id"), Some(vec!["id".into(), "title".into()]));
        assert_eq!(
            names(" title , id "),
            Some(vec!["id".into(), "title".into()])
        );
        assert_eq!(names("id,id"), Some(vec!["id".into()]));
        assert_eq!(names("*"), None);
        assert_eq!(names("id,*"), None);
        for (select, message) in [
            ("nope", "Unknown property 'nope' in $select"),
            ("id,", "$select has an empty item"),
            (",id", "$select has an empty item"),
            ("", "$select has an empty item"),
            (
                "id;drop table x",
                "Unknown property 'id;drop table x' in $select",
            ),
            ("id desc", "Unknown property 'id desc' in $select"),
            ("\"id\"", "Unknown property '\"id\"' in $select"),
            ("id,(select 1)", "Unknown property '(select 1)' in $select"),
        ] {
            assert_eq!(refused(&[("$select", select)]), (400, message.to_owned()));
        }
        assert_eq!(
            refused(&[("$select", "tags/x")]),
            (501, "$select paths are not supported ('tags/x')".to_owned())
        );
        assert_eq!(
            refused(&[("$select", "a.b")]),
            (501, "$select paths are not supported ('a.b')".to_owned())
        );
    }

    #[test]
    fn orderby_reads_names_and_directions() {
        let terms = |given: &str| {
            collection(&[("$orderby", given)])
                .orderby
                .iter()
                .map(|term| (term.prop.name.clone(), term.desc))
                .collect::<Vec<_>>()
        };
        assert_eq!(terms("createdAt desc"), [("createdAt".to_owned(), true)]);
        assert_eq!(terms("createdAt asc"), [("createdAt".to_owned(), false)]);
        assert_eq!(
            terms("state, conversationNumber   desc"),
            [
                ("state".to_owned(), false),
                ("conversationNumber".to_owned(), true)
            ]
        );
        assert_eq!(terms("title\tdesc"), [("title".to_owned(), true)]);
        for (orderby, message) in [
            ("nope", "Unknown property 'nope' in $orderby"),
            ("tags", "Property 'tags' cannot be used in $orderby"),
            ("id sideways", "Invalid $orderby term 'id sideways'"),
            ("id desc desc", "Invalid $orderby term 'id desc desc'"),
            ("id DESC", "Invalid $orderby term 'id DESC'"),
            (
                "id; drop table x",
                "Invalid $orderby term 'id; drop table x'",
            ),
            (",id", "Invalid $orderby term ''"),
            ("", "Invalid $orderby term ''"),
            ("1id", "Invalid $orderby term '1id'"),
            ("a,b,c,d,e,f", "$orderby has more than 5 terms"),
        ] {
            assert_eq!(refused(&[("$orderby", orderby)]), (400, message.to_owned()));
        }
        assert_eq!(
            refused(&[("$orderby", "tolower(title)")]),
            (501, "$orderby supports property names only".to_owned())
        );
        assert_eq!(
            refused(&[("$orderby", "tags/x")]),
            (501, "$orderby supports property names only".to_owned())
        );
        // A long text is filterable, not sortable.
        assert_eq!(
            options(
                "Problems",
                &[("$orderby", "description")],
                Surface::Collection
            )
            .map_err(|error| error.message),
            Err("Property 'description' cannot be used in $orderby".to_owned())
        );
    }

    #[test]
    #[allow(clippy::too_many_lines)] // one table of options and their refusals
    fn options_are_checked_in_the_workers_order() {
        for (given, status, message) in [
            (
                vec![("$top", "-1")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$top", "abc")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$top", "1.5")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$top", "")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$top", "1234567890")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$skip", "-2")],
                400,
                "$skip must be a non-negative integer",
            ),
            (
                vec![("$skip", "x")],
                400,
                "$skip must be a non-negative integer",
            ),
            (vec![("$count", "yes")], 400, "$count must be true or false"),
            (vec![("$count", "1")], 400, "$count must be true or false"),
            (
                vec![("$count", "TRUE")],
                400,
                "$count must be true or false",
            ),
            (
                vec![("$inlinecount", "allpages")],
                400,
                "Unknown query option '$inlinecount'",
            ),
            (vec![("$Top", "1")], 400, "Unknown query option '$Top'"),
            (
                vec![("$top", "1"), ("$top", "2")],
                400,
                "$top is given more than once",
            ),
            (vec![("$expand", "x")], 501, "$expand is not supported"),
            (vec![("$APPLY", "x")], 501, "$APPLY is not supported"),
            (vec![("$search", "x")], 501, "$search is not supported"),
            (vec![("$compute", "x")], 501, "$compute is not supported"),
            (vec![("$levels", "x")], 501, "$levels is not supported"),
            (
                vec![("$deltatoken", "x")],
                501,
                "$deltatoken is not supported",
            ),
            (
                vec![("$schemaversion", "x")],
                501,
                "$schemaversion is not supported",
            ),
            (
                vec![("$format", "xml")],
                415,
                "$format=xml is not supported, only json",
            ),
            (
                vec![("$format", "atom"), ("$top", "x")],
                415,
                "$format=atom is not supported, only json",
            ),
            (
                vec![("$format", "jsonx")],
                415,
                "$format=jsonx is not supported, only json",
            ),
            (vec![("$skiptoken", "garbage!!")], 400, "Invalid $skiptoken"),
            // The first option in the worker's order that fails is the one named.
            (
                vec![("$count", "yes"), ("$filter", "nope eq 1"), ("$top", "x")],
                400,
                "$top must be a non-negative integer",
            ),
            (
                vec![("$count", "yes"), ("$filter", "nope eq 1")],
                400,
                "Unknown property 'nope' on Conversations",
            ),
            // An unknown option is refused before a later one is read.
            (
                vec![("$nope", "1"), ("$expand", "x")],
                400,
                "Unknown query option '$nope'",
            ),
        ] {
            assert_eq!(refused(&given), (status, message.to_owned()), "{given:?}");
        }
        // A token belongs to the kind of query that made it.
        let offset = encode_skip_token(&SkipToken::Offset(5));
        let key = encode_skip_token(&SkipToken::Key("msg_01000".into()));
        let mismatch = (
            400,
            "This $skiptoken does not belong to this query".to_owned(),
        );
        assert_eq!(refused(&[("$skiptoken", &offset)]), mismatch);
        assert_eq!(
            refused(&[("$skiptoken", &key), ("$orderby", "createdAt")]),
            mismatch
        );
        collection(&[("$skiptoken", &key)]);
        collection(&[("$skiptoken", &offset), ("$orderby", "createdAt")]);
    }

    #[test]
    fn json_is_the_only_format() {
        for format in [
            "json",
            "JSON",
            " json ",
            "application/json",
            "Application/Json",
            "application/json;odata.metadata=minimal",
            "json;",
        ] {
            assert!(is_json_format(format), "{format}");
        }
        for format in [
            "xml",
            "atom",
            "application/xml",
            "csv",
            "",
            "jsonx",
            "json ;x",
            "json;a\nb",
            "text/json",
        ] {
            assert!(!is_json_format(format), "{format}");
        }
    }

    #[test]
    fn each_surface_takes_its_own_options() {
        assert_eq!(
            options("Conversations", &[("$top", "1")], Surface::Count).map_err(|e| e.message),
            Err("$top is not allowed here".to_owned())
        );
        assert_eq!(
            options("Teams", &[("$filter", "name eq 'x'")], Surface::Entity).map_err(|e| e.message),
            Err("$filter is not allowed here".to_owned())
        );
        assert_eq!(
            options("Teams", &[("$top", "1")], Surface::Entity).map_err(|e| e.message),
            Err("$top is not allowed here".to_owned())
        );
        assert!(
            options(
                "Teams",
                &[("$select", "id"), ("$format", "json")],
                Surface::Entity
            )
            .is_ok()
        );
        assert!(options("Teams", &[("$filter", "name eq 'x'")], Surface::Count).is_ok());
        // An option that is not OData's own is ignored, however often it is given.
        let parsed = collection(&[("custom", "1"), ("custom", "2"), ("$top", "1")]);
        assert_eq!(parsed.top, Some(1));
        assert_eq!(collection(&[]), QueryOptions::default());
    }

    #[test]
    fn the_page_statement_is_the_workers() {
        let first = plan(&[]);
        assert!(first.statement.sql().starts_with(
            "SELECT json_build_array(\"desk_conversations\".\"id\", json_build_array(\"desk_conversations\".\"id\", \"desk_conversations\".\"conversation_number\", "
        ));
        assert!(first.statement.sql().ends_with(
            ")::text FROM \"desk_conversations\" ORDER BY \"desk_conversations\".\"id\" ASC LIMIT $1::int OFFSET $2::int"
        ));
        assert_eq!(
            first.statement.params(),
            [Param::Int(1001), Param::BigInt(0)]
        );
        assert_eq!((first.wanted, first.base_offset), (1000, 0));

        let page = plan(&[
            ("$select", "id,createdAt,tags"),
            ("$filter", "state eq 'open'"),
            ("$orderby", "createdAt desc, title"),
            ("$skip", "40"),
            ("$top", "20"),
        ]);
        assert_eq!(
            page.statement.sql(),
            "SELECT json_build_array(\"desk_conversations\".\"id\", json_build_array(\"desk_conversations\".\"id\", \
             COALESCE(\"desk_conversations\".\"tags\", '[]'::jsonb)::text, \
             to_char(\"desk_conversations\".\"created_at\", 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))::text \
             FROM \"desk_conversations\" WHERE COALESCE(\"desk_conversations\".\"state\" = $1::text, false) \
             ORDER BY \"desk_conversations\".\"created_at\" DESC NULLS LAST, \"desk_conversations\".\"title\" ASC NULLS FIRST, \
             \"desk_conversations\".\"id\" ASC LIMIT $2::int OFFSET $3::int"
        );
        assert_eq!(
            page.statement.params(),
            [
                Param::Text("open".into()),
                Param::Int(20),
                Param::BigInt(40)
            ]
        );

        // Ordering by the key itself adds no tie-breaker; `$top` above the
        // page size probes one row further.
        let by_key = plan(&[("$orderby", "id desc"), ("$top", "1500")]);
        assert!(by_key.statement.sql().ends_with(
            " ORDER BY \"desk_conversations\".\"id\" DESC NULLS LAST LIMIT $1::int OFFSET $2::int"
        ));
        assert_eq!(
            by_key.statement.params(),
            [Param::Int(1001), Param::BigInt(0)]
        );
        assert_eq!(
            plan(&[("$top", "1000")]).statement.params()[0],
            Param::Int(1000)
        );
        assert_eq!(plan(&[("$top", "0")]).wanted, 0);
    }

    #[test]
    fn a_token_is_the_position() {
        let key = encode_skip_token(&SkipToken::Key("cnv_3".into()));
        let keyset = plan(&[
            ("$skiptoken", &key),
            ("$skip", "9"),
            ("$filter", "rating ge 3"),
        ]);
        assert!(keyset.statement.sql().ends_with(
            " WHERE COALESCE(\"desk_conversations\".\"rating\" >= $1::int, false) \
             AND \"desk_conversations\".\"id\" > $2::text \
             ORDER BY \"desk_conversations\".\"id\" ASC LIMIT $3::int OFFSET $4::int"
        ));
        assert_eq!(
            keyset.statement.params(),
            [
                Param::Int(3),
                Param::Text("cnv_3".into()),
                Param::Int(1001),
                Param::BigInt(0)
            ]
        );
        let offset = encode_skip_token(&SkipToken::Offset(2000));
        let paged = plan(&[
            ("$skiptoken", &offset),
            ("$orderby", "createdAt"),
            ("$skip", "9"),
        ]);
        assert_eq!(paged.base_offset, 2000);
        assert_eq!(
            paged.statement.params(),
            [Param::Int(1001), Param::BigInt(2000)]
        );
    }

    #[test]
    fn soft_deleted_rows_and_derived_values() {
        let teams = set("Teams");
        assert_eq!(
            count_statement(teams, None).sql(),
            "SELECT count(*) FROM \"helpdesk_departments\" WHERE \"helpdesk_departments\".\"deleted_at\" IS NULL"
        );
        let filter = parse_filter("name eq 'x'", teams).expect("a filter");
        assert_eq!(
            count_statement(teams, Some(&filter)).sql(),
            "SELECT count(*) FROM \"helpdesk_departments\" WHERE \"helpdesk_departments\".\"deleted_at\" IS NULL \
             AND COALESCE(\"helpdesk_departments\".\"name\" = $1::text, false)"
        );
        assert_eq!(
            count_statement(set("Conversations"), None).sql(),
            "SELECT count(*) FROM \"desk_conversations\""
        );

        let agents = set("Agents");
        let wanted: Vec<&Property> = ["id", "isActive", "createdAt"]
            .iter()
            .filter_map(|name| agents.property(name))
            .collect();
        let entity = entity_statement(agents, "mem_1", &wanted).expect("a statement");
        assert_eq!(
            entity.sql(),
            "SELECT json_build_array(\"workspace_members\".\"id\", json_build_array(\"workspace_members\".\"id\", \
             (status = 'ACTIVE'), \
             to_char((\"workspace_members\".\"created_at\" AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))::text \
             FROM \"workspace_members\" WHERE \"workspace_members\".\"deleted_at\" IS NULL \
             AND \"workspace_members\".\"id\" = $1::text LIMIT 1"
        );
        assert_eq!(entity.params(), [Param::Text("mem_1".into())]);
        let messages = set("Messages");
        let event: Vec<&Property> = messages.property("eventType").into_iter().collect();
        assert!(
            entity_statement(messages, "msg_1", &event)
                .expect("a statement")
                .sql()
                .contains("json_build_array((metadata->>'eventType'))")
        );
    }

    /// Whatever the request holds, the statement's text is the catalogue's
    /// names and this crate's SQL: every value is a bound parameter.
    #[test]
    fn hostile_input_never_reaches_the_statement() {
        let attacks = [
            "x'; DROP TABLE desk_conversations; --",
            "' OR '1'='1",
            "\\'; DELETE FROM desk_conversations; --",
            "1); DROP TABLE desk_conversations; --",
            "\"; DROP TABLE x; --",
            "$1::text) OR (1=1",
            "${1+1}",
        ];
        let conversations = set("Conversations");
        let all = served_properties(conversations, None);
        // A NUL never becomes a parameter (Postgres would refuse the
        // statement): the literal and the token are a 400.
        let nul = encode_skip_token(&SkipToken::Key("a\0b".to_owned()));
        assert_eq!(
            refused(&[("$skiptoken", &nul)]),
            (400, "Invalid $skiptoken".to_owned())
        );
        assert_eq!(
            refused(&[("$filter", "title eq 'a\0b'")]),
            (
                400,
                "A string literal in $filter must not contain a NUL character".to_owned()
            )
        );
        for attack in attacks {
            let quoted = format!("'{}'", attack.replace('\'', "''"));

            // As a literal, as a skiptoken's key and as an entity key: bound.
            let filter = format!("title eq {quoted} or contains(email,{quoted})");
            let token = encode_skip_token(&SkipToken::Key(attack.to_owned()));
            let page = plan(&[
                ("$filter", &filter),
                ("$skiptoken", &token),
                ("$count", "true"),
            ]);
            assert_only_catalogue_text(&page.statement);
            assert!(
                page.statement
                    .params()
                    .contains(&Param::Text(attack.to_owned()))
            );
            let parsed = parse_filter(&filter, conversations).expect("a filter");
            assert_only_catalogue_text(&count_statement(conversations, Some(&parsed)));
            let entity = entity_statement(conversations, attack, &all).expect("a statement");
            assert_only_catalogue_text(&entity);
            assert_eq!(entity.params(), [Param::Text(attack.to_owned())]);
            for statement in [&page.statement, &entity] {
                for word in ["DROP", "DELETE", "1=1", "1+1", "--", ";"] {
                    assert!(!statement.sql().contains(word), "{attack}: {word}");
                }
            }

            // As a property name, anywhere a name is read: refused, so no
            // statement is built at all.
            for given in [
                vec![("$select", attack)],
                vec![("$orderby", attack)],
                vec![("$filter", attack)],
            ] {
                assert!(
                    options("Conversations", &given, Surface::Collection).is_err(),
                    "{given:?}"
                );
            }
            let named = format!("{attack} eq 'x'");
            assert!(parse_filter(&named, conversations).is_err(), "{named}");
            let ordered = format!("id, {attack}");
            assert!(
                options(
                    "Conversations",
                    &[("$orderby", &ordered)],
                    Surface::Collection
                )
                .is_err()
            );
            let selected = format!("id,{attack}");
            assert!(
                options(
                    "Conversations",
                    &[("$select", &selected)],
                    Surface::Collection
                )
                .is_err()
            );
        }
        // Numbers are numbers: `$top`, `$skip` and an offset token are bound too.
        let offset = encode_skip_token(&SkipToken::Offset(7));
        let numbers = plan(&[("$top", "5"), ("$orderby", "id"), ("$skiptoken", &offset)]);
        assert_only_catalogue_text(&numbers.statement);
        assert_eq!(
            numbers.statement.params(),
            [Param::Int(5), Param::BigInt(7)]
        );
        for (name, value) in [
            ("$top", "5; DROP TABLE x"),
            ("$skip", "1 OR 1=1"),
            ("$top", "0x10"),
        ] {
            assert!(options("Conversations", &[(name, value)], Surface::Collection).is_err());
        }
    }

    #[test]
    fn every_set_builds_statements_from_the_catalogue_only() {
        for entity_set in &catalog().entity_sets {
            let all = served_properties(entity_set, None);
            let page = page_plan(entity_set, &QueryOptions::default(), &all).expect("a plan");
            assert_only_catalogue_text(&page.statement);
            assert_only_catalogue_text(&count_statement(entity_set, None));
            assert_only_catalogue_text(
                &entity_statement(entity_set, "x", &all).expect("a statement"),
            );
        }
    }

    #[test]
    fn rows_become_entities_in_the_order_asked_for() {
        let conversations = set("Conversations");
        let wanted: Vec<&Property> = [
            "id",
            "conversationNumber",
            "title",
            "tags",
            "createdAt",
            "isMajorIncident",
            "rating",
        ]
        .iter()
        .filter_map(|name| conversations.property(name))
        .collect();
        let (key, entity) = read_row(
            r#"["cnv_1", ["cnv_1", 1, null, "[\"vip\", \"hardware\"]", "2026-01-11T10:00:00.250Z", true, null]]"#,
            &wanted,
        )
        .expect("a row");
        assert_eq!(js_string(&key), "cnv_1");
        assert_eq!(
            stringify(&entity),
            r#"{"id":"cnv_1","conversationNumber":1,"title":null,"tags":["vip","hardware"],"createdAt":"2026-01-11T10:00:00.250Z","isMajorIncident":true,"rating":null}"#
        );
        // A null collection is empty, and groups are read back in order.
        let (_, grouped) =
            read_row(r#"["k", ["a", 2], [null, null]]"#, &wanted[..4]).expect("a row");
        assert_eq!(
            stringify(&grouped),
            r#"{"id":"a","conversationNumber":2,"title":null,"tags":[]}"#
        );
        assert!(read_row(r#"["k", ["a"]]"#, &wanted).is_err());
        assert!(read_row("{}", &wanted).is_err());
    }

    #[test]
    fn values_take_the_json_type_of_their_edm_type() {
        let conversations = set("Conversations");
        let prop = |name: &str| conversations.property(name).expect("a property");
        let value =
            |name: &str, raw: Js| stringify(&to_json_value(prop(name), raw).expect("a value"));
        assert_eq!(value("rating", Js::Number(5.0)), "5");
        assert_eq!(value("rating", Js::String("12".into())), "12");
        assert_eq!(value("rating", Js::String("x".into())), "null");
        assert_eq!(value("isMajorIncident", Js::Bool(false)), "false");
        assert_eq!(value("isMajorIncident", Js::String("t".into())), "true");
        assert_eq!(value("isMajorIncident", Js::String("f".into())), "false");
        assert_eq!(value("title", Js::String("a\"b".into())), r#""a\"b""#);
        assert_eq!(value("tags", Js::Null), "[]");
        assert_eq!(value("tags", Js::String("[]".into())), "[]");
        assert_eq!(value("title", Js::Null), "null");
    }
}
