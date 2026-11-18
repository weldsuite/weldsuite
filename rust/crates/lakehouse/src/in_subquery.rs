//! `x [NOT] IN (SELECT …)` where DataFusion 54 can't run it, without
//! changing the SQL the compiler sends.
//!
//! The compiler's cohort filters are `<person> IN (SELECT …)`: several under
//! one `OR` (a cohort matching any of its conditions), under `NOT (… AND …)`
//! (a negated cohort), or inside an aggregate's argument (a series filter:
//! `COUNT(DISTINCT CASE WHEN … AND <person> IN (SELECT …) THEN … END)`).
//! DataFusion 54 has two gaps there:
//!
//! - **An `IN` the optimizer mark-joins, whose subquery ends in a computed
//!   group key** (`SELECT COALESCE(i.user_id, e.distinct_id) … GROUP BY
//!   COALESCE(…) HAVING …`). For an `IN` inside a filter's conjunct
//!   (under `OR`, `NOT (… AND …)`), `decorrelate_predicate_subquery` builds a
//!   left mark join and projects the right side to the columns its
//!   predicates use. That subquery's head expression is an *unqualified*
//!   column named like its own output (`coalesce(i.user_id,e.distinct_id)`),
//!   which resolves against the right side as well as the qualified column
//!   the join filter names, so the projection lists one field twice:
//!   "Projections require unique expression names". Fix: such a subquery
//!   gets a projection on top naming its one column [`IN_VALUE`]; the head
//!   expression is then that alias, which resolves by its new name only. An
//!   `IN` that is a whole conjunct becomes a semi or anti join instead, with
//!   no such projection, and is left alone.
//! - **An `IN` inside an aggregate or a projection.** Only filters are
//!   decorrelated; anywhere else the `InSubquery` reaches the physical
//!   planner ("Physical plan does not support logical expression
//!   `InSubquery`"). Fix: the node's input gets a left mark join per
//!   (uncorrelated) subquery, as the optimizer builds for a filter, and the
//!   expression reads the mark. A mark is two-valued, so where the compared
//!   value or the subquery's column can be null the expression is made
//!   SQL's three-valued answer with the subquery's row and non-null counts
//!   (a cross join with their one row): `x NOT IN (… NULL …)` is never true.
//!   The compiler compares person ids, which are never null, so its
//!   statements get the plain mark.
//!
//! Correlated subqueries and `EXISTS` are left as they were. It is an
//! analyzer rule: it runs once, after type coercion and before every
//! optimizer rule, so `decorrelate_predicate_subquery` sees the named
//! subqueries. Plans without such an `IN` don't change.

use std::sync::Arc;

use datafusion::common::alias::AliasGenerator;
use datafusion::common::config::ConfigOptions;
use datafusion::common::tree_node::{Transformed, TreeNode, TreeNodeRecursion};
use datafusion::common::{Column, Result, ScalarValue};
use datafusion::functions_aggregate::expr_fn::count;
use datafusion::logical_expr::expr::InSubquery;
use datafusion::logical_expr::expr_rewriter::NamePreserver;
use datafusion::logical_expr::utils::{conjunction, split_conjunction_owned};
use datafusion::logical_expr::{
    Aggregate, Expr, ExprSchemable, Filter, JoinType, LogicalPlan, LogicalPlanBuilder, Projection,
    Subquery, lit, when,
};
use datafusion::optimizer::AnalyzerRule;

/// The name a mark-joined subquery's one column gets when its head
/// expression holds an unqualified column.
pub(crate) const IN_VALUE: &str = "__weldsuite_in_value";

/// Prefix of this rule's mark joins' right sides, `__weldsuite_in_1`, …
/// (the optimizer's own are `__correlated_sq_N`).
const MARK_ALIAS: &str = "__weldsuite_in";

/// Prefix of the three-valued form's counts, `__weldsuite_in_stats_1`, ….
const STATS_ALIAS: &str = "__weldsuite_in_stats";

