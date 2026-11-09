//! The Summary and Insights tabs (`services/results.ts`): per-field
//! aggregates of the completed responses, and views, starts, completions,
//! time and drop-off. Aggregates are worked out in memory over at most
//! `FORM_LIMITS.maxExportRows` answers, as the worker does, with
//! JavaScript's arithmetic (`Math.round`, the same order of operations).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::js_number_of;

use crate::common::{Ctx, FormsResult, all, day_of, iso, parse_ms, text};
use crate::counters::Counters;
use crate::engine::js::{js_round, number_value};
use crate::engine::{Block, Field, FieldKind, display_answer, is_answered};
use crate::response_model::{
    Bind, MAX_EXPORT_ROWS, ResponseFilter, VersionInfo, bind_all, field_title, load_versions,
    response_conditions,
};

const LATEST: usize = 20;
const MAX_DISTINCT: usize = 60;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn round1(n: f64) -> f64 {
    js_round(n * 10.0) / 10.0
}

fn round2(n: f64) -> f64 {
    js_round(n * 100.0) / 100.0
}

fn round3(n: f64) -> f64 {
    js_round(n * 1000.0) / 1000.0
}

#[allow(clippy::cast_precision_loss)]
fn percent_of(count: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        round1((count as f64 / total as f64) * 100.0)
    }
}

/// One answer of a field: the response, the raw value, and when.
struct Answered<'a> {
    response_id: &'a str,
    value: &'a Value,
    at: i64,
}

fn latest_item(response_id: &str, value: &str, at: i64) -> Value {
    json!({ "responseId": response_id, "value": value, "submittedAt": iso(at) })
}

/// `[...list].sort((a, b) => b.at - a.at)`: newest first, stable.
fn newest_first<T>(mut list: Vec<T>, at: impl Fn(&T) -> i64) -> Vec<T> {
    list.sort_by_key(|item| std::cmp::Reverse(at(item)));
    list
}

/// A number as JavaScript sees `r.value as number`.
fn num(value: &Value) -> f64 {
    js_number_of(Some(value))
}

