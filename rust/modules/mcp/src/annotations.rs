//! MCP tool annotations (`lib/tool-annotations.ts`): every listed tool has a
//! title and says whether it only reads or may destroy data, derived from the
//! HTTP method it calls. The house tools carry theirs in the catalog, with
//! their hand-set overrides (`openWorldHint` when a call leaves the
//! workspace, `destructiveHint` when one replaces data); the WeldApps tools'
//! are derived here from their action.

use serde_json::{Value, json};

/// `toolTitle`: `search_tasks` → "Search tasks".
pub(crate) fn tool_title(name: &str) -> String {
    let words = name
        .split('_')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = words.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// `annotationsFor(method, title)`: GET reads; POST creates or starts
/// something, again when repeated; PATCH and PUT change fields, nothing more
/// when repeated; DELETE removes. The spec defaults `destructiveHint` to true
/// for a write, so a write always sets it. A method the tool cannot know up
/// front (a WeldApps tool's `api.request` with an unrecognised method) is a
/// write that may destroy data, the spec's own default.
pub(crate) fn annotations_for(method: Option<&str>, title: &str) -> Value {
    let method = method.unwrap_or_default().to_uppercase();
    if method == "GET" {
        return json!({ "title": title, "readOnlyHint": true, "openWorldHint": false });
    }
    let (destructive, idempotent) = match method.as_str() {
        "POST" => (false, false),
        "PATCH" | "PUT" => (false, true),
        "DELETE" => (true, true),
        _ => (true, false),
    };
    json!({
        "title": title,
        "readOnlyHint": false,
        "destructiveHint": destructive,
        "idempotentHint": idempotent,
        "openWorldHint": false,
    })
}

#[cfg(test)]
mod tests {
    use http::Method;
    use serde_json::{Value, json};

    use super::{annotations_for, tool_title};
    use crate::catalog::catalog;

    /// The tools whose annotations `registry.ts` sets by hand, over the method's.
    fn overrides(name: &str) -> Value {
        match name {
            "add_conversation_message"
            | "publish_social_post"
            | "schedule_social_post"
            | "launch_reach_campaign"
            | "resume_reach_campaign" => json!({ "openWorldHint": true }),
            "set_reach_campaign_steps" | "set_reach_campaign_mailboxes" => {
                json!({ "destructiveHint": true })
            }
            "remove_reach_prospect_list_members" => {
                json!({ "destructiveHint": true, "idempotentHint": true })
            }
            _ => json!({}),
        }
    }

    /// A house tool's annotations as the catalog lists them.
    fn hints(name: &str) -> &'static Value {
        &catalog().tool(name).expect(name).definition["annotations"]
    }

    #[test]
    fn titles_a_snake_case_name() {
        assert_eq!(
            tool_title("add_prospects_to_reach_campaign"),
            "Add prospects to reach campaign"
        );
        assert_eq!(tool_title("search_tasks"), "Search tasks");
        assert_eq!(tool_title("_list__items_"), "List items");
        assert_eq!(tool_title(""), "");
    }

    #[test]
    fn hints_follow_the_method() {
        assert_eq!(
            annotations_for(Some("GET"), "Search tasks"),
            json!({ "title": "Search tasks", "readOnlyHint": true, "openWorldHint": false })
        );
        assert_eq!(
            annotations_for(Some("POST"), "Send"),
            json!({
                "title": "Send",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            })
        );
        for method in ["PATCH", "put"] {
            assert_eq!(
                annotations_for(Some(method), "Edit")["idempotentHint"],
                true
            );
        }
        assert_eq!(annotations_for(Some("get"), "Read")["readOnlyHint"], true);
        let delete = annotations_for(Some("DELETE"), "Drop");
        assert_eq!(delete["destructiveHint"], true);
        assert_eq!(delete["idempotentHint"], true);
        // An unknown method is refused at call time; until then assume the worst.
        for method in [Some("TRACE"), None] {
            assert_eq!(
                annotations_for(method, "Odd"),
                json!({
                    "title": "Odd",
                    "readOnlyHint": false,
                    "destructiveHint": true,
                    "idempotentHint": false,
                    "openWorldHint": false,
                })
            );
        }
    }

    /// The catalog's titles and annotations, written by the TypeScript
    /// worker, are this derivation with the hand-set overrides on top.
    #[test]
    fn the_catalog_matches_the_derivation() {
        for tool in &catalog().tools {
            let definition = &tool.definition;
            let title = tool_title(&tool.name);
            assert_eq!(definition["title"], title.as_str(), "{}", tool.name);
            let mut expected = annotations_for(Some(tool.method.as_str()), &title);
            if let (Some(hints), Value::Object(overrides)) =
                (expected.as_object_mut(), overrides(&tool.name))
            {
                hints.extend(overrides);
            }
            assert_eq!(definition["annotations"], expected, "{}", tool.name);
        }
    }

    #[test]
    fn marks_house_tools_by_their_method() {
        for tool in &catalog().tools {
            let listed = &tool.definition["annotations"];
            let name = tool.name.as_str();
            assert_eq!(listed["readOnlyHint"], tool.method == Method::GET, "{name}");
            // The spec defaults destructiveHint to true for a write: always say so.
            if tool.method != Method::GET {
                assert!(listed["destructiveHint"].is_boolean(), "{name}");
            }
            if tool.method == Method::DELETE {
                assert_eq!(listed["destructiveHint"], true, "{name}");
            }
            let reads = ["search_", "get_", "list_"];
            if reads.iter().any(|prefix| name.starts_with(prefix)) {
                assert_eq!(listed["readOnlyHint"], true, "{name}");
            }
            if name.starts_with("create_") {
                assert_eq!(listed["destructiveHint"], false, "{name}");
            }
        }
        assert_eq!(
            hints("search_tasks"),
            &json!({ "title": "Search tasks", "readOnlyHint": true, "openWorldHint": false })
        );
        let update = hints("update_task");
        assert_eq!(update["readOnlyHint"], false);
        assert_eq!(update["destructiveHint"], false);
        assert_eq!(update["idempotentHint"], true);
        assert_eq!(hints("delete_task")["destructiveHint"], true);
    }

    #[test]
    fn keeps_the_hand_set_overrides() {
        for name in [
            "publish_social_post",
            "schedule_social_post",
            "launch_reach_campaign",
            "add_conversation_message",
        ] {
            assert_eq!(hints(name)["readOnlyHint"], false, "{name}");
            assert_eq!(hints(name)["openWorldHint"], true, "{name}");
        }
        for name in [
            "set_reach_campaign_steps",
            "remove_reach_prospect_list_members",
        ] {
            assert_eq!(hints(name)["readOnlyHint"], false, "{name}");
            assert_eq!(hints(name)["destructiveHint"], true, "{name}");
        }
    }
}