/// Names mark-joined `IN` subqueries and decorrelates the `IN`s in
/// aggregates and projections (see the module).
#[derive(Debug, Default)]
pub(crate) struct InSubqueryMarks;

impl AnalyzerRule for InSubqueryMarks {
    fn analyze(&self, plan: LogicalPlan, _config: &ConfigOptions) -> Result<LogicalPlan> {
        let aliases = AliasGenerator::new();
        plan.transform_up_with_subqueries(|node| rewrite(node, &aliases))
            .map(|rewritten| rewritten.data)
    }

    fn name(&self) -> &'static str {
        "weldsuite_in_subquery_marks"
    }
}

fn rewrite(node: LogicalPlan, aliases: &AliasGenerator) -> Result<Transformed<LogicalPlan>> {
    match node {
        LogicalPlan::Filter(filter) => name_embedded(filter),
        LogicalPlan::Aggregate(_) | LogicalPlan::Projection(_) if has_in_subquery(&node)? => {
            mark_joins(node, aliases)
        }
        other => Ok(Transformed::no(other)),
    }
}

/// Whether `decorrelate_predicate_subquery` takes this conjunct of a filter
/// whole, as a semi or anti join: `[NOT] x IN (…)` or `[NOT] EXISTS (…)` on
/// its own (its `extract_subquery_info`).
fn is_whole_conjunct(conjunct: &Expr) -> bool {
    match conjunct {
        Expr::Not(inner) => matches!(inner.as_ref(), Expr::InSubquery(_) | Expr::Exists(_)),
        Expr::InSubquery(_) | Expr::Exists(_) => true,
        _ => false,
    }
}

/// The first fix, on the `IN`s inside a filter's conjuncts (the ones the
/// optimizer mark-joins).
fn name_embedded(filter: Filter) -> Result<Transformed<LogicalPlan>> {
    let mut named_any = false;
    let conjuncts = split_conjunction_owned(filter.predicate.clone())
        .into_iter()
        .map(|conjunct| {
            if is_whole_conjunct(&conjunct) {
                return Ok(conjunct);
            }
            let named = conjunct.transform_up(name_subquery_value)?;
            named_any |= named.transformed;
            Ok(named.data)
        })
        .collect::<Result<Vec<_>>>()?;
    let Some(predicate) = conjunction(conjuncts).filter(|_| named_any) else {
        return Ok(Transformed::no(LogicalPlan::Filter(filter)));
    };
    Ok(Transformed::yes(LogicalPlan::Filter(Filter::try_new(
        predicate,
        filter.input,
    )?)))
}

/// Whether `expr` holds a column without a table qualifier.
fn has_unqualified_column(expr: &Expr) -> bool {
    expr.column_refs()
        .iter()
        .any(|column| column.relation.is_none())
}

/// An `IN` whose subquery's head expression holds an unqualified column,
/// with that subquery's one column named [`IN_VALUE`].
fn name_subquery_value(expr: Expr) -> Result<Transformed<Expr>> {
    let Expr::InSubquery(in_subquery) = expr else {
        return Ok(Transformed::no(expr));
    };
    let plan = &in_subquery.subquery.subquery;
    let needs_name = plan
        .head_output_expr()?
        .is_some_and(|head| has_unqualified_column(&head));
    if !needs_name || plan.schema().fields().len() != 1 {
        return Ok(Transformed::no(Expr::InSubquery(in_subquery)));
    }
    let InSubquery {
        expr,
        subquery,
        negated,
    } = in_subquery;
    let value = Expr::Column(Column::from(subquery.subquery.schema().qualified_field(0)));
    let named = Projection::try_new(vec![value.alias(IN_VALUE)], subquery.subquery)?;
    Ok(Transformed::yes(Expr::InSubquery(InSubquery {
        expr,
        subquery: Subquery {
            subquery: Arc::new(LogicalPlan::Projection(named)),
            ..subquery
        },
        negated,
    })))
}