#[allow(
    clippy::too_many_lines,
    reason = "one branch per kind of field, as the worker"
)]
#[allow(clippy::cast_precision_loss)]
#[allow(
    clippy::float_cmp,
    reason = "keys compared as a JavaScript Map compares them"
)]
fn summarise_field(field: &Field, rows: &[Answered<'_>]) -> Value {
    let base = |kind: &str| {
        let mut out = Map::new();
        out.insert("kind".to_owned(), json!(kind));
        out.insert("blockId".to_owned(), json!(field.id));
        out.insert("type".to_owned(), json!(field.kind.type_name()));
        out.insert("title".to_owned(), json!(field_title(field)));
        out
    };
    let answered: Vec<&Answered<'_>> = rows
        .iter()
        .filter(|r| is_answered(field, Some(r.value)))
        .collect();
    let n = answered.len();

    if matches!(field.kind, FieldKind::Nps(_)) {
        let mut counts: Vec<(f64, usize)> = Vec::new();
        for r in &answered {
            let value = num(r.value);
            match counts.iter_mut().find(|(v, _)| *v == value) {
                Some((_, c)) => *c += 1,
                None => counts.push((value, 1)),
            }
        }
        let promoters = answered.iter().filter(|r| num(r.value) >= 9.0).count();
        let detractors = answered.iter().filter(|r| num(r.value) <= 6.0).count();
        let mut out = base("nps");
        out.insert("answered".to_owned(), json!(n));
        out.insert(
            "score".to_owned(),
            if n == 0 {
                Value::Null
            } else {
                number_value(js_round(
                    ((promoters as f64 - detractors as f64) / n as f64) * 100.0,
                ))
            },
        );
        out.insert("promoters".to_owned(), json!(promoters));
        out.insert("passives".to_owned(), json!(n - promoters - detractors));
        out.insert("detractors".to_owned(), json!(detractors));
        out.insert(
            "distribution".to_owned(),
            Value::Array(
                (0..=10)
                    .map(|value| {
                        let count = counts
                            .iter()
                            .find(|(v, _)| *v == f64::from(value))
                            .map_or(0, |(_, c)| *c);
                        json!({ "value": value, "count": count })
                    })
                    .collect(),
            ),
        );
        return Value::Object(out);
    }
    if field.kind.is_numeric() {
        let values: Vec<f64> = answered.iter().map(|r| num(r.value)).collect();
        let mut counts: Vec<(f64, usize)> = Vec::new();
        for v in &values {
            match counts.iter_mut().find(|(k, _)| k == v) {
                Some((_, c)) => *c += 1,
                None => counts.push((*v, 1)),
            }
        }
        counts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let distribution: Vec<Value> = counts
            .iter()
            .map(|(value, count)| json!({ "value": number_value(*value), "count": count }))
            .collect();
        let sum = values.iter().fold(0.0, |a, b| a + b);
        let mut out = base("numeric");
        out.insert("answered".to_owned(), json!(n));
        out.insert(
            "average".to_owned(),
            if n == 0 {
                Value::Null
            } else {
                number_value(round2(sum / n as f64))
            },
        );
        out.insert(
            "min".to_owned(),
            if n == 0 {
                Value::Null
            } else {
                number_value(values.iter().copied().fold(f64::INFINITY, f64::min))
            },
        );
        out.insert(
            "max".to_owned(),
            if n == 0 {
                Value::Null
            } else {
                number_value(values.iter().copied().fold(f64::NEG_INFINITY, f64::max))
            },
        );
        out.insert(
            "distribution".to_owned(),
            Value::Array(if distribution.len() <= MAX_DISTINCT {
                distribution
            } else {
                Vec::new()
            }),
        );
        return Value::Object(out);
    }
    if field.kind.is_boolean() {
        let yes = answered
            .iter()
            .filter(|r| *r.value == Value::Bool(true))
            .count();
        let mut out = base("boolean");
        out.insert("answered".to_owned(), json!(n));
        out.insert("yes".to_owned(), json!(yes));
        out.insert("no".to_owned(), json!(n - yes));
        return Value::Object(out);
    }
    if field.kind.is_choice() {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut others: Vec<(&str, &Value, i64)> = Vec::new();
        for r in &answered {
            if let Some(ids) = r.value["choiceIds"].as_array() {
                for id in ids {
                    *counts
                        .entry(crate::response_model::js_string(id))
                        .or_default() += 1;
                }
            }
            if let Some(other) = r.value.get("other") {
                others.push((r.response_id, other, r.at));
            }
        }
        let other_count = others.len();
        let latest: Vec<Value> = newest_first(others, |o| o.2)
            .into_iter()
            .take(LATEST)
            .map(|(id, value, at)| latest_item(id, &crate::response_model::js_string(value), at))
            .collect();
        let mut out = base("choice");
        out.insert("answered".to_owned(), json!(n));
        out.insert(
            "choices".to_owned(),
            Value::Array(
                field
                    .choices()
                    .iter()
                    .map(|c| {
                        let count = counts.get(&c.id).copied().unwrap_or(0);
                        json!({
                            "id": c.id,
                            "label": c.label,
                            "count": count,
                            "percent": number_value(percent_of(count, n)),
                        })
                    })
                    .collect(),
            ),
        );
        out.insert("other".to_owned(), json!(other_count));
        out.insert("otherLatest".to_owned(), Value::Array(latest));
        return Value::Object(out);
    }
    if let FieldKind::Ranking(_) = field.kind {
        let mut sums: HashMap<String, (f64, f64)> = HashMap::new();
        for r in &answered {
            if let Some(ids) = r.value.as_array() {
                for (index, id) in ids.iter().enumerate() {
                    let entry = sums
                        .entry(crate::response_model::js_string(id))
                        .or_insert((0.0, 0.0));
                    entry.0 += index as f64 + 1.0;
                    entry.1 += 1.0;
                }
            }
        }
        let mut out = base("ranking");
        out.insert("answered".to_owned(), json!(n));
        out.insert(
            "choices".to_owned(),
            Value::Array(
                field
                    .choices()
                    .iter()
                    .map(|c| {
                        let average = sums.get(&c.id).map_or(Value::Null, |(total, count)| {
                            number_value(round2(total / count))
                        });
                        json!({ "id": c.id, "label": c.label, "averageRank": average })
                    })
                    .collect(),
            ),
        );
        return Value::Object(out);
    }
    if let FieldKind::Matrix(props) = &field.kind {
        let mut cells: HashMap<String, Map<String, Value>> = HashMap::new();
        for r in &answered {
            if let Some(rows) = r.value.as_object() {
                for (row_id, column_ids) in rows {
                    let row = cells.entry(row_id.clone()).or_default();
                    for column in column_ids.as_array().into_iter().flatten() {
                        let key = crate::response_model::js_string(column);
                        let next = row.get(&key).and_then(Value::as_i64).unwrap_or(0) + 1;
                        row.insert(key, json!(next));
                    }
                }
            }
        }
        let mut out = base("matrix");
        out.insert("answered".to_owned(), json!(n));
        out.insert(
            "columns".to_owned(),
            Value::Array(
                props
                    .columns
                    .iter()
                    .map(|c| json!({ "id": c.id, "label": c.label }))
                    .collect(),
            ),
        );
        out.insert(
            "rows".to_owned(),
            Value::Array(
                props
                    .rows
                    .iter()
                    .map(|row| {
                        json!({
                            "id": row.id,
                            "label": row.label,
                            "counts": cells.get(&row.id).cloned().unwrap_or_default(),
                        })
                    })
                    .collect(),
            ),
        );
        return Value::Object(out);
    }
    if field.kind.is_file() {
        let signature = matches!(field.kind, FieldKind::Signature(_));
        let files: usize = answered
            .iter()
            .map(|r| {
                if signature {
                    1
                } else {
                    r.value.as_array().map_or(0, Vec::len)
                }
            })
            .sum();
        let mut out = base("files");
        out.insert("answered".to_owned(), json!(n));
        out.insert("files".to_owned(), json!(files));
        return Value::Object(out);
    }
    // Text, dates, contact info, address.
    let newest = newest_first(answered, |r| r.at);
    let mut out = base("text");
    out.insert("answered".to_owned(), json!(n));
    out.insert(
        "latest".to_owned(),
        Value::Array(
            newest
                .iter()
                .take(LATEST)
                .map(|r| latest_item(r.response_id, &display_answer(field, Some(r.value)), r.at))
                .collect(),
        ),
    );
    Value::Object(out)
}

/// `summarise(ctx, formId, query)`: per field of the form (every version,
/// the newest definition of each), over the completed responses.
#[allow(clippy::cast_precision_loss)]
pub(crate) async fn summarise(
    ctx: &Ctx,
    form_id: &str,
    version_id: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> FormsResult<Value> {
    let versions = load_versions(&ctx.db, form_id).await?;
    let scope: Vec<&VersionInfo> = versions
        .iter()
        .filter(|v| version_id.is_none_or(|id| v.id == id))
        .collect();
    // In order of first appearance, each as its newest definition.
    let mut order: Vec<String> = Vec::new();
    let mut fields: HashMap<String, Field> = HashMap::new();
    for version in &scope {
        for field in &version.fields {
            if !fields.contains_key(&field.id) {
                order.push(field.id.clone());
            }
            fields.insert(field.id.clone(), field.clone());
        }
    }
    let filter = ResponseFilter {
        status: Some("completed".to_owned()),
        from: from.map(str::to_owned),
        to: to.map(str::to_owned),
        version_id: version_id.map(str::to_owned),
        ..ResponseFilter::default()
    };
    let mut w = response_conditions(form_id, &filter, &fields)?;
    let limit = w.param(Bind::Int(MAX_EXPORT_ROWS));
    let sql = format!(
        "select jsonb_build_object('id', id, 'answers', answers, 'submitted_at', submitted_at, \
         'started_at', started_at, 'score', score) from form_responses where {} \
         order by submitted_at desc limit {limit}",
        w.sql()
    );
    let rows = all(
        &ctx.db,
        bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql)), &w.binds),
    )
    .await?;

    let scores: Vec<f64> = rows.iter().filter_map(|r| r["score"].as_f64()).collect();
    let at_of = |row: &Value| {
        row["submittedAt"]
            .as_str()
            .or_else(|| row["startedAt"].as_str())
            .and_then(parse_ms)
            .unwrap_or_default()
    };
    let mut summaries = Vec::with_capacity(order.len());
    for id in &order {
        let Some(field) = fields.get(id) else {
            continue;
        };
        let answered: Vec<Answered<'_>> = rows
            .iter()
            .filter_map(|row| {
                row["answers"].get(&field.id).map(|value| Answered {
                    response_id: text(row, "id"),
                    value,
                    at: at_of(row),
                })
            })
            .collect();
        summaries.push(summarise_field(field, &answered));
    }
    let average = if scores.is_empty() {
        Value::Null
    } else {
        let sum = scores.iter().fold(0.0, |a, b| a + b);
        number_value(round2(sum / scores.len() as f64))
    };
    Ok(json!({
        "totalResponses": rows.len(),
        "averageScore": average,
        "fields": summaries,
    }))
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/// `bump(day, key, by)`: one of a day's counts (views, starts, completions).
fn bump(days: &mut Vec<(String, [i64; 3])>, day: String, slot: usize, by: i64) {
    if let Some((_, counts)) = days.iter_mut().find(|(d, _)| *d == day) {
        counts[slot] += by;
    } else {
        let mut counts = [0; 3];
        counts[slot] = by;
        days.push((day, counts));
    }
}

