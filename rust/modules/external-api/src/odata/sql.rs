//! The feed's SQL: a statement built for the request, and the `$filter`
//! tree compiled into it (`routes/v1/odata/filter-sql.ts`).
//!
//! This feed selects, filters and orders by request, so its statements are
//! not literals. They are built the way the other request-shaped lists are
//! (`weldsuite_desk_domain::list`, `weldsuite_legal_entities::service`):
//! text assembled here, values bound. What keeps that safe is [`Statement`]:
//! its text can only grow by
//!
//! - [`Statement::push`], which takes a `&'static str` (SQL written in this
//!   crate: keywords, operators, punctuation), and
//! - [`Statement::table`], [`Statement::column`] and
//!   [`Statement::soft_delete`], which take the catalogue's own entries
//!   (`rust/catalogs/odata.json`, reviewed and exported from TypeScript).
//!
//! Everything that comes from the request is a [`Param`], bound through
//! [`Statement::bind`] with an explicit cast, so no input reaches the
//! statement as text. A property name in a request is only ever looked up in
//! the catalogue, and what is written is the catalogue's column.
//!
//! Comparisons follow `OData`'s null rules: a comparison with a null column is
//! false (`COALESCE(..., false)`), so `not` of it is true, and `ne` is
//! `IS DISTINCT FROM`.

use sea_orm::DbErr;
use sqlx::postgres::PgArguments;
use sqlx::query::QueryScalar;
use sqlx::{AssertSqlSafe, PgPool, Postgres};
use weldsuite_db::orm_error;

use super::catalog::{EdmType, EntitySet, Property, is_plain_column};
use super::filter::{CmpOp, Literal, Node, TextFn};

/// A value of the request, bound to the statement.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Param {
    Text(String),
    Int(i32),
    BigInt(i64),
    Float(f64),
    Boolean(bool),
}

/// A statement and its bound parameters, in the order they appear.
#[derive(Debug, Default)]
pub(crate) struct Statement {
    sql: String,
    params: Vec<Param>,
}

impl Statement {
    #[cfg(test)]
    pub(crate) fn sql(&self) -> &str {
        &self.sql
    }

    #[cfg(test)]
    pub(crate) fn params(&self) -> &[Param] {
        &self.params
    }

    /// SQL written in this crate: keywords, operators, punctuation.
    pub(crate) fn push(&mut self, fixed: &'static str) {
        self.sql.push_str(fixed);
    }

    /// `sql.identifier(name)`, for the catalogue's names only.
    fn identifier(&mut self, name: &str) {
        self.sql.push('"');
        self.sql.push_str(&name.replace('"', "\"\""));
        self.sql.push('"');
    }

    /// The set's table.
    pub(crate) fn table(&mut self, set: &EntitySet) {
        self.identifier(&set.table);
    }

    /// `propExpr(set, prop)`: the property's value; timestamps are always
    /// the UTC `timestamp`. A derived property is the catalogue's own fixed
    /// expression.
    pub(crate) fn column(&mut self, set: &EntitySet, prop: &Property) {
        if prop.with_time_zone {
            self.sql.push('(');
        }
        if is_plain_column(&prop.column) {
            self.identifier(&set.table);
            self.sql.push('.');
            self.identifier(&prop.column);
        } else {
            self.sql.push('(');
            self.sql.push_str(&prop.column);
            self.sql.push(')');
        }
        if prop.with_time_zone {
            self.sql.push_str(" AT TIME ZONE 'UTC')");
        }
    }

    /// `<table>.<softDelete> IS NULL`, for a set that has such a column.
    pub(crate) fn soft_delete(&mut self, set: &EntitySet) {
        if let Some(column) = set.soft_delete.as_deref() {
            self.identifier(&set.table);
            self.sql.push('.');
            self.identifier(column);
            self.sql.push_str(" IS NULL");
        }
    }

    /// A value of the request: `$n::cast`, with the value bound.
    pub(crate) fn bind(&mut self, param: Param, cast: &'static str) {
        self.params.push(param);
        self.sql.push('$');
        self.sql.push_str(&self.params.len().to_string());
        self.sql.push_str("::");
        self.sql.push_str(cast);
    }

