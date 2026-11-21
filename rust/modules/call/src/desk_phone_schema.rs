//! An inbound route's `options` as the shared schema reads and stores them
//! (`@weldsuite/core-api-client/schemas/desk-phone`):
//! `deskPhoneRouteOptionsSchema` with the issues Zod reports, and
//! `normalizeDeskPhoneRouteOptions`, which keeps the options an action uses.
//!
//! `zValidator` parses asynchronously: every check of a field is reported
//! while the body is read, in the schema's order, and the refinements
//! (`.superRefine`) settle afterwards, innermost first. The refinements of
//! the menu and its choices therefore go to a `deferred` list the caller
//! pushes once the body is read. A refinement runs unless its object is
//! `INVALID`: a value of the wrong type or off its enum ([`aborted_since`]),
//! or a failed check under a `.transform()` (a choice's `voiceAgentId` and
//! `forwardToE164`), which each reader reports as `aborted`.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};

use crate::desk_phone::is_e164;
use crate::desk_phone_options::{Menu, MenuChoice};

/// `DESK_PHONE_ROUTE_ACTIONS`.
pub(crate) const ROUTE_ACTIONS: [&str; 6] = [
    "ai_agent",
    "forward",
    "hangup",
    "agents",
    "voicemail",
    "menu",
];
/// `DESK_PHONE_MENU_ACTIONS`: what a keypad choice can do.
const MENU_ACTIONS: [&str; 4] = ["ai_agent", "agents", "forward", "voicemail"];
/// `DESK_PHONE_MENU_DIGITS`.
const MENU_DIGITS: [&str; 12] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "*", "#"];
/// `DESK_PHONE_UNANSWERED_ACTIONS`.
const UNANSWERED_ACTIONS: [&str; 2] = ["voicemail", "hangup"];
/// `DESK_PHONE_RING_SECONDS_RANGE`.
const RING_SECONDS_RANGE: (f64, f64) = (10.0, 60.0);
/// `DESK_PHONE_MAX_WAIT_SECONDS_RANGE`.
const MAX_WAIT_SECONDS_RANGE: (f64, f64) = (30.0, 1800.0);
/// `DESK_PHONE_TEXT_MAX_LENGTH`.
const TEXT_MAX_LENGTH: usize = 1000;

/// `DeskPhoneRouteOptionsInput`: what `deskPhoneRouteOptionsSchema` parsed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Options {
    greeting: Option<String>,
    language: Option<String>,
    department_id: Option<String>,
    ring_seconds: Option<i64>,
    max_wait_seconds: Option<i64>,
    when_unanswered: Option<String>,
    voicemail_greeting: Option<String>,
    menu: Option<Menu>,
}

