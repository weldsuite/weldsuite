//! A query's rows as the JSON Basin SQL answers on Global (`result.rows` of
//! its REST API): one object per row, keyed by the columns' names, so the
//! report code that reads Basin's rows reads these alike
//! (`@weldsuite/panel-domain`'s `normalizeRows`, `toNumber`, `toText`,
//! `toIso`).
//!
//! - integers and floats are JSON numbers (a float that is not finite is
//!   `null`, as JSON has no NaN), decimals too;
//! - text is a string (the `properties` column stays the JSON text it is);
//! - booleans are booleans; a null is an explicit `null`;
//! - timestamps are ISO 8601 (`2026-11-14T10:00:00Z` with a time zone,
//!   without one when the column has none), dates `YYYY-MM-DD`;
//! - lists are arrays and structs objects, recursively;
//! - anything else is its Arrow display text.

use arrow_array::cast::AsArray;
use arrow_array::types::{
    Float16Type, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type, UInt8Type,
    UInt16Type, UInt32Type, UInt64Type,
};
use arrow_array::{Array, ArrayRef, RecordBatch};
use arrow_schema::DataType;
use datafusion::arrow::util::display::{ArrayFormatter, FormatOptions};
use serde_json::{Map, Number, Value};

use crate::error::{LakehouseError, Result};
use crate::query::QueryResult;

impl QueryResult {
    /// The rows as Basin SQL's REST API answers them.
    pub fn json_rows(&self) -> Result<Vec<Value>> {
        json_rows(&self.batches)
    }
}

/// `batches` as one JSON object per row, keyed by the schema's field names.
pub fn json_rows(batches: &[RecordBatch]) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    for batch in batches {
        let schema = batch.schema();
        let columns: Vec<Vec<Value>> = batch.columns().iter().map(values).collect::<Result<_>>()?;
        for index in 0..batch.num_rows() {
            let mut row = Map::new();
            for (field, column) in schema.fields().iter().zip(&columns) {
                row.insert(
                    field.name().clone(),
                    column.get(index).cloned().unwrap_or(Value::Null),
                );
            }
            rows.push(Value::Object(row));
        }
    }
    Ok(rows)
}

