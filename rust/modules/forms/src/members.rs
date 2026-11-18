//! Member profiles for the DTOs (`services/members.ts`): who owns a form, who
//! published a version.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;

use crate::common::FormsResult;

/// `{ userId, name, email, imageUrl }` without a member row.
pub(crate) fn bare_ref(user_id: &str) -> Value {
    json!({ "userId": user_id, "name": null, "email": null, "imageUrl": null })
}

/// `user_id`, `name`, `email`, `picture` of a `workspace_members` row.
type MemberRow = (String, Option<String>, Option<String>, Option<String>);

/// `memberRefs(db, userIds)`: profiles by user id; a user without a member
/// row (removed, or from another system) gets a bare ref.
pub(crate) async fn member_refs(
    db: &PgPool,
    user_ids: &[String],
) -> FormsResult<HashMap<String, Value>> {
    let mut ids: Vec<String> = Vec::new();
    for id in user_ids {
        if !id.is_empty() && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let mut refs = HashMap::new();
    if !ids.is_empty() {
        let rows: Vec<MemberRow> = sqlx::query_as(
            "select user_id, name, email, picture from workspace_members \
             where user_id = any($1) and deleted_at is null",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?;
        for (user_id, name, email, picture) in rows {
            // `row.name || row.email || null`
            let display = name
                .filter(|name| !name.is_empty())
                .or_else(|| email.clone().filter(|email| !email.is_empty()));
            refs.insert(
                user_id.clone(),
                json!({ "userId": user_id, "name": display, "email": email, "imageUrl": picture }),
            );
        }
    }
    for id in ids {
        refs.entry(id.clone()).or_insert_with(|| bare_ref(&id));
    }
    Ok(refs)
}

/// `memberRef(db, userId)`.
pub(crate) async fn member_ref(db: &PgPool, user_id: &str) -> FormsResult<Value> {
    Ok(member_refs(db, &[user_id.to_owned()])
        .await?
        .remove(user_id)
        .unwrap_or_else(|| bare_ref(user_id)))
}
