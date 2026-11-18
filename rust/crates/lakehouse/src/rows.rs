//! Rows as the collector publishes them (`serde_json` objects, one key per
//! column, timestamps as ISO 8601 strings; `collector/rows.rs`) to an Arrow
//! `RecordBatch` in the table's schema.

use std::sync::Arc;

use arrow_array::{
    ArrayRef, BooleanArray, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray,
    TimestampMicrosecondArray,
};
use arrow_schema::{DataType, Field, SchemaRef, TimeUnit};
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::error::{LakehouseError, Result};

/// The rows as one batch in `schema` (the table's Arrow schema, with its
/// field ids). A key the schema doesn't have is ignored, a missing key is
/// null, and null in a required column, or a value of the wrong type, is an
/// error naming the row and the column.
pub fn rows_to_batch(schema: &SchemaRef, rows: &[Value]) -> Result<RecordBatch> {
    let objects = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            row.as_object()
                .ok_or_else(|| LakehouseError::Rows(format!("row {index} is not an object")))
        })
        .collect::<Result<Vec<_>>>()?;
    let columns = schema
        .fields()
        .iter()
        .map(|field| {
            let values: Vec<&Value> = objects
                .iter()
                .map(|object| object.get(field.name()).unwrap_or(&Value::Null))
                .collect();
            column(field, &values)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RecordBatch::try_new(schema.clone(), columns)?)
}

/// Whether one row fits `schema`: the error [`rows_to_batch`] gives for it
/// alone (the writer's way to find the bad rows of a batch that failed).
pub fn check_row(schema: &SchemaRef, row: &Value) -> Result<()> {
    rows_to_batch(schema, std::slice::from_ref(row)).map(|_| ())
}

#[allow(clippy::too_many_lines)] // one arm per column type
fn column(field: &Field, values: &[&Value]) -> Result<ArrayRef> {
    let name = field.name();
    let bad = |index: usize, want: &str| {
        LakehouseError::Rows(format!("row {index}: {name} is not {want}"))
    };
    let check_required = |index: usize, value: &Value| {
        if value.is_null() && !field.is_nullable() {
            Err(LakehouseError::Rows(format!(
                "row {index}: {name} is required"
            )))
        } else {
            Ok(())
        }
    };
    let array: ArrayRef = match field.data_type() {
        DataType::Utf8 => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        Value::String(text) => Ok(Some(text.as_str())),
                        _ => Err(bad(index, "text")),
                    }
                })
                .collect::<Result<StringArray>>()?,
        ),
        DataType::Boolean => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        Value::Bool(flag) => Ok(Some(*flag)),
                        _ => Err(bad(index, "a boolean")),
                    }
                })
                .collect::<Result<BooleanArray>>()?,
        ),
        DataType::Int32 => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        _ => value
                            .as_i64()
                            .and_then(|number| i32::try_from(number).ok())
                            .map(Some)
                            .ok_or_else(|| bad(index, "a 32-bit integer")),
                    }
                })
                .collect::<Result<Int32Array>>()?,
        ),
        DataType::Int64 => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        _ => value
                            .as_i64()
                            .map(Some)
                            .ok_or_else(|| bad(index, "an integer")),
                    }
                })
                .collect::<Result<Int64Array>>()?,
        ),
        DataType::Float64 => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        _ => value
                            .as_f64()
                            .map(Some)
                            .ok_or_else(|| bad(index, "a number")),
                    }
                })
                .collect::<Result<Float64Array>>()?,
        ),
        DataType::Timestamp(TimeUnit::Microsecond, zone) => Arc::new(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    check_required(index, value)?;
                    match value {
                        Value::Null => Ok(None),
                        Value::String(text) => parse_micros(text)
                            .map(Some)
                            .ok_or_else(|| bad(index, "an ISO 8601 time")),
                        _ => Err(bad(index, "an ISO 8601 time")),
                    }
                })
                .collect::<Result<TimestampMicrosecondArray>>()?
                .with_timezone_opt(zone.clone()),
        ),
        other => {
            return Err(LakehouseError::Rows(format!(
                "{name}: no conversion to {other}"
            )));
        }
    };
    Ok(array)
}

/// Microseconds since the epoch of an RFC 3339 time.
fn parse_micros(text: &str) -> Option<i64> {
    let at = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos().div_euclid(1000)).ok()
}

#[cfg(test)]
mod tests {
    use arrow_array::Array;
    use serde_json::json;

    use super::*;

    fn schema() -> SchemaRef {
        Arc::new(arrow_schema::Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Microsecond, Some("+00:00".into())),
                false,
            ),
            Field::new("x", DataType::Int32, true),
        ]))
    }

    #[test]
    fn converts_rows_and_names_the_bad_ones() {
        let batch = rows_to_batch(
            &schema(),
            &[
                json!({ "name": "$pageview", "ts": "2026-10-27T11:59:55.000Z", "x": 3, "extra": 1 }),
                json!({ "name": "signup", "ts": "2026-10-27T12:00:00Z" }),
            ],
        )
        .expect("a batch");
        assert_eq!(batch.num_rows(), 2);
        let ts = batch
            .column(1)
            .as_any()
            .downcast_ref::<TimestampMicrosecondArray>()
            .expect("timestamps");
        assert_eq!(ts.value(0), 1_793_102_395_000_000);
        assert!(batch.column(2).is_null(1));

        let missing = rows_to_batch(&schema(), &[json!({ "ts": "2026-10-27T12:00:00Z" })]);
        assert_eq!(
            missing.expect_err("required").to_string(),
            "rows: row 0: name is required"
        );
        let wrong = rows_to_batch(&schema(), &[json!({ "name": "a", "ts": 5 })]);
        assert_eq!(
            wrong.expect_err("a string time").to_string(),
            "rows: row 0: ts is not an ISO 8601 time"
        );
    }
}
