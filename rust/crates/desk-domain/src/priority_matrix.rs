//! WeldDesk's priority matrix (`@weldsuite/db/lib/desk-priority-matrix`,
//! `packages/core/db/src/lib/desk-priority-matrix.ts`): ITIL impact ×
//! urgency → priority.
//!
//! A conversation carries an impact and an urgency (low / medium / high,
//! null when not set). With the workspace's matrix on
//! (`helpdesk_settings.tickets.priorityMatrix.enabled`) and both set, the
//! priority follows the grid whenever either of them changes; a priority set
//! directly is an override that holds until they change again. Off by
//! default. [`crate::attributes::update`] is the only writer.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::Field;

/// `DESK_IMPACTS` / `DESK_URGENCIES`: both axes take these values.
pub const LEVELS: &[&str] = &["low", "medium", "high"];

const PRIORITIES: &[&str] = &["low", "medium", "high", "urgent"];

/// `DEFAULT_DESK_PRIORITY_GRID`: impact → urgency → priority.
const DEFAULT_GRID: [(&str, [(&str, &str); 3]); 3] = [
    (
        "low",
        [("low", "low"), ("medium", "low"), ("high", "medium")],
    ),
    (
        "medium",
        [("low", "low"), ("medium", "medium"), ("high", "high")],
    ),
    (
        "high",
        [("low", "medium"), ("medium", "high"), ("high", "urgent")],
    ),
];

/// The default grid's cell.
fn default_cell(impact: &str, urgency: &str) -> &'static str {
    DEFAULT_GRID
        .iter()
        .find(|(row, _)| *row == impact)
        .and_then(|(_, cells)| cells.iter().find(|(column, _)| *column == urgency))
        .map_or("medium", |(_, priority)| priority)
}

/// `normalizeDeskPriorityMatrix(value)`: `{ enabled, matrix }`, off unless
/// `enabled` is `true`, every cell a valid priority (a missing or bad one
/// takes the default's).
pub fn normalize(value: &Value) -> Value {
    let grid = &value["matrix"];
    let mut matrix = Map::new();
    for impact in LEVELS {
        let mut row = Map::new();
        for urgency in LEVELS {
            let cell = grid[*impact][*urgency]
                .as_str()
                .filter(|cell| PRIORITIES.contains(cell))
                .unwrap_or_else(|| default_cell(impact, urgency));
            row.insert((*urgency).to_owned(), json!(cell));
        }
        matrix.insert((*impact).to_owned(), Value::Object(row));
    }
    json!({
        "enabled": value["enabled"] == Value::Bool(true),
        "matrix": matrix,
    })
}

/// `getDeskPriorityMatrix(db)`: the workspace's matrix, the default grid
/// (off) when nothing is saved.
pub async fn read(db: &PgPool) -> Result<Value, sqlx::Error> {
    let tickets: Option<Option<Value>> = sqlx::query_scalar(
        "select tickets from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    let tickets = tickets.flatten().unwrap_or(Value::Null);
    Ok(normalize(&tickets["priorityMatrix"]))
}

/// `deskPriorityFromMatrix(matrix, impact, urgency)`: the grid's priority,
/// `None` unless both are set.
pub fn priority_of(matrix: &Value, impact: Option<&str>, urgency: Option<&str>) -> Option<String> {
    let (impact, urgency) = (impact?, urgency?);
    matrix[impact][urgency].as_str().map(str::to_owned)
}

/// `DeskMatrixChanges`: the impact and urgency patch (`None` leaves a
/// column alone), their `attributes_changed` entries, and the priority the
/// grid gives when one of them changed, the matrix is on and both are set.
#[derive(Debug, Default)]
pub struct Changes {
    #[allow(clippy::option_option)] // left alone vs cleared
    pub impact: Option<Option<String>>,
    #[allow(clippy::option_option)]
    pub urgency: Option<Option<String>>,
    pub entries: Vec<Value>,
    pub priority: Option<String>,
}

/// One axis: the patch and its entry, when the value changes.
#[allow(clippy::option_option)] // left alone vs cleared
fn axis_change(
    field: &str,
    current: &Value,
    input: &Field<String>,
) -> Option<(Option<String>, Value)> {
    let next = match input {
        Field::Absent => return None,
        Field::Null => None,
        Field::Set(value) => Some(value.clone()),
    };
    if next.as_deref() == current.as_str() {
        return None;
    }
    let entry = json!({ "field": field, "from": current, "to": next });
    Some((next, entry))
}

/// `deskMatrixChanges(db, current, input)`: reads the setting only when the
/// impact or the urgency changes.
pub async fn changes(
    db: &PgPool,
    current: &Value,
    impact: &Field<String>,
    urgency: &Field<String>,
) -> Result<Changes, sqlx::Error> {
    let mut out = Changes::default();
    if let Some((next, entry)) = axis_change("impact", &current["impact"], impact) {
        out.impact = Some(next);
        out.entries.push(entry);
    }
    if let Some((next, entry)) = axis_change("urgency", &current["urgency"], urgency) {
        out.urgency = Some(next);
        out.entries.push(entry);
    }
    if out.entries.is_empty() {
        return Ok(out);
    }
    let impact = match &out.impact {
        Some(next) => next.clone(),
        None => current["impact"].as_str().map(str::to_owned),
    };
    let urgency = match &out.urgency {
        Some(next) => next.clone(),
        None => current["urgency"].as_str().map(str::to_owned),
    };
    let (Some(impact), Some(urgency)) = (
        impact.filter(|v| !v.is_empty()),
        urgency.filter(|v| !v.is_empty()),
    ) else {
        return Ok(out);
    };
    let setting = read(db).await?;
    if setting["enabled"] != Value::Bool(true) {
        return Ok(out);
    }
    out.priority = priority_of(&setting["matrix"], Some(&impact), Some(&urgency));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_the_itil_grid_and_off() {
        let matrix = normalize(&Value::Null);
        assert_eq!(matrix["enabled"], json!(false));
        assert_eq!(matrix["matrix"]["high"]["high"], json!("urgent"));
        assert_eq!(matrix["matrix"]["high"]["medium"], json!("high"));
        assert_eq!(matrix["matrix"]["medium"]["high"], json!("high"));
        assert_eq!(matrix["matrix"]["high"]["low"], json!("medium"));
        assert_eq!(matrix["matrix"]["low"]["high"], json!("medium"));
        assert_eq!(matrix["matrix"]["medium"]["medium"], json!("medium"));
        assert_eq!(matrix["matrix"]["medium"]["low"], json!("low"));
        assert_eq!(matrix["matrix"]["low"]["medium"], json!("low"));
        assert_eq!(matrix["matrix"]["low"]["low"], json!("low"));
    }

    #[test]
    fn a_bad_cell_takes_the_default_and_only_true_turns_it_on() {
        let matrix = normalize(&json!({
            "enabled": "yes",
            "matrix": { "low": { "low": "urgent", "medium": "critical" } },
        }));
        assert_eq!(matrix["enabled"], json!(false));
        assert_eq!(matrix["matrix"]["low"]["low"], json!("urgent"));
        assert_eq!(matrix["matrix"]["low"]["medium"], json!("low"));
        assert_eq!(
            normalize(&json!({ "enabled": true }))["enabled"],
            json!(true)
        );
    }

    #[test]
    fn a_priority_needs_both_axes() {
        let matrix = normalize(&Value::Null)["matrix"].clone();
        assert_eq!(priority_of(&matrix, Some("high"), None), None);
        assert_eq!(
            priority_of(&matrix, Some("high"), Some("high")).as_deref(),
            Some("urgent")
        );
    }
}
