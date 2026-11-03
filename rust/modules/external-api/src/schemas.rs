//! The schemas a route defines inline (not exported, so not generated),
//! written out by hand from the route files.

use crate::zod::{Keys, N, S, Z};

/// `z.string().optional()`.
const OPT_STR: Z = Z::Opt(&Z::Str(&[]));

/// `limit: z.coerce.number().min(1).max(200).optional()`.
const LIMIT: Z = Z::Opt(&Z::CoerceNum(&[
    N::Min(1.0, true, None),
    N::Max(200.0, true, None),
]));

// ---------------------------------------------------------------------------
// quotes/index.ts
// ---------------------------------------------------------------------------

/// `createQuoteSchema`.
pub(crate) const CREATE_QUOTE: Z = Z::Obj(
    &[
        ("name", Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ("quoteNumber", OPT_STR),
        ("counterpartyId", OPT_STR),
        ("personId", OPT_STR),
        ("opportunityId", OPT_STR),
        ("currency", Z::Opt(&Z::Str(&[S::Max(10, None)]))),
        (
            "validFrom",
            Z::Opt(&Z::Str(&[S::Datetime {
                offset: false,
                msg: None,
            }])),
        ),
        (
            "validUntil",
            Z::Opt(&Z::Str(&[S::Datetime {
                offset: false,
                msg: None,
            }])),
        ),
        ("lineItems", Z::Opt(&Z::Arr(&Z::Rec(&Z::Any), None, None))),
        ("notes", OPT_STR),
    ],
    Keys::Strip,
);

/// `createQuoteSchema.partial()`.
pub(crate) const UPDATE_QUOTE: Z = Z::Obj(
    &[
        (
            "name",
            Z::Opt(&Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ),
        ("quoteNumber", OPT_STR),
        ("counterpartyId", OPT_STR),
        ("personId", OPT_STR),
        ("opportunityId", OPT_STR),
        ("currency", Z::Opt(&Z::Str(&[S::Max(10, None)]))),
        (
            "validFrom",
            Z::Opt(&Z::Str(&[S::Datetime {
                offset: false,
                msg: None,
            }])),
        ),
        (
            "validUntil",
            Z::Opt(&Z::Str(&[S::Datetime {
                offset: false,
                msg: None,
            }])),
        ),
        ("lineItems", Z::Opt(&Z::Arr(&Z::Rec(&Z::Any), None, None))),
        ("notes", OPT_STR),
    ],
    Keys::Strip,
);

/// `listQuoteQuery`.
pub(crate) const LIST_QUOTES: Z = Z::Obj(
    &[("cursor", OPT_STR), ("limit", LIMIT), ("search", OPT_STR)],
    Keys::Strip,
);

/// A list query: `cursor`, `limit`, then `z.string().optional()` filters
/// (and `name: Z` pairs for others), in the route's order.
macro_rules! list_query {
    ($($key:literal $(: $z:expr)?),* $(,)?) => {
        Z::Obj(
            &[("cursor", OPT_STR), ("limit", LIMIT), $(($key, list_query!(@field $($z)?))),*],
            Keys::Strip,
        )
    };
    (@field) => { OPT_STR };
    (@field $z:expr) => { $z };
}

/// `z.coerce.boolean().optional()`.
const OPT_FLAG: Z = Z::Opt(&Z::CoerceBool);

// ---------------------------------------------------------------------------
// Flow (the routes' inline list queries)
// ---------------------------------------------------------------------------

pub(crate) const LIST_PROJECTS: Z =
    list_query!("search", "status", "ownerId", "isActive": OPT_FLAG);
pub(crate) const LIST_GOALS: Z = list_query!("projectId");
pub(crate) const LIST_MILESTONES: Z = list_query!("search", "projectId", "status");
pub(crate) const LIST_SPRINTS: Z = list_query!("search", "projectId", "status");
pub(crate) const LIST_TASK_COMMENTS: Z = list_query!("search", "taskId");
pub(crate) const LIST_TASK_TAGS: Z = list_query!("search", "userId");
pub(crate) const LIST_PROJECT_DOCUMENTS: Z = list_query!("search", "projectId", "parentId");
pub(crate) const LIST_PROJECT_FILES: Z = list_query!("search", "projectId", "fileType");
pub(crate) const LIST_PROJECT_LABELS: Z = list_query!("search", "projectId");
pub(crate) const LIST_PROJECT_MEMBERS: Z = list_query!("projectId", "userId", "role");
pub(crate) const LIST_PROJECT_MESSAGES: Z = list_query!("search", "projectId");
pub(crate) const LIST_WHITEBOARDS: Z = list_query!("search", "projectId");
pub(crate) const LIST_TASKS: Z = list_query!(
    "search",
    "projectId",
    "assigneeId",
    "status",
    "priority",
    "type",
    "sprintId",
    "milestoneId",
    "parentTaskId",
    "dueDateFrom",
    "dueDateTo",
);
pub(crate) const LIST_TIME_ENTRIES: Z = list_query!(
    "projectId",
    "taskId",
    "userId",
    "status",
    "billable": OPT_FLAG,
    "fromDate",
    "toDate",
);

/// `z.union([z.string(), z.number()])`.
const STR_OR_NUM: Z = Z::Union(&[Z::Str(&[]), Z::Num(&[])]);

/// time-entries' `createTimeEntrySchema` (`.passthrough()`).
pub(crate) const CREATE_TIME_ENTRY: Z = Z::Obj(
    &[
        ("projectId", OPT_STR),
        ("taskId", OPT_STR),
        ("userId", OPT_STR),
        ("date", Z::Str(&[])),
        ("duration", STR_OR_NUM),
        ("description", OPT_STR),
        ("activity", OPT_STR),
        ("billable", Z::Def(&Z::Bool, "true")),
        ("rate", Z::Opt(&STR_OR_NUM)),
        ("startTime", OPT_STR),
        ("endTime", OPT_STR),
        ("location", OPT_STR),
        ("isRemote", Z::Def(&Z::Bool, "false")),
    ],
    Keys::Passthrough,
);

/// `createTimeEntrySchema.partial()`: no defaults.
pub(crate) const UPDATE_TIME_ENTRY: Z = Z::Obj(
    &[
        ("projectId", OPT_STR),
        ("taskId", OPT_STR),
        ("userId", OPT_STR),
        ("date", OPT_STR),
        ("duration", Z::Opt(&STR_OR_NUM)),
        ("description", OPT_STR),
        ("activity", OPT_STR),
        ("billable", Z::Opt(&Z::Def(&Z::Bool, "true"))),
        ("rate", Z::Opt(&STR_OR_NUM)),
        ("startTime", OPT_STR),
        ("endTime", OPT_STR),
        ("location", OPT_STR),
        ("isRemote", Z::Opt(&Z::Def(&Z::Bool, "false"))),
    ],
    Keys::Passthrough,
);

// ---------------------------------------------------------------------------
// Desk and Commerce (inline schemas)
// ---------------------------------------------------------------------------

pub(crate) const LIST_ARTICLES: Z = list_query!("search", "status", "authorId");

/// categories' `createCategorySchema` (`.passthrough()`).
pub(crate) const CREATE_CATEGORY: Z = Z::Obj(
    &[
        ("name", Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ("slug", Z::Opt(&Z::Str(&[S::Max(255, None)]))),
        (
            "description",
            Z::Opt(&Z::Nul(&Z::Str(&[S::Max(5000, None)]))),
        ),
        ("parentId", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(30, None)])))),
        ("position", Z::Opt(&Z::Num(&[N::Int(None)]))),
        ("image", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(500, None)])))),
        (
            "isActive",
            Z::Opt(&Z::Union(&[Z::Bool, Z::Num(&[N::Int(None)])])),
        ),
        ("type", Z::Opt(&Z::Enum(&["manual", "automated"], None))),
    ],
    Keys::Passthrough,
);