/// Whether one of the node's own expressions (not its subqueries' plans)
/// holds an `IN (SELECT …)`.
fn has_in_subquery(node: &LogicalPlan) -> Result<bool> {
    let mut found = false;
    node.apply_expressions(|expr| {
        expr.apply(|inner| {
            found |= matches!(inner, Expr::InSubquery(_));
            Ok(if found {
                TreeNodeRecursion::Stop
            } else {
                TreeNodeRecursion::Continue
            })
        })
    })?;
    Ok(found)
}

/// The second fix: every uncorrelated `IN (SELECT …)` in an aggregate's or
/// a projection's expressions becomes a mark join below it. The node's
/// output names stay as they were.
fn mark_joins(node: LogicalPlan, aliases: &AliasGenerator) -> Result<Transformed<LogicalPlan>> {
    let Some(input) = node.inputs().first().map(|input| (*input).clone()) else {
        return Ok(Transformed::no(node));
    };
    let names = NamePreserver::new(&node);
    let mut joined = input;
    let rewritten = node.map_expressions(|expr| {
        let name = names.save(&expr);
        let rewritten = expr.transform_up(|inner| match inner {
            Expr::InSubquery(in_subquery) if in_subquery.subquery.outer_ref_columns.is_empty() => {
                let (plan, value) = mark_join(joined.clone(), in_subquery, aliases)?;
                joined = plan;
                Ok(Transformed::yes(value))
            }
            other => Ok(Transformed::no(other)),
        })?;
        Ok(rewritten.update_data(|expr| name.restore(expr)))
    })?;
    if !rewritten.transformed {
        return Ok(rewritten);
    }
    let input = Arc::new(joined);
    let plan = match rewritten.data {
        LogicalPlan::Aggregate(aggregate) => LogicalPlan::Aggregate(Aggregate::try_new(
            input,
            aggregate.group_expr,
            aggregate.aggr_expr,
        )?),
        LogicalPlan::Projection(projection) => {
            LogicalPlan::Projection(Projection::try_new(projection.expr, input)?)
        }
        other => return Ok(Transformed::no(other)),
    };
    Ok(Transformed::yes(plan))
}

/// `input` left-mark-joined with the subquery on `expr = <its column>`, and
/// the boolean that stands for the `IN`: the mark where neither side can be
/// null, SQL's three-valued answer otherwise.
fn mark_join(
    input: LogicalPlan,
    in_subquery: InSubquery,
    aliases: &AliasGenerator,
) -> Result<(LogicalPlan, Expr)> {
    let InSubquery {
        expr,
        subquery,
        negated,
    } = in_subquery;
    let values = Arc::unwrap_or_clone(subquery.subquery);
    let alias = aliases.next(MARK_ALIAS);
    let right = LogicalPlanBuilder::from(values.clone())
        .alias(alias.as_str())?
        .build()?;
    let (qualifier, field) = right.schema().qualified_field(0);
    let value = Expr::Column(Column::from((qualifier, field)));
    let nullable = field.is_nullable() || expr.nullable(input.schema())?;
    let joined = LogicalPlanBuilder::from(input)
        .join_on(right, JoinType::LeftMark, [expr.as_ref().clone().eq(value)])?
        .build()?;
    let mark = Expr::Column(Column::new(Some(alias), "mark"));
    if !nullable {
        return Ok((joined, if negated { !mark } else { mark }));
    }

    // x IN S: true on a match; false when S is empty; null when x is null
    // or S holds a null; false otherwise. NOT IN is its negation.
    let stats_alias = aliases.next(STATS_ALIAS);
    let column = Expr::Column(Column::from(values.schema().qualified_field(0)));
    let stats = LogicalPlanBuilder::from(values)
        .aggregate(
            Vec::<Expr>::new(),
            [
                count(lit(1_i64)).alias("rows"),
                count(column).alias("values"),
            ],
        )?
        .alias(stats_alias.as_str())?
        .build()?;
    let joined = LogicalPlanBuilder::from(joined)
        .cross_join(stats)?
        .build()?;
    let rows = Expr::Column(Column::new(Some(stats_alias.as_str()), "rows"));
    let non_null = Expr::Column(Column::new(Some(stats_alias.as_str()), "values"));
    let answer = when(mark, lit(true))
        .when(rows.clone().eq(lit(0_i64)), lit(false))
        .when(
            expr.is_null().or(rows.gt(non_null)),
            lit(ScalarValue::Boolean(None)),
        )
        .otherwise(lit(false))?;
    Ok((joined, if negated { !answer } else { answer }))
}

