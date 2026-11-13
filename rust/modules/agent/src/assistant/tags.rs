//! Records a person tags in a message to the assistant
//! (`packages/domains/agent/src/record-tokens.ts`): a tag is stored in the
//! text as `<@type:id|Label>`, and the model gets it spelled out
//! (`project "Launch" (id prj_1)`).

use std::sync::LazyLock;

use regex::Regex;

/// `SEARCH_ENTITY_TYPES` and how each is called in the text a model reads
/// (`RECORD_NOUN`).
const RECORD_NOUNS: [(&str, &str); 18] = [
    ("contact", "person"),
    ("customer", "company"),
    ("lead", "lead"),
    ("opportunity", "opportunity"),
    ("ticket", "ticket"),
    ("article", "help center article"),
    ("knowledge_page", "knowledge page"),
    ("product", "product"),
    ("order", "order"),
    ("invoice", "invoice"),
    ("bill", "bill"),
    ("project", "project"),
    ("task", "task"),
    ("domain", "domain"),
    ("sheet", "spreadsheet"),
    ("board", "board"),
    ("merge_issue", "WeldMerge issue"),
    ("merge_pull_request", "pull request"),
];

#[allow(clippy::expect_used)] // a constant pattern
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@([^>]+)>").expect("the token pattern is valid"));

/// The noun, id and label a token body (`type:id|Label`) names; `None` for a
/// person, an agent or a file.
fn record_of(body: &str) -> Option<(&'static str, &str, Option<&str>)> {
    let (kind, rest) = body.split_once(':')?;
    let noun = RECORD_NOUNS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, noun)| *noun)?;
    let (id, label) = match rest.split_once('|') {
        Some((id, label)) => (id.trim(), label.trim()),
        None => (rest.trim(), ""),
    };
    if id.is_empty() {
        return None;
    }
    Some((noun, id, (!label.is_empty()).then_some(label)))
}

/// `describeRecordTokens(text)`: every record tag spelled out for a model;
/// other tokens stay as they are.
pub(super) fn describe_record_tokens(text: &str) -> String {
    TOKEN
        .replace_all(text, |caps: &regex::Captures<'_>| {
            match record_of(&caps[1]) {
                Some((noun, id, Some(label))) => format!("{noun} \"{label}\" (id {id})"),
                Some((noun, id, None)) => format!("{noun} (id {id})"),
                None => caps[0].to_owned(),
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_tag_is_spelled_out() {
        assert_eq!(
            describe_record_tokens("Total <@sheet:sht_1|Budget> and <@task:t_2>"),
            "Total spreadsheet \"Budget\" (id sht_1) and task (id t_2)"
        );
    }

    #[test]
    fn people_and_unknown_tags_stay() {
        let text = "Ask <@user:u1|Ann> about <@nothing:x>";
        assert_eq!(describe_record_tokens(text), text);
    }
}