/// `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`: a BCP 47 tag such as `en-US`.
fn is_bcp47(text: &str) -> bool {
    let mut parts = text.split('-');
    let primary = parts.next().unwrap_or_default();
    (2..=3).contains(&primary.len())
        && primary.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// Whether an issue made its value `INVALID` for Zod: a wrong type or an
/// enum value that is not one. A failed check (a length, a range, a pattern,
/// a fraction where a whole number is asked) leaves the value in place.
fn aborts(issue: &Value) -> bool {
    match issue["code"].as_str() {
        Some("invalid_type") => issue["expected"] != "integer",
        Some("invalid_enum_value" | "invalid_union" | "invalid_literal") => true,
        _ => false,
    }
}

/// Whether anything read since `from` (an [`Issues::count`]) was `INVALID`:
/// the object around it is too, so its refinement does not run.
pub(crate) fn aborted_since(issues: &Issues, from: usize) -> bool {
    issues.issues_since(from).iter().any(aborts)
}

/// A refinement's issue (`ctx.addIssue({ code: 'custom', message, path })`)
/// at `path` below `base`.
fn custom(base: &Value, path: &[Value], message: &str) -> Value {
    let mut full = base.as_array().cloned().unwrap_or_default();
    full.extend(path.iter().cloned());
    json!({ "code": "custom", "message": message, "path": full })
}

/// `spokenText.optional()`: `z.string().trim().max(1000)`.
fn spoken(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text_with(
            fields,
            key,
            Presence::Optional,
            Text::trimmed(None, Some(TEXT_MAX_LENGTH)),
        )
        .into_option()
}

/// `z.number().int().min(min).max(max).optional()`.
fn seconds(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    (min, max): (f64, f64),
) -> Option<i64> {
    let rules = Number {
        min: Some(min),
        max: Some(max),
        ..Number::default()
    };
    issues
        .whole_number(fields, key, Presence::Optional, rules)
        .into_option()
}

/// One item of `choices` as read.
struct ChoiceRead {
    /// The choice, when nothing was wrong with it.
    choice: Option<MenuChoice>,
    /// Its digit, as the menu's refinement sees it.
    digit: Option<String>,
    /// Whether it is `INVALID`.
    aborted: bool,
}

/// `deskPhoneMenuChoiceSchema` on one item of `choices`.
fn read_choice(issues: &mut Issues, item: &Value, deferred: &mut Vec<Value>) -> ChoiceRead {
    let start = issues.count();
    let here = issues.path_here();
    let Some(fields) = issues.object(item) else {
        return ChoiceRead {
            choice: None,
            digit: None,
            aborted: true,
        };
    };
    let digit = issues
        .choice(fields, "digit", Presence::Required, &MENU_DIGITS)
        .into_option();
    let label = issues
        .text_with(
            fields,
            "label",
            Presence::Optional,
            Text::trimmed(None, Some(100)),
        )
        .into_option();
    let action = issues
        .choice(fields, "action", Presence::Required, &MENU_ACTIONS)
        .into_option();
    // `.nullish().transform((v) => v ?? undefined)`: a transform over a value
    // that failed a check answers `INVALID`.
    let before = issues.count();
    let voice_agent_id = issues
        .text(fields, "voiceAgentId", Presence::Nullish, Some(1), None)
        .into_option();
    let mut transformed_invalid = issues.count() > before;
    let department_id = issues
        .text(fields, "departmentId", Presence::Nullish, Some(1), None)
        .into_option();
    let before = issues.count();
    let forward_to_e164 = issues
        .pattern(
            fields,
            "forwardToE164",
            Presence::Nullish,
            None,
            None,
            is_e164,
            "Must be E.164",
        )
        .into_option();
    transformed_invalid |= issues.count() > before;
    let valid = issues.count() == start;
    let aborted = transformed_invalid || aborted_since(issues, start);
    if !aborted {
        if action.as_deref() == Some("ai_agent") && voice_agent_id.is_none() {
            deferred.push(custom(
                &here,
                &[json!("voiceAgentId")],
                "voiceAgentId is required for ai_agent choices",
            ));
        }
        if action.as_deref() == Some("forward") && forward_to_e164.is_none() {
            deferred.push(custom(
                &here,
                &[json!("forwardToE164")],
                "forwardToE164 is required for forward choices",
            ));
        }
    }
    let choice = valid.then(|| MenuChoice {
        digit: digit.clone().unwrap_or_default(),
        label,
        action: action.unwrap_or_default(),
        voice_agent_id,
        department_id,
        forward_to_e164,
    });
    ChoiceRead {
        choice,
        digit,
        aborted,
    }
}

/// `deskPhoneMenuSchema` on the object at `menu`: the menu, and whether it
/// is `INVALID`.
fn read_menu(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    deferred: &mut Vec<Value>,
) -> (Menu, bool) {
    let start = issues.count();
    let here = issues.path_here();
    let prompt = issues
        .text_with(
            fields,
            "prompt",
            Presence::Required,
            Text::trimmed(Some(1), Some(TEXT_MAX_LENGTH)),
        )
        .into_option()
        .unwrap_or_default();
    // Each item's digit, by index, for the refinement.
    let mut digits: Vec<Option<String>> = Vec::new();
    let mut choice_aborted = false;
    let choices = issues
        .list(
            fields,
            "choices",
            Presence::Required,
            Some(1),
            Some(9),
            |issues, item| {
                let read = read_choice(issues, item, deferred);
                digits.push(read.digit);
                choice_aborted |= read.aborted;
                read.choice
            },
        )
        .into_option()
        .unwrap_or_default();
    let fallback_digit = issues
        .choice(fields, "fallbackDigit", Presence::Nullish, &MENU_DIGITS)
        .into_option();
    let aborted = choice_aborted || aborted_since(issues, start);
    if !aborted {
        let mut seen: Vec<&str> = Vec::new();
        for (index, digit) in digits.iter().enumerate() {
            let digit = digit.as_deref().unwrap_or_default();
            if seen.contains(&digit) {
                deferred.push(custom(
                    &here,
                    &[json!("choices"), json!(index), json!("digit")],
                    &format!("Digit {digit} is used twice"),
                ));
            }
            seen.push(digit);
        }
        if let Some(fallback) = fallback_digit.as_deref()
            && !seen.contains(&fallback)
        {
            deferred.push(custom(
                &here,
                &[json!("fallbackDigit")],
                "fallbackDigit must be one of the choices",
            ));
        }
    }
    let menu = Menu {
        prompt,
        choices,
        fallback_digit,
    };
    (menu, aborted)
}

/// `deskPhoneRouteOptionsSchema` on the object at `options`: the options,
/// and whether they are `INVALID` (the route's own refinement then does not
/// run).
pub(crate) fn read_options(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    deferred: &mut Vec<Value>,
) -> (Options, bool) {
    let start = issues.count();
    let greeting = spoken(issues, fields, "greeting");
    let language = issues
        .pattern(
            fields,
            "language",
            Presence::Optional,
            None,
            None,
            is_bcp47,
            "Must be a BCP 47 language tag",
        )
        .into_option();
    let department_id = issues
        .text(fields, "departmentId", Presence::Nullish, Some(1), None)
        .into_option();
    let ring_seconds = seconds(issues, fields, "ringSeconds", RING_SECONDS_RANGE);
    let max_wait_seconds = seconds(issues, fields, "maxWaitSeconds", MAX_WAIT_SECONDS_RANGE);
    let when_unanswered = issues
        .choice(
            fields,
            "whenUnanswered",
            Presence::Optional,
            &UNANSWERED_ACTIONS,
        )
        .into_option();
    let voicemail_greeting = spoken(issues, fields, "voicemailGreeting");
    let mut menu = None;
    let mut menu_aborted = false;
    issues.nested(fields, "menu", Presence::Optional, |issues, fields| {
        let (read, aborted) = read_menu(issues, fields, deferred);
        menu = Some(read);
        menu_aborted = aborted;
    });
    let options = Options {
        greeting,
        language,
        department_id,
        ring_seconds,
        max_wait_seconds,
        when_unanswered,
        voicemail_greeting,
        menu,
    };
    (options, menu_aborted || aborted_since(issues, start))
}

/// `OPTION_KEYS_BY_ACTION`: which options each action uses.
fn option_keys(action: &str) -> &'static [&'static str] {
    match action {
        "agents" => &[
            "greeting",
            "language",
            "departmentId",
            "ringSeconds",
            "maxWaitSeconds",
            "whenUnanswered",
            "voicemailGreeting",
        ],
        "voicemail" => &["language", "voicemailGreeting"],
        "menu" => &[
            "language",
            "menu",
            "ringSeconds",
            "maxWaitSeconds",
            "whenUnanswered",
            "voicemailGreeting",
        ],
        _ => &[],
    }
}