#[cfg(test)]
mod tests {
    use datafusion::arrow::array::{RecordBatch, StringArray};
    use datafusion::arrow::datatypes::{DataType, Field, Schema};
    use datafusion::arrow::util::pretty::pretty_format_batches;
    use datafusion::datasource::MemTable;
    use datafusion::execution::session_state::SessionStateBuilder;
    use datafusion::prelude::SessionContext;

    use super::*;

    /// `e(id, person, anon)`: people p1…p4 and two anonymous events
    /// (person null); `c(person)`: p1, p2; `n(person)`: p1 and a null.
    fn context(with_rule: bool) -> SessionContext {
        let mut builder = SessionStateBuilder::new().with_default_features();
        if with_rule {
            builder = builder.with_analyzer_rule(Arc::new(InSubqueryMarks));
        }
        let ctx = SessionContext::new_with_state(builder.build());
        let text = |name: &str, nullable: bool| Field::new(name, DataType::Utf8, nullable);
        let table = |fields: Vec<Field>, columns: Vec<Vec<Option<&str>>>| {
            let schema = Arc::new(Schema::new(fields));
            let columns = columns
                .into_iter()
                .map(|values| Arc::new(StringArray::from(values)) as _)
                .collect();
            let batch = RecordBatch::try_new(Arc::clone(&schema), columns).expect("a batch");
            Arc::new(MemTable::try_new(schema, vec![vec![batch]]).expect("a table"))
        };
        let events = table(
            vec![text("id", false), text("person", true), text("anon", false)],
            vec![
                vec![
                    Some("1"),
                    Some("2"),
                    Some("3"),
                    Some("4"),
                    Some("5"),
                    Some("6"),
                ],
                vec![Some("p1"), Some("p2"), Some("p3"), Some("p4"), None, None],
                vec![
                    Some("a1"),
                    Some("a2"),
                    Some("a3"),
                    Some("a4"),
                    Some("a5"),
                    Some("p3"),
                ],
            ],
        );
        let cohort = table(
            vec![text("person", false)],
            vec![vec![Some("p1"), Some("p2")]],
        );
        let with_null = table(vec![text("person", true)], vec![vec![Some("p1"), None]]);
        ctx.register_table("e", events).expect("e");
        ctx.register_table("c", cohort).expect("c");
        ctx.register_table("n", with_null).expect("n");
        ctx
    }

    async fn rows(ctx: &SessionContext, sql: &str) -> Result<Vec<String>> {
        let batches = ctx.sql(sql).await?.collect().await?;
        let text = pretty_format_batches(&batches)?.to_string();
        let mut rows: Vec<String> = text
            .lines()
            .filter(|line| line.starts_with('|'))
            .skip(1)
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        rows.sort();
        Ok(rows)
    }

    /// A computed, grouped subquery head (unqualified), under `OR`.
    const GROUPED_UNDER_OR: &str = "SELECT x.id FROM e x WHERE x.id = '6' \
        OR COALESCE(x.person, x.anon) IN (SELECT COALESCE(y.person, y.anon) FROM e y \
        GROUP BY COALESCE(y.person, y.anon) HAVING COUNT(*) >= 2) \
        OR COALESCE(x.person, x.anon) NOT IN (SELECT COALESCE(z.person, z.anon) FROM e z \
        WHERE z.id <> '1' GROUP BY COALESCE(z.person, z.anon))";