    #[allow(
        clippy::disallowed_methods,
        reason = "the OData compiler builds the statement from the request at run time: \
                  the catalogue's tables and derived expressions, the request's $filter, \
                  $orderby and $select"
    )]
    fn bound<O>(self) -> QueryScalar<'static, Postgres, O, PgArguments>
    where
        (O,): for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow>,
    {
        let mut query = sqlx::query_scalar(AssertSqlSafe(self.sql));
        for param in self.params {
            query = match param {
                Param::Text(value) => query.bind(value),
                Param::Int(value) => query.bind(value),
                Param::BigInt(value) => query.bind(value),
                Param::Float(value) => query.bind(value),
                Param::Boolean(value) => query.bind(value),
            };
        }
        query
    }

    /// Every row's single text column.
    pub(crate) async fn texts(self, db: &PgPool) -> Result<Vec<String>, DbErr> {
        self.bound().fetch_all(db).await.map_err(orm_error)
    }

    /// The first row's single text column, if any.
    pub(crate) async fn text(self, db: &PgPool) -> Result<Option<String>, DbErr> {
        self.bound().fetch_optional(db).await.map_err(orm_error)
    }

    /// The single `bigint` a count answers.
    pub(crate) async fn count(self, db: &PgPool) -> Result<i64, DbErr> {
        self.bound().fetch_one(db).await.map_err(orm_error)
    }
}

/// `escapeLike(value)`: `%`, `_` and the escape character itself, so a LIKE
/// pattern matches the text literally.
pub(crate) fn escape_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// `param(type, lit)`: a literal as a bound parameter and the cast to the
/// type it is compared with. `None` for null, which has no parameter.
fn literal_param(edm: EdmType, lit: &Literal) -> Option<(Param, &'static str)> {
    Some(match lit {
        Literal::Null => return None,
        Literal::String(value) => (Param::Text(value.clone()), "text"),
        Literal::Boolean(value) => (Param::Boolean(*value), "boolean"),
        Literal::DateTime { ts, .. } => (Param::Text(ts.clone()), "timestamp"),
        // The parser checked the literal against the type: an `Int` is a
        // safe integer, and one compared with an Int32 fits it.
        #[allow(clippy::cast_possible_truncation)]
        Literal::Int(value) | Literal::Double(value) => match edm {
            EdmType::Int64 => (Param::BigInt(*value as i64), "bigint"),
            EdmType::Double => (Param::Float(*value), "float8"),
            _ => (Param::Int(*value as i32), "int"),
        },
    })
}