fn float(value: f64) -> Value {
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// Every value of one column, nulls as `null`.
#[allow(clippy::too_many_lines, reason = "one arm per Arrow type")]
fn values(column: &ArrayRef) -> Result<Vec<Value>> {
    let len = column.len();
    let each = |read: &dyn Fn(usize) -> Value| -> Vec<Value> {
        (0..len)
            .map(|i| {
                if column.is_null(i) {
                    Value::Null
                } else {
                    read(i)
                }
            })
            .collect()
    };
    let out = match column.data_type() {
        DataType::Null => vec![Value::Null; len],
        DataType::Boolean => {
            let array = column.as_boolean();
            each(&|i| Value::Bool(array.value(i)))
        }
        DataType::Int8 => {
            let array = column.as_primitive::<Int8Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::Int16 => {
            let array = column.as_primitive::<Int16Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::Int32 => {
            let array = column.as_primitive::<Int32Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::Int64 => {
            let array = column.as_primitive::<Int64Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::UInt8 => {
            let array = column.as_primitive::<UInt8Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::UInt16 => {
            let array = column.as_primitive::<UInt16Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::UInt32 => {
            let array = column.as_primitive::<UInt32Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::UInt64 => {
            let array = column.as_primitive::<UInt64Type>();
            each(&|i| Value::from(array.value(i)))
        }
        DataType::Float16 => {
            let array = column.as_primitive::<Float16Type>();
            each(&|i| float(f64::from(array.value(i))))
        }
        DataType::Float32 => {
            let array = column.as_primitive::<Float32Type>();
            each(&|i| float(f64::from(array.value(i))))
        }
        DataType::Float64 => {
            let array = column.as_primitive::<Float64Type>();
            each(&|i| float(array.value(i)))
        }
        DataType::Utf8 => {
            let array = column.as_string::<i32>();
            each(&|i| Value::String(array.value(i).to_owned()))
        }
        DataType::LargeUtf8 => {
            let array = column.as_string::<i64>();
            each(&|i| Value::String(array.value(i).to_owned()))
        }
        DataType::Utf8View => {
            let array = column.as_string_view();
            each(&|i| Value::String(array.value(i).to_owned()))
        }
        DataType::Decimal128(..) | DataType::Decimal256(..) => {
            let text = formatted(column)?;
            each(&|i| {
                text[i]
                    .parse::<f64>()
                    .map_or_else(|_| Value::String(text[i].clone()), float)
            })
        }
        DataType::List(_) => {
            let array = column.as_list::<i32>();
            let items = (0..len)
                .map(|i| {
                    if column.is_null(i) {
                        Ok(Value::Null)
                    } else {
                        values(&array.value(i)).map(Value::Array)
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(items);
        }
        DataType::LargeList(_) => {
            let array = column.as_list::<i64>();
            let items = (0..len)
                .map(|i| {
                    if column.is_null(i) {
                        Ok(Value::Null)
                    } else {
                        values(&array.value(i)).map(Value::Array)
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(items);
        }
        DataType::Struct(fields) => {
            let array = column.as_struct();
            let children: Vec<Vec<Value>> =
                array.columns().iter().map(values).collect::<Result<_>>()?;
            each(&|i| {
                Value::Object(
                    fields
                        .iter()
                        .zip(&children)
                        .map(|(field, child)| (field.name().clone(), child[i].clone()))
                        .collect(),
                )
            })
        }
        // Timestamps (ISO 8601), dates, times, intervals, binary: Arrow's text.
        _ => {
            let text = formatted(column)?;
            each(&|i| Value::String(text[i].clone()))
        }
    };
    Ok(out)
}

/// Each value's display text (empty for a null).
fn formatted(column: &ArrayRef) -> Result<Vec<String>> {
    let options = FormatOptions::default();
    let formatter =
        ArrayFormatter::try_new(column.as_ref(), &options).map_err(LakehouseError::Arrow)?;
    Ok((0..column.len())
        .map(|i| formatter.value(i).to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use datafusion::prelude::SessionContext;
    use serde_json::json;

    use super::*;

    async fn rows(sql: &str) -> Vec<Value> {
        let batches = SessionContext::new()
            .sql(sql)
            .await
            .expect("planned")
            .collect()
            .await
            .expect("ran");
        json_rows(&batches).expect("rows")
    }

    #[tokio::test]
    async fn answers_as_basin_does() {
        let found = rows(
            "SELECT CAST(12 AS BIGINT) AS n, 2.5 AS f, CAST(594 AS DOUBLE) AS whole, 'pro' AS plan, \
             '{\"plan\":\"pro\"}' AS properties, true AS flag, CAST(NULL AS VARCHAR) AS nothing, \
             TIMESTAMP '2026-11-14 10:00:00' AS local_ts, \
             arrow_cast(TIMESTAMP '2026-11-14 10:00:00', 'Timestamp(Microsecond, Some(\"UTC\"))') AS utc_ts, \
             DATE '2026-11-14' AS day, CAST(1.25 AS DECIMAL(10, 2)) AS money, \
             make_array(1, 2) AS list, named_struct('a', 1, 'b', 'x') AS pair, \
             CAST('NaN' AS DOUBLE) AS nan",
        )
        .await;
        assert_eq!(
            found,
            [json!({
                "n": 12, "f": 2.5, "whole": 594.0, "plan": "pro", "properties": "{\"plan\":\"pro\"}",
                "flag": true, "nothing": null, "local_ts": "2026-11-14T10:00:00",
                "utc_ts": "2026-11-14T10:00:00Z", "day": "2026-11-14", "money": 1.25,
                "list": [1, 2], "pair": { "a": 1, "b": "x" }, "nan": null
            })]
        );
    }

    #[tokio::test]
    async fn keeps_every_row_of_every_batch() {
        let found = rows(
            "SELECT v AS n, CASE WHEN v = 2 THEN NULL ELSE 'x' END AS t FROM (VALUES (1), (2), (3)) AS s(v) ORDER BY v",
        )
        .await;
        assert_eq!(
            found,
            [
                json!({ "n": 1, "t": "x" }),
                json!({ "n": 2, "t": null }),
                json!({ "n": 3, "t": "x" })
            ]
        );
    }
}