/// `normalizeMenuChoice(choice)`: a menu choice with only the fields its
/// action uses.
fn normalize_choice(choice: &MenuChoice) -> Value {
    let mut out = Map::new();
    out.insert("digit".to_owned(), json!(choice.digit));
    if let Some(label) = choice.label.as_deref().filter(|label| !label.is_empty()) {
        out.insert("label".to_owned(), json!(label));
    }
    out.insert("action".to_owned(), json!(choice.action));
    let own = |action: &str, value: &Option<String>| {
        (choice.action == action)
            .then(|| value.as_deref().filter(|text| !text.is_empty()))
            .flatten()
            .map(str::to_owned)
    };
    if let Some(id) = own("ai_agent", &choice.voice_agent_id) {
        out.insert("voiceAgentId".to_owned(), json!(id));
    }
    if let Some(id) = own("agents", &choice.department_id) {
        out.insert("departmentId".to_owned(), json!(id));
    }
    if let Some(number) = own("forward", &choice.forward_to_e164) {
        out.insert("forwardToE164".to_owned(), json!(number));
    }
    Value::Object(out)
}

/// `normalizeDeskPhoneRouteOptions(action, options)`: the options as they
/// are stored for `action`. Options the action does not use are dropped,
/// empty texts and nulls left out, menu choices cut down to their own
/// fields. `None` (stored as null) when nothing is left.
pub(crate) fn normalize(action: &str, options: Option<&Options>) -> Option<Value> {
    let options = options?;
    let keys = option_keys(action);
    let mut out = Map::new();
    let mut text = |key: &str, value: &Option<String>| {
        if keys.contains(&key)
            && let Some(value) = value.as_deref().filter(|text| !text.is_empty())
        {
            out.insert(key.to_owned(), json!(value));
        }
    };
    text("greeting", &options.greeting);
    text("language", &options.language);
    text("departmentId", &options.department_id);
    text("whenUnanswered", &options.when_unanswered);
    text("voicemailGreeting", &options.voicemail_greeting);
    for (key, value) in [
        ("ringSeconds", options.ring_seconds),
        ("maxWaitSeconds", options.max_wait_seconds),
    ] {
        if keys.contains(&key)
            && let Some(value) = value
        {
            out.insert(key.to_owned(), json!(value));
        }
    }
    if keys.contains(&"menu")
        && let Some(menu) = &options.menu
    {
        let mut stored = Map::new();
        stored.insert("prompt".to_owned(), json!(menu.prompt));
        stored.insert(
            "choices".to_owned(),
            menu.choices.iter().map(normalize_choice).collect(),
        );
        if let Some(fallback) = menu.fallback_digit.as_deref().filter(|d| !d.is_empty()) {
            stored.insert("fallbackDigit".to_owned(), json!(fallback));
        }
        out.insert("menu".to_owned(), Value::Object(stored));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// The choices of normalised options' menu.
fn menu_choices(options: Option<&Value>) -> impl Iterator<Item = &Value> {
    options
        .and_then(|options| options["menu"]["choices"].as_array())
        .into_iter()
        .flatten()
}

/// `referencedTeamIds(options)`: the teams normalised options point at,
/// their own and their menu choices', each once.
pub(crate) fn referenced_team_ids(options: Option<&Value>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let own = options.and_then(|options| options["departmentId"].as_str());
    let of_choices = menu_choices(options).filter_map(|choice| choice["departmentId"].as_str());
    for id in own.into_iter().chain(of_choices) {
        if !id.is_empty() && !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// `referencedVoiceAgentIds(options)`: the voice agents the menu's AI
/// choices name, each once.
pub(crate) fn referenced_voice_agent_ids(options: Option<&Value>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for choice in menu_choices(options) {
        if choice["action"] == "ai_agent"
            && let Some(id) = choice["voiceAgentId"].as_str().filter(|id| !id.is_empty())
            && !ids.iter().any(|known| known == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body's `options` read as the route reads them: the options, whether
    /// they are `INVALID`, and the issues as `(code path, message)`, the
    /// refinements last.
    fn read(options: &Value) -> (Options, bool, Vec<(String, String)>) {
        let mut issues = Issues::default();
        let mut deferred = Vec::new();
        let body = json!({ "options": options });
        let mut read = (Options::default(), false);
        let fields = body.as_object().expect("object");
        issues.nested(fields, "options", Presence::Nullish, |issues, fields| {
            read = read_options(issues, fields, &mut deferred);
        });
        for issue in deferred {
            issues.push_raw(issue);
        }
        let found = match issues.finish() {
            Ok(()) => Vec::new(),
            Err(invalid) => invalid
                .issues()
                .iter()
                .map(|issue| {
                    let path: Vec<String> = issue["path"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|part| {
                            part.as_str()
                                .map_or_else(|| part.to_string(), str::to_owned)
                        })
                        .collect();
                    (
                        format!(
                            "{} {}",
                            issue["code"].as_str().unwrap_or_default(),
                            path.join(".")
                        ),
                        issue["message"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect(),
        };
        (read.0, read.1, found)
    }

    /// The issues as `code path`.
    fn found(options: &Value) -> Vec<String> {
        read(options).2.into_iter().map(|(at, _)| at).collect()
    }

    #[test]
    fn language_tags_match_the_schemas_pattern() {
        for tag in ["en", "en-US", "nl-NL", "zh-Hant-TW", "sgn-BE-FR"] {
            assert!(is_bcp47(tag), "{tag}");
        }
        for tag in ["", "e", "english please", "en-", "en_US", "en-U", "abcd"] {
            assert!(!is_bcp47(tag), "{tag}");
        }
    }

    // The expectations below are what Zod answers for the same bodies
    // (`upsertDeskPhoneRouteSchema.safeParseAsync`).

    #[test]
    fn checks_are_reported_in_the_schemas_order() {
        assert_eq!(
            found(&json!({ "ringSeconds": 9 })),
            ["too_small options.ringSeconds"]
        );
        let (_, aborted, issues) =
            read(&json!({ "maxWaitSeconds": 1801, "ringSeconds": 12.5, "greeting": 1 }));
        assert!(aborted);
        let expected = [
            (
                "invalid_type options.greeting",
                "Expected string, received number",
            ),
            (
                "invalid_type options.ringSeconds",
                "Expected integer, received float",
            ),
            (
                "too_big options.maxWaitSeconds",
                "Number must be less than or equal to 1800",
            ),
        ];
        assert_eq!(issues.len(), expected.len());
        for ((at, message), (expected_at, expected_message)) in issues.iter().zip(expected) {
            assert_eq!(
                (at.as_str(), message.as_str()),
                (expected_at, expected_message)
            );
        }
        // A fraction is a failed check, not a wrong type: the body stays
        // valid enough for the route's own refinement.
        assert!(!read(&json!({ "ringSeconds": 12.5 })).1);
        let (_, aborted, issues) =
            read(&json!({ "language": "english please", "whenUnanswered": "ring" }));
        assert!(aborted);
        assert_eq!(issues[0].1, "Must be a BCP 47 language tag");
        assert_eq!(issues[1].0, "invalid_enum_value options.whenUnanswered");
        // Blank texts trim to nothing; a menu's prompt needs a character.
        assert_eq!(
            found(&json!({ "greeting": "   ", "menu": {
                "prompt": "   ",
                "choices": [{ "digit": "1", "action": "voicemail" }],
            } })),
            ["too_small options.menu.prompt"]
        );
    }

    #[test]
    fn refinements_settle_after_the_checks_innermost_first() {
        let menu = json!({ "menu": {
            "prompt": "",
            "choices": [
                { "digit": "1", "action": "ai_agent" },
                { "digit": "1", "action": "voicemail", "label": "x".repeat(101) },
                { "digit": "2", "action": "forward" },
            ],
            "fallbackDigit": "9",
        } });
        let (_, aborted, issues) = read(&menu);
        assert!(!aborted);
        let expected = [
            (
                "too_small options.menu.prompt",
                "String must contain at least 1 character(s)",
            ),
            (
                "too_big options.menu.choices.1.label",
                "String must contain at most 100 character(s)",
            ),
            (
                "custom options.menu.choices.0.voiceAgentId",
                "voiceAgentId is required for ai_agent choices",
            ),
            (
                "custom options.menu.choices.2.forwardToE164",
                "forwardToE164 is required for forward choices",
            ),
            (
                "custom options.menu.choices.1.digit",
                "Digit 1 is used twice",
            ),
            (
                "custom options.menu.fallbackDigit",
                "fallbackDigit must be one of the choices",
            ),
        ];
        assert_eq!(issues.len(), expected.len());
        for ((at, message), (expected_at, expected_message)) in issues.iter().zip(expected) {
            assert_eq!(
                (at.as_str(), message.as_str()),
                (expected_at, expected_message)
            );
        }
        // A check that fails without a transform over it leaves the menu in
        // place for its refinement.
        assert_eq!(
            found(
                &json!({ "departmentId": "", "menu": { "prompt": "P", "choices": [
                { "digit": "1", "action": "agents", "departmentId": "" },
                { "digit": "1", "action": "agents" },
            ] } })
            ),
            [
                "too_small options.departmentId",
                "too_small options.menu.choices.0.departmentId",
                "custom options.menu.choices.1.digit",
            ]
        );
    }

    #[test]
    fn an_invalid_value_stops_the_refinements_around_it() {
        // A key off the keypad: the choice and the menu are INVALID, the
        // next choice is still refined.
        let (_, aborted, issues) = read(&json!({ "menu": { "prompt": "Pick.", "choices": [
            { "digit": "A", "action": "ai_agent" },
            { "digit": "1", "action": "forward" },
        ], "fallbackDigit": "5" } }));
        assert!(aborted);
        let listed: Vec<&str> = issues.iter().map(|(at, _)| at.as_str()).collect();
        assert_eq!(
            listed,
            [
                "invalid_enum_value options.menu.choices.0.digit",
                "custom options.menu.choices.1.forwardToE164",
            ]
        );
        // A check that fails under a transform makes the choice INVALID.
        let (_, aborted, issues) = read(&json!({ "menu": { "prompt": "P", "choices": [
            { "digit": "1", "action": "ai_agent", "voiceAgentId": "" },
            { "digit": "1", "action": "forward" },
        ], "fallbackDigit": "7" } }));
        assert!(aborted);
        let listed: Vec<&str> = issues.iter().map(|(at, _)| at.as_str()).collect();
        assert_eq!(
            listed,
            [
                "too_small options.menu.choices.0.voiceAgentId",
                "custom options.menu.choices.1.forwardToE164",
            ]
        );
        let (_, aborted, issues) = read(&json!({ "menu": { "prompt": "P", "choices": [
            { "digit": "1", "action": "forward", "forwardToE164": "0612" },
        ] } }));
        assert!(aborted);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].1, "Must be E.164");
        assert_eq!(
            found(&json!({ "menu": { "prompt": "Pick.", "choices": [] } })),
            ["too_small options.menu.choices"]
        );
        assert_eq!(
            found(&json!({ "menu": { "prompt": "Pick.", "choices": ["x"] } })),
            ["invalid_type options.menu.choices.0"]
        );
        assert_eq!(
            found(&json!({ "menu": null })),
            ["invalid_type options.menu"]
        );
    }

    #[test]
    fn options_are_stored_for_their_action() {
        let all = json!({
            "greeting": " Welcome. ",
            "language": "nl-NL",
            "departmentId": "dept_1",
            "ringSeconds": 30,
            "maxWaitSeconds": 600,
            "whenUnanswered": "hangup",
            "voicemailGreeting": "Leave a message.",
            "menu": { "prompt": " Pick. ", "choices": [
                { "digit": "1", "label": "  ", "action": "voicemail", "voiceAgentId": "dva_1",
                  "forwardToE164": "+31612349000", "departmentId": "dept_1" },
                { "digit": "2", "label": "Sales", "action": "agents", "departmentId": "dept_2" },
                { "digit": "3", "action": "ai_agent", "voiceAgentId": "dva_1" },
            ], "fallbackDigit": null },
        });
        let (options, aborted, issues) = read(&all);
        assert!(issues.is_empty(), "{issues:?}");
        assert!(!aborted);
        assert_eq!(
            normalize("agents", Some(&options)),
            Some(json!({
                "greeting": "Welcome.",
                "language": "nl-NL",
                "departmentId": "dept_1",
                "ringSeconds": 30,
                "maxWaitSeconds": 600,
                "whenUnanswered": "hangup",
                "voicemailGreeting": "Leave a message.",
            }))
        );
        assert_eq!(
            normalize("voicemail", Some(&options)),
            Some(json!({ "language": "nl-NL", "voicemailGreeting": "Leave a message." }))
        );
        let menu = normalize("menu", Some(&options)).expect("menu options");
        assert_eq!(
            menu["menu"],
            json!({ "prompt": "Pick.", "choices": [
                { "digit": "1", "action": "voicemail" },
                { "digit": "2", "label": "Sales", "action": "agents", "departmentId": "dept_2" },
                { "digit": "3", "action": "ai_agent", "voiceAgentId": "dva_1" },
            ] })
        );
        assert!(menu.get("greeting").is_none() && menu.get("departmentId").is_none());
        assert_eq!(referenced_team_ids(Some(&menu)), ["dept_2"]);
        assert_eq!(referenced_voice_agent_ids(Some(&menu)), ["dva_1"]);
        for action in ["ai_agent", "forward", "hangup"] {
            assert_eq!(normalize(action, Some(&options)), None);
        }
        assert_eq!(normalize("agents", None), None);
        assert_eq!(normalize("agents", Some(&Options::default())), None);
    }
}
