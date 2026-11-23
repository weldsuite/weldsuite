//! The mail routes' inline Zod schemas (`routes/v1/mail-*/index.ts`),
//! written out by hand: none of them is exported, so the generator doesn't
//! see them.

use serde_json::Value;
use weldsuite_mail_domain::text::js_trim;

use crate::zod::{Hook, Keys, N, S, Z};

/// `z.string().optional()`.
const OPT_STR: Z = Z::Opt(&Z::Str(&[]));
/// `z.enum(['true', 'false']).optional()`.
const BOOL_FLAG: Z = Z::Opt(&Z::Enum(&["true", "false"], None));
/// `z.boolean().optional()`.
const OPT_BOOL: Z = Z::Opt(&Z::Bool);
/// `z.string().min(1)`.
const ID: Z = Z::Str(&[S::Min(1, None)]);

/// `z.coerce.number().min(1).max(max).optional()`.
macro_rules! limit {
    ($max:literal) => {
        Z::Opt(&Z::CoerceNum(&[
            N::Min(1.0, true, None),
            N::Max($max, true, None),
        ]))
    };
}

/// `z.string().max(n).optional()`.
macro_rules! opt_max {
    ($max:literal) => {
        Z::Opt(&Z::Str(&[S::Max($max, None)]))
    };
}

/// `z.string().email()`.
const EMAIL: Z = Z::Str(&[S::Email(None)]);
/// `z.array(z.string().email()).max(100)`.
const ADDRESSES: Z = Z::Arr(&EMAIL, None, Some((100, None)));
/// `addresses.min(1)`.
const RECIPIENTS: Z = Z::Arr(&EMAIL, Some((1, None)), Some((100, None)));
/// `z.array(z.string()).max(20).optional()`: upload ids.
const ATTACHMENT_IDS: Z = Z::Opt(&Z::Arr(&Z::Str(&[]), None, Some((20, None))));
/// `z.enum(['low', 'normal', 'high']).optional()`.
const IMPORTANCE: Z = Z::Opt(&Z::Enum(&["low", "normal", "high"], None));
/// The column holds `#RRGGBB`.
const COLOR: Z = Z::Opt(&Z::Str(&[S::Regex(
    "^#[0-9a-fA-F]{6}$",
    Some("Use a hex colour such as #4F46E5"),
)]));
/// `z.string().trim().min(1).max(100)`: a label name.
const LABEL_NAME: Z = Z::Str(&[S::Trim, S::Min(1, None), S::Max(100, None)]);
/// `z.array(labelName).max(50).optional()`.
const LABEL_LIST: Z = Z::Opt(&Z::Arr(&LABEL_NAME, None, Some((50, None))));

/// `.refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update')`.
fn nothing_to_update(value: Option<&Value>, hook: &mut Hook) {
    if value
        .and_then(Value::as_object)
        .is_none_or(|object| object.values().all(Value::is_null) || object.is_empty())
    {
        hook.fail("Nothing to update");
    }
}

/// `.refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, …)`.
fn some_labels(value: Option<&Value>, hook: &mut Hook) {
    let count = |key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    if count("add") + count("remove") == 0 {
        hook.fail("Give labels to add or remove");
    }
}

/// `hasContent`: a body or an HTML body with more than whitespace, else
/// `{ message: 'Give a body or an htmlBody', path: ['body'] }`.
fn has_content(value: Option<&Value>, hook: &mut Hook) {
    let filled = |key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .is_some_and(|text| !js_trim(text).is_empty())
    };
    if !filled("body") && !filled("htmlBody") {
        hook.fail_at(
            &[Value::String("body".to_owned())],
            "Give a body or an htmlBody",
        );
    }
}

// ---------------------------------------------------------------------------
// mail-accounts
// ---------------------------------------------------------------------------

pub(crate) const LIST_ACCOUNTS: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", limit!(200.0)),
        ("search", opt_max!(200)),
        ("status", opt_max!(50)),
    ],
    Keys::Strip,
);

// ---------------------------------------------------------------------------
// mail-messages
// ---------------------------------------------------------------------------

pub(crate) const LIST_MESSAGES: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", limit!(100.0)),
        ("accountId", OPT_STR),
        ("search", opt_max!(500)),
        ("from", opt_max!(200)),
        ("label", opt_max!(100)),
        ("threadId", OPT_STR),
        ("isRead", BOOL_FLAG),
        ("isStarred", BOOL_FLAG),
        ("isFlagged", BOOL_FLAG),
        ("hasAttachments", BOOL_FLAG),
        ("includeTrash", BOOL_FLAG),
        ("includeSpam", BOOL_FLAG),
    ],
    Keys::Strip,
);

pub(crate) const GET_MESSAGE: Z = Z::Obj(&[("includeHtml", BOOL_FLAG)], Keys::Strip);

