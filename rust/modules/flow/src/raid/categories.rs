//! The workspace's risk categories (`flow_workspace_settings.risk_categories`,
//! `GET`/`PUT /api/project-raid/categories`): the built-ins it hides and the
//! categories it added. The plan is `@weldsuite/flow-domain/risk-categories`,
//! messages included.
//!
//! A risk stores a built-in by key (`technical`) and a custom category by
//! name (`Security`). Saving a kept id under a new name is a rename: every
//! live RAID item (any project, any kind) that carries the old name moves to
//! the new one, in the same transaction as the settings row.

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    FLOW_WORKSPACE_SETTINGS_UPDATED, PROJECT_RAID_ITEM_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::intake::{Criterion, default_scoring_model};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Data, generate_id};

use super::{iso_ms, publish_raid};
use crate::raid_body::{Reader, parse_body};
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

/// `RISK_CATEGORIES`: the built-ins, in the order the API lists them.
pub(crate) const RISK_CATEGORIES: [&str; 7] = [
    "technical",
    "schedule",
    "budget",
    "scope",
    "resource",
    "compliance",
    "external",
];

/// `MAX_CUSTOM_RISK_CATEGORIES`.
const MAX_CUSTOM: usize = 50;

/// A custom category as stored and answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Custom {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// What the column holds (`RiskCategorySettings`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Stored {
    pub(crate) hidden: Vec<String>,
    pub(crate) custom: Vec<Custom>,
}

impl Stored {
    /// The column's value, leniently: whatever is not a string list or an
    /// `{ id, name }` list reads as empty.
    fn from_json(value: &Value) -> Option<Self> {
        let Value::Object(fields) = value else {
            return None;
        };
        let hidden = fields
            .get("hidden")
            .and_then(Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(|key| key.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let custom = fields
            .get("custom")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(Custom {
                            id: item.get("id")?.as_str()?.to_owned(),
                            name: item.get("name")?.as_str()?.to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self { hidden, custom })
    }

    fn to_json(&self) -> Value {
        json!({
            "hidden": self.hidden,
            "custom": self
                .custom
                .iter()
                .map(|c| json!({ "id": c.id, "name": c.name }))
                .collect::<Vec<_>>(),
        })
    }
}

/// One entry of the body's `custom`: a kept category has its `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: Option<String>,
    pub(crate) name: String,
}

/// `UpdateRiskCategoriesInput`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Input {
    pub(crate) hidden: Vec<String>,
    pub(crate) custom: Vec<Entry>,
}

/// A rename to carry over to the items: every item whose category is
/// `from` gets `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rename {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// The list to store and the renames to carry over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) next: Stored,
    pub(crate) renames: Vec<Rename>,
}

/// `RISK_CATEGORY_MESSAGES`.
pub(crate) mod messages {
    pub(crate) fn duplicate(name: &str) -> String {
        format!("There are two categories called \"{name}\"")
    }

    pub(crate) fn built_in(name: &str) -> String {
        format!("\"{name}\" is a built-in category")
    }

    pub(crate) fn unknown_id(id: &str) -> String {
        format!("Unknown category id: {id}")
    }
}