    #[tokio::test]
    async fn runs_an_in_on_a_computed_group_key_under_or() {
        assert!(
            rows(&context(false), GROUPED_UNDER_OR).await.is_err(),
            "DataFusion runs this now: drop the naming half of the rule"
        );
        // p3 is counted twice (event 3, and event 6's anon); p1 is in no
        // group but event 1 is excluded from the NOT IN's.
        assert_eq!(
            rows(&context(true), GROUPED_UNDER_OR).await.expect("runs"),
            ["| 1 |", "| 3 |", "| 6 |"]
        );
    }

    #[tokio::test]
    async fn decorrelates_an_in_inside_an_aggregate() {
        let sql = "SELECT COUNT(DISTINCT CASE WHEN e.anon <> 'a4' AND COALESCE(e.person, e.anon) IN (SELECT c.person FROM c) THEN e.id END) AS a, \
                   COUNT(CASE WHEN e.id NOT IN (SELECT c.person FROM c) THEN 1 END) AS b FROM e";
        assert!(
            rows(&context(false), sql).await.is_err(),
            "DataFusion runs this now: drop the mark-join half of the rule"
        );
        assert_eq!(
            rows(&context(true), sql).await.expect("runs"),
            ["| 2 | 6 |"]
        );
        let grouped = "SELECT e.anon, COUNT(CASE WHEN e.person IN (SELECT c.person FROM c) THEN 1 END) AS n \
                       FROM e GROUP BY e.anon ORDER BY e.anon";
        assert_eq!(
            rows(&context(true), grouped).await.expect("runs"),
            [
                "| a1 | 1 |",
                "| a2 | 1 |",
                "| a3 | 0 |",
                "| a4 | 0 |",
                "| a5 | 0 |",
                "| p3 | 0 |"
            ]
        );
    }

    #[tokio::test]
    async fn keeps_sql_s_three_valued_in_where_nulls_can_occur() {
        let ctx = context(true);
        // A null in the subquery: NOT IN is never true, IN only on a match.
        let sql = "SELECT COUNT(CASE WHEN e.anon NOT IN (SELECT n.person FROM n) THEN 1 END) AS a, \
                   COUNT(CASE WHEN e.person IN (SELECT n.person FROM n) THEN 1 END) AS b FROM e";
        assert_eq!(rows(&ctx, sql).await.expect("runs"), ["| 0 | 1 |"]);
        // A null on the left: unknown, unless the subquery is empty.
        let projected = "SELECT e.id, e.person IN (SELECT c.person FROM c) AS i, \
                         e.person NOT IN (SELECT c.person FROM c WHERE c.person = 'none') AS o FROM e";
        assert_eq!(
            rows(&ctx, projected).await.expect("runs"),
            [
                "| 1 | true | true |",
                "| 2 | true | true |",
                "| 3 | false | true |",
                "| 4 | false | true |",
                "| 5 | | true |",
                "| 6 | | true |"
            ]
        );
    }

    #[tokio::test]
    async fn leaves_other_plans_alone() {
        for sql in [
            "SELECT e.id FROM e WHERE e.person IN (SELECT c.person FROM c)",
            "SELECT e.id FROM e WHERE e.id = '5' OR e.person IN (SELECT c.person FROM c)",
            "SELECT e.id FROM e WHERE COALESCE(e.person, e.anon) NOT IN \
             (SELECT COALESCE(y.person, y.anon) FROM e y GROUP BY COALESCE(y.person, y.anon))",
        ] {
            let plan = |ctx: SessionContext| async move {
                let frame = ctx.sql(sql).await.expect("plans");
                frame
                    .into_optimized_plan()
                    .expect("optimizes")
                    .display_indent()
                    .to_string()
            };
            assert_eq!(
                plan(context(true)).await,
                plan(context(false)).await,
                "{sql}"
            );
        }
    }

    #[test]
    fn names_only_unqualified_heads() {
        assert!(has_unqualified_column(&Expr::Column(
            Column::new_unqualified("coalesce(e.user_id,e.distinct_id)")
        )));
        assert!(!has_unqualified_column(&Expr::Column(Column::new(
            Some("pl2"),
            "user_id"
        ))));
    }
}