/// `createCategorySchema.partial()`.
pub(crate) const UPDATE_CATEGORY: Z = Z::Obj(
    &[
        (
            "name",
            Z::Opt(&Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ),
        ("slug", Z::Opt(&Z::Str(&[S::Max(255, None)]))),
        (
            "description",
            Z::Opt(&Z::Nul(&Z::Str(&[S::Max(5000, None)]))),
        ),
        ("parentId", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(30, None)])))),
        ("position", Z::Opt(&Z::Num(&[N::Int(None)]))),
        ("image", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(500, None)])))),
        (
            "isActive",
            Z::Opt(&Z::Union(&[Z::Bool, Z::Num(&[N::Int(None)])])),
        ),
        ("type", Z::Opt(&Z::Enum(&["manual", "automated"], None))),
    ],
    Keys::Passthrough,
);

pub(crate) const LIST_CATEGORIES: Z = list_query!("search", "parentId", "type");

// ---------------------------------------------------------------------------
// Chat, Calendar, Commerce, Social (the routes' inline list queries)
// ---------------------------------------------------------------------------

pub(crate) const LIST_CHANNELS: Z = list_query!("search", "type");
pub(crate) const LIST_CHANNEL_MEMBERS: Z = list_query!("channelId", "userId");
pub(crate) const LIST_CHAT_MESSAGES: Z = list_query!("search", "channelId", "parentId");
pub(crate) const LIST_CHAT_BOOKMARKS: Z = list_query!("userId", "channelId");
pub(crate) const LIST_CHAT_DRAFTS: Z = list_query!("channelId", "userId");
pub(crate) const LIST_CHAT_SECTIONS: Z = list_query!("search");
pub(crate) const LIST_CALENDARS: Z = list_query!("search", "ownerId");
pub(crate) const LIST_CALENDAR_EVENTS: Z = list_query!("search", "calendarId");
pub(crate) const LIST_PRODUCTS: Z = list_query!("search", "status");
pub(crate) const LIST_ORDERS: Z = list_query!("search", "status", "customerId");
pub(crate) const LIST_SOCIAL_ACCOUNTS: Z = list_query!("platform", "status");
pub(crate) const LIST_SOCIAL_CAMPAIGNS: Z = list_query!("status");
pub(crate) const LIST_SOCIAL_ANALYTICS: Z = list_query!("postId", "accountId");
pub(crate) const LIST_SOCIAL_MEDIA: Z = list_query!("mediaType", "status");