pub(crate) const UPDATE_MESSAGE: Z = Z::Refine(
    &Z::Obj(
        &[
            ("isRead", OPT_BOOL),
            ("isStarred", OPT_BOOL),
            ("isFlagged", OPT_BOOL),
            ("isImportant", OPT_BOOL),
        ],
        Keys::Strip,
    ),
    nothing_to_update,
);

pub(crate) const MESSAGE_LABELS: Z = Z::Refine(
    &Z::Obj(&[("add", LABEL_LIST), ("remove", LABEL_LIST)], Keys::Strip),
    some_labels,
);

pub(crate) const MOVE: Z = Z::Obj(
    &[(
        "location",
        Z::Enum(&["inbox", "archive", "trash", "spam"], None),
    )],
    Keys::Strip,
);

/// `BULK_ACTIONS`.
pub(crate) const BULK_ACTIONS: [&str; 11] = [
    "markRead",
    "markUnread",
    "star",
    "unstar",
    "flag",
    "unflag",
    "archive",
    "trash",
    "spam",
    "restore",
    "delete",
];

pub(crate) const BULK: Z = Z::Obj(
    &[
        (
            "ids",
            Z::Arr(&Z::Str(&[]), Some((1, None)), Some((100, None))),
        ),
        ("action", Z::Enum(&BULK_ACTIONS, None)),
    ],
    Keys::Strip,
);

// ---------------------------------------------------------------------------
// mail-threads
// ---------------------------------------------------------------------------

pub(crate) const LIST_THREADS: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", limit!(100.0)),
        ("accountId", OPT_STR),
        ("label", opt_max!(100)),
        ("search", opt_max!(500)),
        ("from", opt_max!(200)),
        ("to", opt_max!(200)),
        ("subject", opt_max!(200)),
        ("hasAttachments", BOOL_FLAG),
    ],
    Keys::Strip,
);

pub(crate) const ACCOUNT_QUERY: Z = Z::Obj(&[("accountId", ID)], Keys::Strip);

pub(crate) const THREAD_READ: Z = Z::Obj(
    &[("accountId", ID), ("isRead", Z::Def(&Z::Bool, "true"))],
    Keys::Strip,
);

pub(crate) const THREAD_LABELS: Z = Z::Refine(
    &Z::Obj(
        &[
            ("accountId", ID),
            ("add", LABEL_LIST),
            ("remove", LABEL_LIST),
        ],
        Keys::Strip,
    ),
    some_labels,
);

// ---------------------------------------------------------------------------
// mail-labels
// ---------------------------------------------------------------------------

pub(crate) const LIST_LABELS: Z = Z::Obj(
    &[("accountId", OPT_STR), ("search", opt_max!(100))],
    Keys::Strip,
);

/// `aiKeywords: z.array(z.string().max(100)).max(50).optional()`.
const AI_KEYWORDS: Z = Z::Opt(&Z::Arr(
    &Z::Str(&[S::Max(100, None)]),
    None,
    Some((50, None)),
));
/// `aiConfidence: z.number().int().min(0).max(100).optional()`.
const AI_CONFIDENCE: Z = Z::Opt(&Z::Num(&[
    N::Int(None),
    N::Min(0.0, true, None),
    N::Max(100.0, true, None),
]));

pub(crate) const CREATE_LABEL: Z = Z::Obj(
    &[
        ("accountId", ID),
        ("name", LABEL_NAME),
        ("color", COLOR),
        ("aiEnabled", OPT_BOOL),
        ("aiKeywords", AI_KEYWORDS),
        ("aiDescription", opt_max!(1000)),
        ("aiConfidence", AI_CONFIDENCE),
    ],
    Keys::Strip,
);

pub(crate) const UPDATE_LABEL: Z = Z::Refine(
    &Z::Obj(
        &[
            ("name", Z::Opt(&LABEL_NAME)),
            ("color", COLOR),
            ("position", Z::Opt(&Z::Num(&[N::Int(None)]))),
            ("aiEnabled", OPT_BOOL),
            ("aiKeywords", AI_KEYWORDS),
            ("aiDescription", opt_max!(1000)),
            ("aiConfidence", AI_CONFIDENCE),
        ],
        Keys::Strip,
    ),
    nothing_to_update,
);

// ---------------------------------------------------------------------------
// mail-folders
// ---------------------------------------------------------------------------

pub(crate) const LIST_FOLDERS: Z = Z::Obj(&[("accountId", OPT_STR)], Keys::Strip);

/// `z.string().trim().min(1).max(255)`: a folder name.
const FOLDER_NAME: Z = Z::Str(&[S::Trim, S::Min(1, None), S::Max(255, None)]);

pub(crate) const CREATE_FOLDER: Z = Z::Obj(
    &[
        ("accountId", ID),
        ("name", FOLDER_NAME),
        ("parentId", OPT_STR),
        ("path", opt_max!(1000)),
        ("color", COLOR),
        ("icon", opt_max!(50)),
        ("position", Z::Opt(&Z::Num(&[N::Int(None)]))),
    ],
    Keys::Strip,
);