/// One comparison of `subject` with a bound value, null-safe.
fn comparison(
    out: &mut Statement,
    op: CmpOp,
    subject: &dyn Fn(&mut Statement),
    (param, cast): (Param, &'static str),
) {
    if op == CmpOp::Ne {
        subject(out);
        out.push(" IS DISTINCT FROM ");
        out.bind(param, cast);
        return;
    }
    out.push("COALESCE(");
    subject(out);
    out.push(match op {
        CmpOp::Gt => " > ",
        CmpOp::Ge => " >= ",
        CmpOp::Lt => " < ",
        CmpOp::Le => " <= ",
        CmpOp::Eq | CmpOp::Ne => " = ",
    });
    out.bind(param, cast);
    out.push(", false)");
}

fn compare(out: &mut Statement, set: &EntitySet, node: &Node<'_>) {
    let Node::Cmp {
        op,
        prop,
        func,
        lit,
    } = node
    else {
        return;
    };
    let column = |out: &mut Statement| out.column(set, prop);
    if *lit == Literal::Null {
        column(out);
        out.push(if *op == CmpOp::Eq {
            " IS NULL"
        } else {
            " IS NOT NULL"
        });
        return;
    }

    if let Some(func) = func {
        let part = |out: &mut Statement| {
            out.push("extract(");
            out.push(func.field());
            out.push(" from ");
            out.column(set, prop);
            out.push(")::int");
        };
        if let Some(value) = literal_param(EdmType::Int32, lit) {
            comparison(out, *op, &part, value);
        }
        return;
    }

    // A bare date means the day: `eq` / `ne` match all of it, the others
    // compare with its midnight.
    if let Literal::DateTime {
        ts,
        day_end: Some(day_end),
    } = lit
        && op.is_equality()
    {
        if *op == CmpOp::Ne {
            out.push("NOT ");
        }
        out.push("COALESCE(");
        column(out);
        out.push(" >= ");
        out.bind(Param::Text(ts.clone()), "timestamp");
        out.push(" AND ");
        column(out);
        out.push(" < ");
        out.bind(Param::Text(day_end.clone()), "timestamp");
        out.push(", false)");
        return;
    }

    if let Some(value) = literal_param(prop.edm, lit) {
        comparison(out, *op, &column, value);
    }
}

/// `filterToSql(node, set)`: the WHERE condition for a parsed `$filter`.
pub(crate) fn push_filter(out: &mut Statement, node: &Node<'_>, set: &EntitySet) {
    let joined = |out: &mut Statement, args: &[Node<'_>], separator: &'static str| {
        out.push("(");
        for (index, arg) in args.iter().enumerate() {
            if index > 0 {
                out.push(separator);
            }
            push_filter(out, arg, set);
        }
        out.push(")");
    };
    match node {
        Node::And(args) => joined(out, args, " AND "),
        Node::Or(args) => joined(out, args, " OR "),
        Node::Not(arg) => {
            out.push("(NOT ");
            push_filter(out, arg, set);
            out.push(")");
        }
        Node::Cmp { .. } => compare(out, set, node),
        Node::Text { func, prop, value } => {
            let escaped = escape_like(value);
            let pattern = match func {
                TextFn::Contains => format!("%{escaped}%"),
                TextFn::StartsWith => format!("{escaped}%"),
                TextFn::EndsWith => format!("%{escaped}"),
            };
            out.push("COALESCE(");
            out.column(set, prop);
            out.push(" LIKE ");
            out.bind(Param::Text(pattern), "text");
            out.push(" ESCAPE '\\', false)");
        }
        Node::Any { prop, value } => {
            out.push("COALESCE(");
            out.column(set, prop);
            out.push(" @> jsonb_build_array(");
            out.bind(Param::Text(value.clone()), "text");
            out.push("), false)");
        }
    }
}

/// Checks the tests of this feed's statements share.
#[cfg(test)]
pub(crate) mod testing {
    use super::super::catalog::{catalog, is_plain_column};
    use super::Statement;

    /// What is left of a statement once the catalogue's names, the SQL this
    /// crate writes and the placeholders are taken out: nothing.
    fn foreign_text(sql: &str) -> String {
        let mut rest = sql.to_owned();
        let mut names: Vec<String> = Vec::new();
        for set in &catalog().entity_sets {
            names.push(format!("\"{}\"", set.table));
            names.extend(set.soft_delete.iter().map(|column| format!("\"{column}\"")));
            for prop in &set.properties {
                names.push(if is_plain_column(&prop.column) {
                    format!("\"{}\"", prop.column)
                } else {
                    format!("({})", prop.column)
                });
            }
        }
        names.sort_by_key(|name| std::cmp::Reverse(name.len()));
        for name in &names {
            rest = rest.replace(name.as_str(), " ");
        }
        for fixed in [
            "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'",
            "AT TIME ZONE 'UTC'",
            "ESCAPE '\\'",
            "'[]'::jsonb",
            "jsonb_build_array",
            "json_build_array",
            "IS DISTINCT FROM",
            "IS NOT NULL",
            "IS NULL",
            "NULLS FIRST",
            "NULLS LAST",
            "ORDER BY",
            "COALESCE",
            "to_char",
            "count(*)",
            "extract",
            "SELECT",
            "OFFSET",
            "WHERE",
            "LIMIT 1",
            "LIMIT",
            "false",
            "::timestamp",
            "::boolean",
            "::bigint",
            "::float8",
            "::text",
            "::int",
            "month",
            "year",
            "from",
            "FROM",
            "LIKE",
            "DESC",
            "day",
            "AND",
            "ASC",
            "NOT",
            "OR",
            "@>",
            ">=",
            "<=",
        ] {
            rest = rest.replace(fixed, " ");
        }
        // `$n`, then the punctuation left over.
        let mut out = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '$' {
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                }
            } else if !matches!(ch, ' ' | '(' | ')' | ',' | '.' | '=' | '<' | '>') {
                out.push(ch);
            }
        }
        out
    }

    pub(crate) fn assert_only_catalogue_text(statement: &Statement) {
        assert_eq!(
            foreign_text(statement.sql()),
            "",
            "text from outside the catalogue in: {}",
            statement.sql()
        );
        // Every parameter has exactly one placeholder, in order.
        for index in 1..=statement.params().len() {
            assert_eq!(
                statement.sql().matches(&format!("${index}::")).count(),
                1,
                "{}",
                statement.sql()
            );
        }
        assert!(
            !statement
                .sql()
                .contains(&format!("${}", statement.params().len() + 1))
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::catalog::find_entity_set;
    use super::super::filter::parse_filter;
    use super::testing::assert_only_catalogue_text;
    use super::*;

    fn conversations() -> &'static EntitySet {
        find_entity_set("Conversations").expect("the set")
    }

    fn render_on(set: &'static EntitySet, text: &str) -> Statement {
        let node = match parse_filter(text, set) {
            Ok(node) => node,
            Err(error) => panic!("{text}: {}", error.message),
        };
        let mut statement = Statement::default();
        push_filter(&mut statement, &node, set);
        statement
    }

    fn render(text: &str) -> Statement {
        render_on(conversations(), text)
    }

    fn text(value: &str) -> Param {
        Param::Text(value.to_owned())
    }

    #[test]
    fn every_literal_is_bound_and_cast() {
        let statement = render(
            "state eq 'open' and rating ge 3 and createdAt lt 2026-01-31T00:00:00Z and isMajorIncident eq true",
        );
        assert_eq!(
            statement.params(),
            [
                text("open"),
                Param::Int(3),
                text("2026-01-31 00:00:00.000"),
                Param::Boolean(true)
            ]
        );
        assert_eq!(
            statement.sql(),
            "(COALESCE(\"desk_conversations\".\"state\" = $1::text, false) \
             AND COALESCE(\"desk_conversations\".\"rating\" >= $2::int, false) \
             AND COALESCE(\"desk_conversations\".\"created_at\" < $3::timestamp, false) \
             AND COALESCE(\"desk_conversations\".\"is_major_incident\" = $4::boolean, false))"
        );
        for word in ["open", "2026", "true"] {
            assert!(!statement.sql().contains(word), "{word}");
        }
    }

    #[test]
    fn null_and_ne_keep_odatas_semantics() {
        assert_eq!(
            render("title eq null").sql(),
            "\"desk_conversations\".\"title\" IS NULL"
        );
        assert_eq!(
            render("title ne null").sql(),
            "\"desk_conversations\".\"title\" IS NOT NULL"
        );
        assert_eq!(
            render("title ne 'x'").sql(),
            "\"desk_conversations\".\"title\" IS DISTINCT FROM $1::text"
        );
        assert_eq!(
            render("not (title eq 'x')").sql(),
            "(NOT COALESCE(\"desk_conversations\".\"title\" = $1::text, false))"
        );
        assert_eq!(
            render("state eq 'a' or state eq 'b'").sql(),
            "(COALESCE(\"desk_conversations\".\"state\" = $1::text, false) \
             OR COALESCE(\"desk_conversations\".\"state\" = $2::text, false))"
        );
    }

    #[test]
    fn a_bare_date_is_a_day_for_eq_and_ne_and_a_midnight_for_the_rest() {
        let eq = render("createdAt eq 2026-01-31");
        assert_eq!(
            eq.params(),
            [
                text("2026-01-31 00:00:00.000"),
                text("2026-02-01 00:00:00.000")
            ]
        );
        assert_eq!(
            eq.sql(),
            "COALESCE(\"desk_conversations\".\"created_at\" >= $1::timestamp \
             AND \"desk_conversations\".\"created_at\" < $2::timestamp, false)"
        );
        assert!(
            render("createdAt ne 2026-01-31")
                .sql()
                .starts_with("NOT COALESCE(")
        );
        let ge = render("createdAt ge 2026-01-31");
        assert_eq!(ge.params(), [text("2026-01-31 00:00:00.000")]);
        assert_eq!(
            ge.sql(),
            "COALESCE(\"desk_conversations\".\"created_at\" >= $1::timestamp, false)"
        );
    }

    #[test]
    fn like_patterns_escape_percent_underscore_and_backslash() {
        assert_eq!(escape_like("50%_off\\"), "50\\%\\_off\\\\");
        let contains = render("contains(title,'50%_')");
        assert_eq!(contains.params(), [text("%50\\%\\_%")]);
        assert_eq!(
            contains.sql(),
            "COALESCE(\"desk_conversations\".\"title\" LIKE $1::text ESCAPE '\\', false)"
        );
        assert_eq!(render("startswith(title,'a%')").params(), [text("a\\%%")]);
        assert_eq!(render("endswith(title,'_a')").params(), [text("%\\_a")]);
    }

    #[test]
    fn date_parts_extract_and_any_is_a_jsonb_containment() {
        assert_eq!(
            render("year(createdAt) eq 2026").sql(),
            "COALESCE(extract(year from \"desk_conversations\".\"created_at\")::int = $1::int, false)"
        );
        assert_eq!(
            render("month(createdAt) ne 1").sql(),
            "extract(month from \"desk_conversations\".\"created_at\")::int IS DISTINCT FROM $1::int"
        );
        assert_eq!(
            render("3 gt day(createdAt)").sql(),
            "COALESCE(extract(day from \"desk_conversations\".\"created_at\")::int < $1::int, false)"
        );
        assert_eq!(
            render("year(createdAt) eq null").sql(),
            "\"desk_conversations\".\"created_at\" IS NULL"
        );
        let any = render("tags/any(t: t eq 'vip')");
        assert_eq!(
            any.sql(),
            "COALESCE(\"desk_conversations\".\"tags\" @> jsonb_build_array($1::text), false)"
        );
        assert_eq!(any.params(), [text("vip")]);
    }

    #[test]
    fn identifiers_and_expressions_come_from_the_catalogue() {
        let agents = find_entity_set("Agents").expect("the set");
        assert_eq!(
            render_on(agents, "createdAt ge 2026-01-01T00:00:00Z").sql(),
            "COALESCE((\"workspace_members\".\"created_at\" AT TIME ZONE 'UTC') >= $1::timestamp, false)"
        );
        assert_eq!(
            render_on(agents, "isActive eq true").sql(),
            "COALESCE((status = 'ACTIVE') = $1::boolean, false)"
        );
        let messages = find_entity_set("Messages").expect("the set");
        let event = render_on(messages, "eventType eq 'closed'");
        assert_eq!(
            event.sql(),
            "COALESCE((metadata->>'eventType') = $1::text, false)"
        );
        assert_eq!(event.params(), [text("closed")]);
    }

    #[test]
    fn a_hostile_literal_is_bound_and_never_reaches_the_text() {
        let attacks = [
            "x'; DROP TABLE desk_conversations; --",
            "' OR '1'='1",
            "\\'; DELETE FROM desk_conversations; --",
            "' OR title LIKE '",
            "${1+1}",
            "$1::text) OR (1=1",
            "\"desk_conversations\"; DROP TABLE x",
            "%_\\",
            "😀\u{2028}\n",
        ];
        for attack in attacks {
            let quoted = format!("'{}'", attack.replace('\'', "''"));
            for filter in [
                format!("state eq {quoted}"),
                format!("contains(title,{quoted})"),
                format!("startswith(title,{quoted})"),
                format!("tags/any(t: t eq {quoted})"),
                format!("title ne {quoted} and state eq 'a'"),
                format!("not ({quoted} eq title or email gt {quoted})"),
            ] {
                let statement = render(&filter);
                assert_only_catalogue_text(&statement);
                for word in ["DROP", "DELETE", "1=1", "1+1", "OR title", "--", "😀"] {
                    assert!(!statement.sql().contains(word), "{filter}: {word}");
                }
                let bound = statement.params().iter().any(|param| {
                    matches!(param, Param::Text(value)
                        if value.contains(attack) || value.contains(&escape_like(attack)))
                });
                assert!(bound, "{filter}");
            }
        }
        // A NUL never becomes a parameter: Postgres would refuse the statement.
        for filter in [
            "state eq '\0'",
            "contains(title,'a\0')",
            "tags/any(t: t eq '\0b')",
        ] {
            assert!(parse_filter(filter, conversations()).is_err(), "{filter:?}");
        }
    }

    #[test]
    fn every_value_has_its_placeholder() {
        let statement = render(
            "state eq 'a' and (rating gt 1 or contains(title,'b')) and tags/any(t: t eq 'c') \
             and createdAt eq 2026-01-31 and year(updatedAt) le 2026",
        );
        assert_eq!(statement.params().len(), 7);
        assert_only_catalogue_text(&statement);
    }

    #[test]
    fn numbers_take_the_cast_of_their_type() {
        assert_eq!(
            literal_param(EdmType::Int32, &Literal::Int(-7.0)),
            Some((Param::Int(-7), "int"))
        );
        assert_eq!(
            literal_param(EdmType::Int64, &Literal::Int(9_007_199_254_740_991.0)),
            Some((Param::BigInt(9_007_199_254_740_991), "bigint"))
        );
        assert_eq!(
            literal_param(EdmType::Double, &Literal::Double(1.5)),
            Some((Param::Float(1.5), "float8"))
        );
        assert_eq!(
            literal_param(EdmType::Double, &Literal::Int(2.0)),
            Some((Param::Float(2.0), "float8"))
        );
        assert_eq!(literal_param(EdmType::String, &Literal::Null), None);
    }
}