/// `stops(version)`: the top-level blocks a respondent can leave on.
fn stops(version: &VersionInfo) -> Vec<(String, String)> {
    version
        .definition
        .blocks
        .iter()
        .filter_map(|block| {
            let (id, title, r#ref) = match block {
                Block::Field(field) => (&field.id, &field.title, &field.r#ref),
                Block::Group(group) => (&group.id, &group.title, &group.r#ref),
                Block::Statement(_) | Block::PageBreak(_) => return None,
            };
            let title = if title.is_empty() { r#ref } else { title };
            Some((id.clone(), title.clone()))
        })
        .collect()
}

/// `insights(ctx, formId, counters, range, now)`: views per day from the
/// form's counters, the rest from the responses started in the range.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
#[allow(clippy::cast_precision_loss)]
pub(crate) async fn insights(
    ctx: &Ctx,
    form_id: &str,
    counters: &Counters,
    from: Option<&str>,
    to: Option<&str>,
) -> FormsResult<Value> {
    let now = ctx.now_ms();
    let to = to.and_then(parse_ms).unwrap_or(now);
    let from = from.and_then(parse_ms).unwrap_or(to - 29 * DAY_MS);
    let versions = load_versions(&ctx.db, form_id).await?;
    let latest = versions.last();

    let rows = all(
        &ctx.db,
        sqlx::query_scalar(
            "select jsonb_build_object('status', status, 'started_at', started_at, 'submitted_at', submitted_at, \
             'duration_ms', duration_ms, 'last_block_id', last_block_id, 'source', metadata ->> 'source') \
             from form_responses where form_id = $1 and started_at >= $2::timestamptz and started_at <= $3::timestamptz",
        )
        .bind(form_id)
        .bind(iso(from))
        .bind(iso(to)),
    )
    .await?;

    // Every UTC day of the range, prefilled (`views`, `starts`, `completions`).
    let mut days: Vec<(String, [i64; 3])> = Vec::new();
    let mut t = from.div_euclid(DAY_MS) * DAY_MS;
    let mut range_days = Vec::new();
    while t <= to {
        range_days.push(day_of(t));
        days.push((day_of(t), [0; 3]));
        t += DAY_MS;
    }
    // `viewsByDay(dayOf(from), dayOf(to))`.
    let views = counters.views_by_day(&range_days).await?;
    for (day, count) in &views {
        bump(&mut days, day.clone(), 0, *count);
    }
    let completed: Vec<&Value> = rows
        .iter()
        .filter(|r| text(r, "status") == "completed")
        .collect();
    for r in &rows {
        if let Some(at) = r["startedAt"].as_str().and_then(parse_ms) {
            bump(&mut days, day_of(at), 1, 1);
        }
    }
    for r in &completed {
        if let Some(at) = r["submittedAt"].as_str().and_then(parse_ms) {
            bump(&mut days, day_of(at), 2, 1);
        }
    }

    let durations: Vec<f64> = completed
        .iter()
        .filter_map(|r| r["durationMs"].as_f64())
        .collect();
    let mut by_source: Vec<(String, i64, i64)> = Vec::new();
    for r in &rows {
        let key = r["source"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("link")
            .to_owned();
        let done = i64::from(text(r, "status") == "completed");
        match by_source.iter_mut().find(|(s, _, _)| *s == key) {
            Some((_, starts, completions)) => {
                *starts += 1;
                *completions += done;
            }
            None => by_source.push((key, 1, done)),
        }
    }
    by_source.sort_by_key(|(_, starts, _)| std::cmp::Reverse(*starts));

    let blocks = latest.map(stops).unwrap_or_default();
    let mut left_at: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        if text(r, "status") == "in_progress"
            && let Some(block) = r["lastBlockId"].as_str().filter(|b| !b.is_empty())
        {
            *left_at.entry(block.to_owned()).or_default() += 1;
        }
    }
    let drop_off: Vec<Value> = blocks
        .iter()
        .enumerate()
        .map(|(index, (id, title))| {
            let beyond: usize = blocks[index..]
                .iter()
                .map(|(b, _)| left_at.get(b).copied().unwrap_or(0))
                .sum();
            let reached = completed.len() + beyond;
            let left_here = left_at.get(id).copied().unwrap_or(0);
            let rate = if reached == 0 {
                0.0
            } else {
                round3(left_here as f64 / reached as f64)
            };
            json!({
                "blockId": id,
                "title": title,
                "reached": reached,
                "leftHere": left_here,
                "dropOffRate": number_value(rate),
            })
        })
        .collect();

    days.sort_by(|a, b| a.0.cmp(&b.0));
    let views_total: i64 = views.iter().map(|(_, c)| c).sum();
    let average_duration = if durations.is_empty() {
        Value::Null
    } else {
        let sum = durations.iter().fold(0.0, |a, b| a + b);
        number_value(js_round(sum / durations.len() as f64))
    };
    Ok(json!({
        "views": views_total,
        "starts": rows.len(),
        "completions": completed.len(),
        "completionRate": if rows.is_empty() {
            Value::Null
        } else {
            number_value(round3(completed.len() as f64 / rows.len() as f64))
        },
        "averageDurationMs": average_duration,
        "byDay": days
            .iter()
            .map(|(date, [views, starts, completions])| {
                json!({ "date": date, "views": views, "starts": starts, "completions": completions })
            })
            .collect::<Vec<_>>(),
        "dropOff": drop_off,
        "bySource": by_source
            .iter()
            .map(|(source, starts, completions)| {
                json!({ "source": source, "starts": starts, "completions": completions })
            })
            .collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::js::number_text;

    #[test]
    fn rounding_matches_javascript() {
        assert_eq!(percent_of(1, 3), 33.3);
        assert_eq!(percent_of(2, 3), 66.7);
        assert_eq!(round2(11.0 / 3.0), 3.67);
        assert_eq!(round3(0.5), 0.5);
        assert_eq!(number_text(round2(4.0)), "4");
        assert_eq!(js_round(((2.0 - 1.0) / 3.0) * 100.0), 33.0);
    }
}