pub(crate) const UPDATE_FOLDER: Z = Z::Refine(
    &Z::Obj(
        &[
            ("name", Z::Opt(&FOLDER_NAME)),
            ("parentId", OPT_STR),
            ("path", opt_max!(1000)),
            ("color", COLOR),
            ("icon", opt_max!(50)),
            ("position", Z::Opt(&Z::Num(&[N::Int(None)]))),
        ],
        Keys::Strip,
    ),
    nothing_to_update,
);

// ---------------------------------------------------------------------------
// mail-drafts
// ---------------------------------------------------------------------------

pub(crate) const LIST_DRAFTS: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", limit!(100.0)),
        ("accountId", OPT_STR),
    ],
    Keys::Strip,
);

/// `draftFields`, after the account.
macro_rules! draft_fields {
    ($account:expr) => {
        &[
            ("accountId", $account),
            ("to", Z::Opt(&ADDRESSES)),
            ("cc", Z::Opt(&ADDRESSES)),
            ("bcc", Z::Opt(&ADDRESSES)),
            ("replyTo", Z::Opt(&Z::Arr(&EMAIL, None, Some((5, None))))),
            ("subject", opt_max!(998)),
            ("body", opt_max!(1_000_000)),
            ("htmlBody", opt_max!(2_000_000)),
            ("importance", IMPORTANCE),
            ("attachmentIds", ATTACHMENT_IDS),
            (
                "labels",
                Z::Opt(&Z::Arr(
                    &Z::Str(&[S::Max(100, None)]),
                    None,
                    Some((50, None)),
                )),
            ),
            ("inReplyTo", opt_max!(500)),
            ("originalMessageId", OPT_STR),
            ("isReply", OPT_BOOL),
            ("isForward", OPT_BOOL),
        ]
    };
}

pub(crate) const CREATE_DRAFT: Z = Z::Obj(draft_fields!(ID), Keys::Strip);

pub(crate) const UPDATE_DRAFT: Z = Z::Refine(
    &Z::Obj(draft_fields!(Z::Opt(&ID)), Keys::Strip),
    nothing_to_update,
);

// ---------------------------------------------------------------------------
// mail-sending
// ---------------------------------------------------------------------------

pub(crate) const SEND: Z = Z::Refine(
    &Z::Obj(
        &[
            ("to", RECIPIENTS),
            ("cc", Z::Opt(&ADDRESSES)),
            ("bcc", Z::Opt(&ADDRESSES)),
            ("replyTo", Z::Opt(&EMAIL)),
            ("subject", opt_max!(998)),
            ("body", opt_max!(1_000_000)),
            ("htmlBody", opt_max!(2_000_000)),
            ("importance", IMPORTANCE),
            ("attachmentIds", ATTACHMENT_IDS),
        ],
        Keys::Strip,
    ),
    has_content,
);

pub(crate) const REPLY: Z = Z::Refine(
    &Z::Obj(
        &[
            ("body", opt_max!(1_000_000)),
            ("htmlBody", opt_max!(2_000_000)),
            ("replyAll", Z::Def(&Z::Bool, "false")),
            ("attachmentIds", ATTACHMENT_IDS),
        ],
        Keys::Strip,
    ),
    has_content,
);

pub(crate) const FORWARD: Z = Z::Obj(
    &[
        ("to", RECIPIENTS),
        ("body", opt_max!(1_000_000)),
        ("htmlBody", opt_max!(2_000_000)),
        ("attachmentIds", ATTACHMENT_IDS),
        (
            "excludeAttachmentIds",
            Z::Opt(&Z::Arr(&Z::Str(&[]), None, Some((100, None)))),
        ),
        ("asAttachment", OPT_BOOL),
    ],
    Keys::Strip,
);

pub(crate) const DRAFT_SEND: Z = Z::Obj(&[("attachmentIds", ATTACHMENT_IDS)], Keys::Strip);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::zod::parse_issues;

    fn messages(schema: &Z, body: &Value) -> Vec<String> {
        parse_issues(schema, body)
            .err()
            .unwrap_or_default()
            .iter()
            .map(|issue| issue["message"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    const NONE: Vec<String> = Vec::new();

    #[test]
    fn sends_need_some_content() {
        assert_eq!(
            messages(
                &SEND,
                &json!({ "to": ["a@b.co"], "subject": "x", "body": "  " })
            ),
            vec!["Give a body or an htmlBody"]
        );
        assert_eq!(
            messages(&SEND, &json!({ "to": ["a@b.co"], "htmlBody": "<p>x</p>" })),
            NONE
        );
    }

    #[test]
    fn updates_need_a_field() {
        assert_eq!(
            messages(&UPDATE_MESSAGE, &json!({})),
            vec!["Nothing to update"]
        );
        assert_eq!(messages(&UPDATE_MESSAGE, &json!({ "isRead": false })), NONE);
    }

    #[test]
    fn label_changes_need_a_label() {
        assert_eq!(
            messages(&MESSAGE_LABELS, &json!({ "add": [] })),
            vec!["Give labels to add or remove"]
        );
    }
}