// ---------------------------------------------------------------------------
// Books (the routes' inline list queries)
// ---------------------------------------------------------------------------

/// The read-only ledger resources' `listQuery`.
pub(crate) const LIST_READ_ONLY: Z = list_query!("entityId");
pub(crate) const LIST_ACCOUNTING_CONTACTS: Z = list_query!("search", "role");

// ---------------------------------------------------------------------------
// knowledge-pages/index.ts
// ---------------------------------------------------------------------------

/// `icon: z.string().max(100).nullish()`.
const ICON: Z = Z::Opt(&Z::Nul(&Z::Str(&[S::Max(100, None)])));
/// `coverImage: z.string().max(1000).nullish()`.
const COVER_IMAGE: Z = Z::Opt(&Z::Nul(&Z::Str(&[S::Max(1000, None)])));

/// `contentJson: z.array(z.record(z.unknown())).optional()`.
const CONTENT_JSON: Z = Z::Opt(&Z::Arr(&Z::Rec(&Z::Any), None, None));

/// `listPagesQuery`.
pub(crate) const LIST_KNOWLEDGE_PAGES: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", LIMIT),
        ("search", OPT_STR),
        ("spaceId", OPT_STR),
        ("parentId", OPT_STR),
    ],
    Keys::Strip,
);

/// `createPageSchema`.
pub(crate) const CREATE_KNOWLEDGE_PAGE: Z = Z::Obj(
    &[
        ("spaceId", Z::Str(&[S::Min(1, None)])),
        ("parentId", Z::Opt(&Z::Nul(&Z::Str(&[])))),
        ("title", Z::Opt(&Z::Str(&[S::Max(500, None)]))),
        ("icon", ICON),
        ("coverImage", COVER_IMAGE),
        ("content", OPT_STR),
        ("contentJson", CONTENT_JSON),
    ],
    Keys::Strip,
);