/// `presentRiskCategories(stored)`: every built-in with its hidden flag,
/// then the custom ones.
pub(crate) fn present_risk_categories(stored: Option<&Stored>) -> Value {
    let hidden: HashSet<&str> = stored
        .map(|s| s.hidden.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let built_in: Vec<Value> = RISK_CATEGORIES
        .iter()
        .map(|key| json!({ "key": key, "hidden": hidden.contains(key) }))
        .collect();
    let custom: Vec<Value> = stored
        .map(|s| {
            s.custom
                .iter()
                .map(|c| json!({ "id": c.id, "name": c.name }))
                .collect()
        })
        .unwrap_or_default();
    json!({ "builtIn": built_in, "custom": custom })
}

/// `planRiskCategories(stored, input, newId)`: the list to store and the
/// renames, or why the body is refused. Checked in body order: an unknown
/// id, then a name that is a built-in key, then a name given twice
/// (case-insensitive). New categories get `new_id()`.
pub(crate) fn plan_risk_categories(
    stored: Option<&Stored>,
    input: &Input,
    mut new_id: impl FnMut() -> String,
) -> Result<Plan, String> {
    // `new Map(...)`: a repeated id keeps its last name.
    let existing: HashMap<&str, &str> = stored
        .map(|s| {
            s.custom
                .iter()
                .map(|c| (c.id.as_str(), c.name.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut custom = Vec::with_capacity(input.custom.len());
    let mut renames = Vec::new();

    for entry in &input.custom {
        let before = match &entry.id {
            Some(id) => match existing.get(id.as_str()) {
                Some(name) => Some(*name),
                None => return Err(messages::unknown_id(id)),
            },
            None => None,
        };
        let folded = entry.name.to_lowercase();
        if RISK_CATEGORIES.contains(&folded.as_str()) {
            return Err(messages::built_in(&entry.name));
        }
        if !seen.insert(folded) {
            return Err(messages::duplicate(&entry.name));
        }
        match (&entry.id, before) {
            (Some(id), Some(before)) => {
                if before != entry.name {
                    renames.push(Rename {
                        from: before.to_owned(),
                        to: entry.name.clone(),
                    });
                }
                custom.push(Custom {
                    id: id.clone(),
                    name: entry.name.clone(),
                });
            }
            _ => custom.push(Custom {
                id: new_id(),
                name: entry.name.clone(),
            }),
        }
    }

    let hidden = RISK_CATEGORIES
        .iter()
        .filter(|key| input.hidden.iter().any(|h| h == *key))
        .map(|key| (*key).to_owned())
        .collect();
    Ok(Plan {
        next: Stored { hidden, custom },
        renames,
    })
}

// ── Body ────────────────────────────────────────────────────────────────────

/// `updateRiskCategoriesSchema`: `{ hidden, custom }`, `.strict()`, each
/// custom entry `{ id?, name }`, `.strict()`.
fn read_input(issues: &mut Issues, body: &Value) -> Option<Input> {
    let mut r = Reader::of(issues, body)?;
    r.known.push("hidden");
    let hidden = r.issues.list(
        r.fields,
        "hidden",
        Presence::Required,
        None,
        Some(RISK_CATEGORIES.len()),
        |issues, item| issues.item_choice(item, &RISK_CATEGORIES),
    );
    r.known.push("custom");
    let custom = r.issues.list(
        r.fields,
        "custom",
        Presence::Required,
        None,
        Some(MAX_CUSTOM),
        |issues, item| {
            let mut entry = Reader::of(issues, item)?;
            entry
                .text("id", Presence::Optional, Text::length(Some(1), Some(30)))
                .text(
                    "name",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(100)),
                );
            let read = entry.strict();
            Some(Entry {
                id: read.get("id").and_then(Value::as_str).map(str::to_owned),
                name: read
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        },
    );
    r.strict();
    Some(Input {
        hidden: hidden.into_option().unwrap_or_default(),
        custom: custom.into_option().unwrap_or_default(),
    })
}

// ── Store ───────────────────────────────────────────────────────────────────

/// `storedRiskCategories(db)`: `None` before the first save.
async fn stored_risk_categories(db: &PgPool) -> Result<Option<Stored>, sqlx::Error> {
    let column: Option<Option<Value>> =
        sqlx::query_scalar("select risk_categories from flow_workspace_settings limit 1")
            .fetch_optional(db)
            .await?;
    Ok(column.flatten().as_ref().and_then(Stored::from_json))
}

// ── GET /categories ─────────────────────────────────────────────────────────

pub(super) async fn list_categories(caller: Caller) -> Response {
    reply(
        async {
            let stored = stored_risk_categories(&caller.db).await?;
            Ok(Data(present_risk_categories(stored.as_ref())).into_response())
        }
        .await,
        "Failed to fetch risk categories",
    )
}

// ── PUT /categories ─────────────────────────────────────────────────────────

/// Replace the workspace's risk categories. Workspace-level, so it takes
/// `portfolio:manage`, not project membership.
pub(super) async fn save_categories(
    State(state): State<FlowState>,
    caller: Caller,
    body: Bytes,
) -> Response {
    let input = match parse_body(&body, read_input) {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        save(&state, &caller, &input).await,
        "Failed to save risk categories",
    )
}

async fn save(state: &FlowState, caller: &Caller, input: &Input) -> Reply {
    let db = &caller.db;
    let stored = stored_risk_categories(db).await?;
    let plan = plan_risk_categories(stored.as_ref(), input, || generate_id("rcat"))
        .map_err(Refusal::bad_request)?;

    let now = iso_ms(crate::now_ms());
    let from: Vec<String> = plan.renames.iter().map(|r| r.from.clone()).collect();
    let to: Vec<String> = plan.renames.iter().map(|r| r.to.clone()).collect();
    let renamed: Vec<String> = if plan.renames.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            "select id from project_raid_items
             where category = any($1::text[]) and deleted_at is null order by id",
        )
        .bind(&from)
        .fetch_all(db)
        .await?
    };

    let mut statements = vec![
        sqlx::query(
            "insert into flow_workspace_settings (id, singleton, scoring_model, portfolio_board_ids,
                 risk_categories, updated_by, created_at, updated_at)
             values ($1, true, $2::jsonb, '[]'::jsonb, $3::jsonb, $4, $5::timestamptz, $5::timestamptz)
             on conflict (singleton) do update set
                 risk_categories = $3::jsonb, updated_by = $4, updated_at = $5::timestamptz",
        )
        .bind(generate_id("fws"))
        .bind(Value::Array(
            default_scoring_model()
                .iter()
                .map(Criterion::to_json)
                .collect(),
        ))
        .bind(plan.next.to_json())
        .bind(caller.user_id.clone())
        .bind(now.clone()),
    ];
    if !renamed.is_empty() {
        // One statement for every rename (the first `from` that matches
        // wins, as in a `case`), so swapping two names does not merge them.
        statements.push(
            sqlx::query(
                "update project_raid_items t set
                     category = coalesce((select r.to_name
                         from unnest($1::text[], $2::text[]) with ordinality as r(from_name, to_name, n)
                         where r.from_name = t.category order by r.n limit 1), t.category),
                     updated_at = $3::timestamptz
                 where t.id = any($4::text[])",
            )
            .bind(from)
            .bind(to)
            .bind(now)
            .bind(renamed.clone()),
        );
    }
    weldsuite_db::atomically(db, statements).await?;

    let presented = present_risk_categories(Some(&plan.next));
    let settings_id: Option<String> =
        sqlx::query_scalar("select id from flow_workspace_settings limit 1")
            .fetch_optional(db)
            .await?;
    if let Some(id) = settings_id {
        caller.publish(
            state,
            FLOW_WORKSPACE_SETTINGS_UPDATED,
            &id,
            &json!({ "id": id, "riskCategories": presented }),
        );
    }
    if !renamed.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            raid_json!("t"),
            " from project_raid_items t where t.id = any($1::text[]) order by t.id"
        ))
        .bind(&renamed)
        .fetch_all(db)
        .await?;
        for row in rows.into_iter().map(js_row) {
            publish_raid(state, caller, PROJECT_RAID_ITEM_UPDATED, &row, json!({}));
        }
    }
    Ok(Data(presented).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("rcat_{n}")
        }
    }

    fn custom(id: &str, name: &str) -> Custom {
        Custom {
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    fn entry(id: Option<&str>, name: &str) -> Entry {
        Entry {
            id: id.map(str::to_owned),
            name: name.to_owned(),
        }
    }

    fn input(hidden: &[&str], custom: Vec<Entry>) -> Input {
        Input {
            hidden: hidden.iter().map(|h| (*h).to_owned()).collect(),
            custom,
        }
    }

    #[test]
    fn shows_every_built_in_and_no_custom_category_before_anything_is_saved() {
        assert_eq!(
            present_risk_categories(None),
            json!({
                "builtIn": [
                    { "key": "technical", "hidden": false },
                    { "key": "schedule", "hidden": false },
                    { "key": "budget", "hidden": false },
                    { "key": "scope", "hidden": false },
                    { "key": "resource", "hidden": false },
                    { "key": "compliance", "hidden": false },
                    { "key": "external", "hidden": false },
                ],
                "custom": [],
            })
        );
    }

    #[test]
    fn flags_the_hidden_built_ins() {
        let stored = Stored {
            hidden: vec!["budget".to_owned()],
            custom: vec![custom("rcat_1", "Security")],
        };
        let built_in: Vec<Value> = RISK_CATEGORIES
            .iter()
            .map(|key| json!({ "key": key, "hidden": *key == "budget" }))
            .collect();
        assert_eq!(
            present_risk_categories(Some(&stored)),
            json!({
                "builtIn": built_in,
                "custom": [{ "id": "rcat_1", "name": "Security" }],
            })
        );
    }

    #[test]
    fn adds_new_categories_with_fresh_ids_and_keeps_hidden_keys_in_built_in_order() {
        let plan = plan_risk_categories(
            None,
            &input(
                &["external", "budget", "budget"],
                vec![entry(None, "Security"), entry(None, "Vendor")],
            ),
            ids(),
        );
        assert_eq!(
            plan,
            Ok(Plan {
                next: Stored {
                    hidden: vec!["budget".to_owned(), "external".to_owned()],
                    custom: vec![custom("rcat_1", "Security"), custom("rcat_2", "Vendor")],
                },
                renames: vec![],
            })
        );
    }

    #[test]
    fn turns_a_kept_id_with_a_new_name_into_a_rename() {
        let stored = Stored {
            hidden: vec![],
            custom: vec![custom("rcat_1", "Vendr"), custom("rcat_2", "Legal")],
        };
        let plan = plan_risk_categories(
            Some(&stored),
            &input(
                &[],
                vec![
                    entry(Some("rcat_1"), "Vendor"),
                    entry(Some("rcat_2"), "Legal"),
                ],
            ),
            ids(),
        );
        assert_eq!(
            plan.map(|plan| plan.renames),
            Ok(vec![Rename {
                from: "Vendr".to_owned(),
                to: "Vendor".to_owned(),
            }])
        );
    }

    #[test]
    fn drops_a_category_left_out_of_the_body_without_a_rename() {
        let stored = Stored {
            hidden: vec![],
            custom: vec![custom("rcat_1", "Legal")],
        };
        assert_eq!(
            plan_risk_categories(Some(&stored), &input(&[], vec![]), ids()),
            Ok(Plan {
                next: Stored::default(),
                renames: vec![],
            })
        );
    }

    #[test]
    fn refuses_an_unknown_id_a_built_in_key_and_a_name_given_twice() {
        assert_eq!(
            plan_risk_categories(None, &input(&[], vec![entry(Some("rcat_9"), "X")]), ids()),
            Err("Unknown category id: rcat_9".to_owned())
        );
        assert_eq!(
            plan_risk_categories(None, &input(&[], vec![entry(None, "Technical")]), ids()),
            Err("\"Technical\" is a built-in category".to_owned())
        );
        assert_eq!(
            plan_risk_categories(
                None,
                &input(&[], vec![entry(None, "Legal"), entry(None, "legal")]),
                ids()
            ),
            Err("There are two categories called \"legal\"".to_owned())
        );
    }

    #[test]
    fn reads_the_body_as_the_strict_schema_does() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let input = read_input(&mut issues, &body);
            issues.finish().ok().and(input)
        };
        assert_eq!(
            read(json!({ "hidden": ["budget"], "custom": [{ "name": "  Security " }] })),
            Some(input(&["budget"], vec![entry(None, "Security")]))
        );
        assert!(read(json!({ "hidden": ["weather"], "custom": [] })).is_none());
        assert!(read(json!({ "hidden": [], "custom": [{ "name": "" }] })).is_none());
        assert!(read(json!({ "hidden": [], "custom": [], "extra": true })).is_none());
        assert!(read(json!({ "hidden": [], "custom": [{ "name": "A", "x": 1 }] })).is_none());
    }
}
