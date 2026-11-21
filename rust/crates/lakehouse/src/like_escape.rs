//! `LIKE … ESCAPE '!'` on DataFusion 54.
//!
//! The compiler escapes LIKE patterns with `!` (`LIKE_ESCAPE` in
//! `@weldsuite/panel-domain`'s `sql.ts`: engines disagree on backslashes),
//! and DataFusion 54 only runs the backslash: any other escape character is
//! an error when the plan is made physical ("LIKE does not support
//! `escape_char` other than the backslash", apache/datafusion#13291). This
//! optimizer rule, last in the list (after constant folding has turned
//! `'a' || chr(92) || '%'` into one literal), rewrites a literal pattern to
//! the same pattern escaped with backslashes: `c%` → `\%`, `c_` → `\_`,
//! `cc` → `c`, and a literal backslash → `\\`.

use datafusion::common::tree_node::{Transformed, TreeNode};
use datafusion::common::{Result, ScalarValue};
use datafusion::logical_expr::expr::Like;
use datafusion::logical_expr::expr_rewriter::NamePreserver;
use datafusion::logical_expr::{Expr, LogicalPlan};
use datafusion::optimizer::optimizer::ApplyOrder;
use datafusion::optimizer::{OptimizerConfig, OptimizerRule};

/// Rewrites `LIKE p ESCAPE 'c'` (c not a backslash) with a literal `p` to
/// the backslash form DataFusion runs.
#[derive(Debug, Default)]
pub(crate) struct LikeEscapeToBackslash;

impl OptimizerRule for LikeEscapeToBackslash {
    fn name(&self) -> &'static str {
        "weldsuite_like_escape_to_backslash"
    }

    fn apply_order(&self) -> Option<ApplyOrder> {
        Some(ApplyOrder::BottomUp)
    }

    fn rewrite(
        &self,
        plan: LogicalPlan,
        _config: &dyn OptimizerConfig,
    ) -> Result<Transformed<LogicalPlan>> {
        // A rewritten LIKE inside an aggregate would rename its output
        // column, which the nodes above refer to by name: keep the names.
        let names = NamePreserver::new(&plan);
        plan.map_expressions(|expr| {
            let name = names.save(&expr);
            expr.transform_up(|expr| Ok(rewrite_like(expr)))
                .map(|rewritten| rewritten.update_data(|expr| name.restore(expr)))
        })
    }
}

fn rewrite_like(expr: Expr) -> Transformed<Expr> {
    let Expr::Like(like) = expr else {
        return Transformed::no(expr);
    };
    let Some(escape) = like.escape_char.filter(|escape| *escape != '\\') else {
        return Transformed::no(Expr::Like(like));
    };
    let pattern = match like.pattern.as_ref() {
        Expr::Literal(ScalarValue::Utf8(Some(text)), metadata) => Expr::Literal(
            ScalarValue::Utf8(Some(to_backslash(text, escape))),
            metadata.clone(),
        ),
        Expr::Literal(ScalarValue::LargeUtf8(Some(text)), metadata) => Expr::Literal(
            ScalarValue::LargeUtf8(Some(to_backslash(text, escape))),
            metadata.clone(),
        ),
        Expr::Literal(ScalarValue::Utf8View(Some(text)), metadata) => Expr::Literal(
            ScalarValue::Utf8View(Some(to_backslash(text, escape))),
            metadata.clone(),
        ),
        _ => return Transformed::no(Expr::Like(like)),
    };
    Transformed::yes(Expr::Like(Like {
        pattern: Box::new(pattern),
        escape_char: None,
        ..like
    }))
}

/// `pattern`, escaped with `escape`, as the same pattern escaped with `\`.
/// A trailing escape character stays a literal one.
pub(crate) fn to_backslash(pattern: &str, escape: char) -> String {
    let mut out = String::with_capacity(pattern.len() + 2);
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == escape {
            out.push('\\');
            out.push(chars.next().unwrap_or(escape));
        } else if c == '\\' {
            out.push_str("\\\\");
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::to_backslash;

    #[test]
    fn rewrites_the_escape_character() {
        assert_eq!(to_backslash("%50!%!_off%", '!'), "%50\\%\\_off%");
        assert_eq!(to_backslash("a!!b", '!'), "a\\!b");
        assert_eq!(to_backslash("C:\\x%", '!'), "C:\\\\x%");
        assert_eq!(to_backslash("end!", '!'), "end\\!");
    }
}