/// `updatePageSchema`.
pub(crate) const UPDATE_KNOWLEDGE_PAGE: Z = Z::Obj(
    &[
        ("title", Z::Opt(&Z::Str(&[S::Max(500, None)]))),
        ("icon", ICON),
        ("coverImage", COVER_IMAGE),
        ("isLocked", Z::Opt(&Z::Bool)),
        ("content", OPT_STR),
        ("contentJson", CONTENT_JSON),
    ],
    Keys::Strip,
);

/// `movePageSchema`.
pub(crate) const MOVE_KNOWLEDGE_PAGE: Z = Z::Obj(
    &[
        ("parentId", Z::Nul(&Z::Str(&[]))),
        ("spaceId", OPT_STR),
        (
            "position",
            Z::Opt(&Z::Num(&[N::Int(None), N::Min(0.0, true, None)])),
        ),
    ],
    Keys::Strip,
);

// ---------------------------------------------------------------------------
// drive/index.ts, tickets/index.ts
// ---------------------------------------------------------------------------

/// `listAllQuery`.
pub(crate) const LIST_DRIVE_ALL: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", LIMIT),
        ("search", OPT_STR),
        ("type", OPT_STR),
        ("folderId", OPT_STR),
        ("source", OPT_STR),
    ],
    Keys::Strip,
);

/// `listMessagesQuery` (a ticket's messages).
pub(crate) const LIST_TICKET_MESSAGES: Z =
    Z::Obj(&[("cursor", OPT_STR), ("limit", LIMIT)], Keys::Strip);

// ---------------------------------------------------------------------------
// webhooks/index.ts, workflows/index.ts
// ---------------------------------------------------------------------------

/// `z.array(z.enum([...methods])).optional()`.
const METHODS: Z = Z::Opt(&Z::Arr(
    &Z::Enum(&["GET", "POST", "PUT", "PATCH", "DELETE"], None),
    None,
    None,
));

/// `createWebhookSchema`.
pub(crate) const CREATE_WEBHOOK: Z = Z::Obj(
    &[
        ("name", Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ("description", OPT_STR),
        ("workflowId", OPT_STR),
        ("url", Z::Str(&[S::Url(None)])),
        ("isEnabled", Z::Opt(&Z::Bool)),
        ("allowedMethods", METHODS),
        ("headers", Z::Opt(&Z::Rec(&Z::Str(&[])))),
    ],
    Keys::Strip,
);

/// `createWebhookSchema.partial()`.
pub(crate) const UPDATE_WEBHOOK: Z = Z::Obj(
    &[
        (
            "name",
            Z::Opt(&Z::Str(&[S::Min(1, None), S::Max(255, None)])),
        ),
        ("description", Z::Opt(&OPT_STR)),
        ("workflowId", Z::Opt(&OPT_STR)),
        ("url", Z::Opt(&Z::Str(&[S::Url(None)]))),
        ("isEnabled", Z::Opt(&Z::Opt(&Z::Bool))),
        ("allowedMethods", Z::Opt(&METHODS)),
        ("headers", Z::Opt(&Z::Opt(&Z::Rec(&Z::Str(&[]))))),
    ],
    Keys::Strip,
);

/// `listWebhooksQuery`.
pub(crate) const LIST_WEBHOOKS: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", LIMIT),
        ("workflowId", OPT_STR),
        ("isEnabled", Z::Opt(&Z::CoerceBool)),
    ],
    Keys::Strip,
);

/// `listWorkflowsQuery`.
pub(crate) const LIST_WORKFLOWS: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", LIMIT),
        ("search", OPT_STR),
        ("status", OPT_STR),
        ("folderId", OPT_STR),
    ],
    Keys::Strip,
);

/// `listSchedulesQuery`.
pub(crate) const LIST_SCHEDULES: Z = Z::Obj(
    &[
        ("cursor", OPT_STR),
        ("limit", LIMIT),
        ("isEnabled", Z::Opt(&Z::CoerceBool)),
    ],
    Keys::Strip,
);

/// `listExecutionsQuery`.
pub(crate) const LIST_EXECUTIONS: Z = Z::Obj(
    &[("cursor", OPT_STR), ("limit", LIMIT), ("status", OPT_STR)],
    Keys::Strip,
);
