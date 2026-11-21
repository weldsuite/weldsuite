//! A person's avatar is their account picture: `users.image_url` on the master
//! database, set by the identity provider when the account is created and kept
//! current by the profile sync, so it is the same in every workspace. The
//! Rust counterpart of worker-kit's `account-pictures.ts`.
//!
//! `workspace_members.picture` is not an avatar source: it was a per-workspace
//! copy that drifted from the account. Every route that returns a person's
//! picture resolves it here instead, by user id: an unknown user or an empty
//! url is `null`, and a failed lookup is logged and answers `null` for
//! everyone rather than failing the response it decorates.
//!
//! The lookup is one `select … where id = any($1)` on the master database per
//! call, so batch: collect the user ids of a whole response, then resolve them
//! together.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgPool;

/// User id → account picture URL. Users without one are absent.
#[derive(Debug, Clone, Default)]
pub struct AccountPictures(HashMap<String, String>);

impl AccountPictures {
    /// The account pictures of `user_ids` (empty ids ignored). No master
    /// database, or a failed query, gives an empty map.
    pub async fn load<I, S>(master: Option<&PgPool>, user_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut ids: Vec<String> = user_ids
            .into_iter()
            .map(|id| id.as_ref().to_owned())
            .filter(|id| !id.is_empty())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let Some(master) = master else {
            return Self::default();
        };
        if ids.is_empty() {
            return Self::default();
        }
        match sqlx::query_as::<_, (String, Option<String>)>(
            "select id, image_url from users where id = any($1)",
        )
        .bind(&ids)
        .fetch_all(master)
        .await
        {
            Ok(rows) => Self(
                rows.into_iter()
                    .filter_map(|(id, url)| url.filter(|url| !url.is_empty()).map(|url| (id, url)))
                    .collect(),
            ),
            Err(error) => {
                tracing::warn!(%error, "account pictures: lookup failed");
                Self::default()
            }
        }
    }

    /// The account pictures of the users named by `user_key` on each object.
    pub async fn load_for(master: Option<&PgPool>, objects: &[Value], user_key: &str) -> Self {
        Self::load(master, user_ids(objects, user_key)).await
    }

    /// One user's picture.
    pub fn get(&self, user_id: &str) -> Option<&str> {
        self.0.get(user_id).map(String::as_str)
    }

    /// One user's picture as JSON: the url, or `null`.
    pub fn value(&self, user_id: Option<&str>) -> Value {
        user_id
            .and_then(|id| self.get(id))
            .map_or(Value::Null, |url| Value::String(url.to_owned()))
    }

    /// Set `picture_key` on `object` (a JSON object) to the picture of the user
    /// its `user_key` names; `null` when it names none.
    pub fn apply(&self, object: &mut Value, user_key: &str, picture_key: &str) {
        let picture = self.value(object.get(user_key).and_then(Value::as_str));
        if let Some(map) = object.as_object_mut() {
            map.insert(picture_key.to_owned(), picture);
        }
    }

    /// [`apply`](Self::apply) on each object.
    pub fn apply_all<'a>(
        &self,
        objects: impl IntoIterator<Item = &'a mut Value>,
        user_key: &str,
        picture_key: &str,
    ) {
        for object in objects {
            self.apply(object, user_key, picture_key);
        }
    }
}

/// The string values of `key` on each object (the user ids to resolve).
pub fn user_ids<'a>(objects: &'a [Value], key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    objects
        .iter()
        .filter_map(move |object| object.get(key).and_then(Value::as_str))
}

/// One user's account picture.
pub async fn load_account_picture(master: Option<&PgPool>, user_id: &str) -> Option<String> {
    AccountPictures::load(master, [user_id])
        .await
        .get(user_id)
        .map(str::to_owned)
}

/// Load and apply in one go: `picture_key` on each object becomes the account
/// picture of the user its `user_key` names.
pub async fn overlay_account_pictures(
    master: Option<&PgPool>,
    objects: &mut [Value],
    user_key: &str,
    picture_key: &str,
) {
    let pictures = AccountPictures::load_for(master, objects, user_key).await;
    pictures.apply_all(objects.iter_mut(), user_key, picture_key);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn pictures() -> AccountPictures {
        AccountPictures(HashMap::from([(
            "user_alice".to_owned(),
            "https://img.test/alice.png".to_owned(),
        )]))
    }

    #[test]
    fn value_is_the_url_or_null() {
        let pictures = pictures();
        assert_eq!(
            pictures.value(Some("user_alice")),
            json!("https://img.test/alice.png")
        );
        assert_eq!(pictures.value(Some("user_bob")), Value::Null);
        assert_eq!(pictures.value(None), Value::Null);
    }

    #[test]
    fn apply_replaces_the_stored_picture() {
        let pictures = pictures();
        let mut rows = vec![
            json!({ "userId": "user_alice", "name": "Alice", "picture": "https://stale.test/a.png" }),
            json!({ "userId": "user_bob", "picture": "https://stale.test/b.png" }),
            json!({ "userId": null, "picture": "https://stale.test/invite.png" }),
        ];
        pictures.apply_all(rows.iter_mut(), "userId", "picture");
        assert_eq!(
            rows,
            vec![
                json!({ "userId": "user_alice", "name": "Alice", "picture": "https://img.test/alice.png" }),
                json!({ "userId": "user_bob", "picture": null }),
                json!({ "userId": null, "picture": null }),
            ]
        );
    }

    #[test]
    fn user_ids_reads_string_values_only() {
        let rows = [
            json!({ "userId": "a" }),
            json!({ "userId": null }),
            json!({}),
        ];
        assert_eq!(user_ids(&rows, "userId").collect::<Vec<_>>(), vec!["a"]);
    }

    #[tokio::test]
    async fn without_a_master_database_nobody_has_a_picture() {
        let pictures = AccountPictures::load(None, ["user_alice"]).await;
        assert_eq!(pictures.get("user_alice"), None);
    }
}
