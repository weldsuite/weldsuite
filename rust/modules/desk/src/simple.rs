//! The plain CRUD route files ([`crate::crud`]): help-center FAQs, news,
//! announcements, feedback and reviews, SLAs, ticket notes, ticket messages
//! and satisfaction surveys. Schemas from
//! `@weldsuite/core-api-client/schemas/*` (all `.passthrough()`).

use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};

use crate::crud::{Changed, Crud, Filter, Gates, Messages, Partial};
use crate::tables;

const ARTICLES: Gates = Gates {
    read: perm::ARTICLES_READ,
    create: perm::ARTICLES_CREATE,
    update: perm::ARTICLES_UPDATE,
    delete: perm::ARTICLES_DELETE,
};

const TICKETS: Gates = Gates {
    read: perm::TICKETS_READ,
    create: perm::TICKETS_CREATE,
    update: perm::TICKETS_UPDATE,
    delete: perm::TICKETS_DELETE,
};

const SLAS: Gates = Gates {
    read: perm::SLAS_READ,
    create: perm::SLAS_CREATE,
    update: perm::SLAS_UPDATE,
    delete: perm::SLAS_DELETE,
};

/// The keyset condition at parameters `$a` (skip), `$b` (createdAt), `$c` (id).
macro_rules! cursor {
    ($a:literal, $b:literal, $c:literal) => {
        concat!(
            "($",
            $a,
            "::boolean or (t.created_at < $",
            $b,
            "::timestamp or (t.created_at = $",
            $b,
            "::timestamp and t.id < $",
            $c,
            "::text)))"
        )
    };
}

/// The list statement of a table with `$filters` filter slots: `$1` skips
/// the live-only condition, each filter takes `(skip, value)`, the cursor
/// `(skip, createdAt, id)`, then the limit.
macro_rules! listing {
    ($table:literal; $($cond:literal),*; $a:literal, $b:literal, $c:literal; $limit:literal) => {
        (
            concat!(
                "select to_jsonb(t) from \"", $table, "\" t where ($1::boolean or t.deleted_at is null)",
                $(" and ", $cond,)*
                " and ", cursor!($a, $b, $c),
                " order by t.created_at desc, t.id desc limit ", $limit
            ),
            concat!(
                "select count(*) from \"", $table, "\" t where ($1::boolean or t.deleted_at is null)",
                $(" and ", $cond,)*
                " and ", cursor!($a, $b, $c)
            ),
        )
    };
}

const FAQ_LIST: (&str, &str) = listing!("helpdesk_faqs";
    "($2::boolean or t.category = $3::text)";
    4, 5, 6; "$7");
const TITLE_SEARCH_NEWS: (&str, &str) = listing!("helpdesk_news";
    "($2::boolean or t.title like $3::text)";
    4, 5, 6; "$7");
const TITLE_SEARCH_ANNOUNCEMENTS: (&str, &str) = listing!("helpdesk_announcements";
    "($2::boolean or t.title like $3::text)";
    4, 5, 6; "$7");
const TITLE_SEARCH_FEEDBACK: (&str, &str) = listing!("helpdesk_feedback";
    "($2::boolean or t.title like $3::text)";
    4, 5, 6; "$7");
const TITLE_SEARCH_REVIEWS: (&str, &str) = listing!("helpdesk_reviews";
    "($2::boolean or t.title like $3::text)";
    4, 5, 6; "$7");
const SLA_LIST: (&str, &str) = listing!("helpdesk_slas";
    "($2::boolean or t.name like $3::text)";
    4, 5, 6; "$7");
const NOTE_LIST: (&str, &str) = listing!("helpdesk_ticket_notes";
    "($2::boolean or t.ticket_id = $3::text)", "($4::boolean or t.author_id = $5::text)";
    6, 7, 8; "$9");
const MESSAGE_LIST: (&str, &str) = listing!("helpdesk_ticket_messages";
    "($2::boolean or t.ticket_id = $3::text)", "($4::boolean or t.author_id = $5::text)",
    "($6::boolean or t.subject like $7::text)";
    8, 9, 10; "$11");
const SURVEY_LIST: (&str, &str) = listing!("helpdesk_satisfaction_surveys";
    "($2::boolean or t.ticket_id = $3::text)", "($4::boolean or t.customer_id = $5::text)",
    "($6::boolean or t.status = $7::text)";
    8, 9, 10; "$11");

const fn messages(
    list: &'static str,
    fetch: &'static str,
    create: &'static str,
    update: &'static str,
    delete: &'static str,
) -> Messages {
    Messages {
        list,
        fetch,
        create,
        update,
        delete,
    }
}

/// `z.string().min(min).max(max)` with `presence`.
fn string(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) {
    issues.text(body, key, presence, min, max);
}

/// `z.string().email().max(255)` with `presence`.
fn email(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.text_with(
        body,
        key,
        presence,
        Text {
            format: Some(Format::Email),
            max: Some(255),
            ..Text::default()
        },
    );
}

/// `z.number().int()` (with `.min()`/`.max()`) with `presence`.
fn integer(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<f64>,
    max: Option<f64>,
) {
    issues.whole_number(
        body,
        key,
        presence,
        Number {
            int: true,
            min,
            max,
            ..Number::default()
        },
    );
}

/// `z.array(z.string())` with `presence`.
fn strings(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.list(body, key, presence, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
}

const OPT: Presence = Presence::Optional;
const NULLISH: Presence = Presence::Nullish;

fn faq_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "question", partial.required(), Some(1), None);
    string(issues, body, "answer", partial.required(), None, None);
    string(issues, body, "category", OPT, None, Some(100));
    integer(issues, body, "sortOrder", OPT, None, None);
    issues.boolean(body, "isPublished", OPT);
}

fn news_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(
        issues,
        body,
        "title",
        partial.required(),
        Some(1),
        Some(500),
    );
    string(issues, body, "excerpt", OPT, None, None);
    string(issues, body, "body", OPT, None, None);
    string(issues, body, "publishedAt", OPT, None, None);
    string(issues, body, "authorId", NULLISH, None, None);
    issues.boolean(body, "isPublished", OPT);
    strings(issues, body, "tags", OPT);
}

fn announcement_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(
        issues,
        body,
        "title",
        partial.required(),
        Some(1),
        Some(500),
    );
    string(issues, body, "body", OPT, None, None);
    string(issues, body, "startsAt", OPT, None, None);
    string(issues, body, "endsAt", OPT, None, None);
    issues.boolean(body, "isPublished", OPT);
    string(issues, body, "audience", OPT, None, Some(50));
}

fn feedback_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(
        issues,
        body,
        "title",
        partial.required(),
        Some(1),
        Some(500),
    );
    string(issues, body, "body", OPT, None, None);
    string(issues, body, "type", OPT, None, Some(50));
    integer(issues, body, "rating", OPT, Some(1.0), Some(5.0));
    string(issues, body, "customerName", OPT, None, Some(255));
    email(issues, body, "customerEmail", OPT);
}

fn review_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(
        issues,
        body,
        "title",
        partial.required(),
        Some(1),
        Some(500),
    );
    string(issues, body, "body", OPT, None, None);
    integer(issues, body, "rating", OPT, Some(1.0), Some(5.0));
    string(issues, body, "customerName", OPT, None, Some(255));
    email(issues, body, "customerEmail", OPT);
    string(issues, body, "ticketId", NULLISH, None, None);
    issues.boolean(body, "isPublished", OPT);
}

fn sla_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "description", OPT, None, None);
    string(issues, body, "priority", OPT, None, Some(20));
    integer(issues, body, "responseTimeMinutes", OPT, None, None);
    integer(issues, body, "resolutionTimeMinutes", OPT, None, None);
    issues.boolean(body, "isActive", OPT);
    issues.boolean(body, "isDefault", OPT);
}

fn note_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "ticketId", partial.required(), None, None);
    string(issues, body, "authorId", NULLISH, None, None);
    string(issues, body, "authorName", OPT, None, Some(255));
    string(issues, body, "body", partial.required(), None, None);
    issues.boolean(body, "isPinned", OPT);
    strings(issues, body, "mentions", OPT);
}

fn message_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "ticketId", partial.required(), None, None);
    string(issues, body, "subject", OPT, None, Some(500));
    string(issues, body, "body", OPT, None, None);
    string(issues, body, "bodyHtml", OPT, None, None);
    issues.choice(
        body,
        "authorType",
        OPT,
        &["agent", "customer", "system", "bot"],
    );
    string(issues, body, "authorId", NULLISH, None, None);
    string(issues, body, "authorName", OPT, None, Some(255));
    email(issues, body, "authorEmail", OPT);
    issues.choice(body, "direction", OPT, &["inbound", "outbound"]);
    string(issues, body, "channel", OPT, None, Some(30));
    issues.boolean(body, "isPublic", OPT);
    issues.boolean(body, "isInternal", OPT);
}

fn survey_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "ticketId", NULLISH, None, None);
    string(issues, body, "customerId", NULLISH, None, None);
    integer(issues, body, "rating", OPT, Some(1.0), Some(5.0));
    string(issues, body, "comment", OPT, None, None);
    string(issues, body, "status", OPT, None, Some(20));
}

pub(crate) static FAQS: Crud = Crud {
    table: &tables::HELPDESK_FAQS,
    resource: "FAQ",
    id_prefix: "faq",
    gates: ARTICLES,
    messages: messages(
        "Failed to list faqs",
        "Failed to fetch faq",
        "Failed to create faq",
        "Failed to update faq",
        "Failed to delete faq",
    ),
    schema: faq_schema,
    filters: &[Filter::eq("category")],
    list_sql: FAQ_LIST.0,
    count_sql: FAQ_LIST.1,
    slice_count: true,
    created: ev::HELPDESK_FAQ_CREATED,
    created_fields: &["category"],
    updated: ev::HELPDESK_FAQ_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("category")],
    deleted: ev::HELPDESK_FAQ_DELETED,
};

pub(crate) static NEWS: Crud = Crud {
    table: &tables::HELPDESK_NEWS,
    resource: "News item",
    id_prefix: "news",
    gates: ARTICLES,
    messages: messages(
        "Failed to list news items",
        "Failed to fetch news item",
        "Failed to create news item",
        "Failed to update news item",
        "Failed to delete news item",
    ),
    schema: news_schema,
    filters: &[Filter::like("search")],
    list_sql: TITLE_SEARCH_NEWS.0,
    count_sql: TITLE_SEARCH_NEWS.1,
    slice_count: true,
    created: ev::HELPDESK_NEWS_CREATED,
    created_fields: &["title"],
    updated: ev::HELPDESK_NEWS_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("title")],
    deleted: ev::HELPDESK_NEWS_DELETED,
};

pub(crate) static ANNOUNCEMENTS: Crud = Crud {
    table: &tables::HELPDESK_ANNOUNCEMENTS,
    resource: "Announcement",
    id_prefix: "ann",
    gates: ARTICLES,
    messages: messages(
        "Failed to list announcements",
        "Failed to fetch announcement",
        "Failed to create announcement",
        "Failed to update announcement",
        "Failed to delete announcement",
    ),
    schema: announcement_schema,
    filters: &[Filter::like("search")],
    list_sql: TITLE_SEARCH_ANNOUNCEMENTS.0,
    count_sql: TITLE_SEARCH_ANNOUNCEMENTS.1,
    slice_count: true,
    created: ev::HELPDESK_ANNOUNCEMENT_CREATED,
    created_fields: &["title"],
    updated: ev::HELPDESK_ANNOUNCEMENT_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("title")],
    deleted: ev::HELPDESK_ANNOUNCEMENT_DELETED,
};

pub(crate) static FEEDBACK: Crud = Crud {
    table: &tables::HELPDESK_FEEDBACK,
    resource: "Feedback",
    id_prefix: "fb",
    gates: TICKETS,
    messages: messages(
        "Failed to list feedbacks",
        "Failed to fetch feedback",
        "Failed to create feedback",
        "Failed to update feedback",
        "Failed to delete feedback",
    ),
    schema: feedback_schema,
    filters: &[Filter::like("search")],
    list_sql: TITLE_SEARCH_FEEDBACK.0,
    count_sql: TITLE_SEARCH_FEEDBACK.1,
    slice_count: true,
    created: ev::HELPDESK_FEEDBACK_CREATED,
    created_fields: &["title"],
    updated: ev::HELPDESK_FEEDBACK_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("title")],
    deleted: ev::HELPDESK_FEEDBACK_DELETED,
};

pub(crate) static REVIEWS: Crud = Crud {
    table: &tables::HELPDESK_REVIEWS,
    resource: "Review",
    id_prefix: "rev",
    gates: TICKETS,
    messages: messages(
        "Failed to list reviews",
        "Failed to fetch review",
        "Failed to create review",
        "Failed to update review",
        "Failed to delete review",
    ),
    schema: review_schema,
    filters: &[Filter::like("search")],
    list_sql: TITLE_SEARCH_REVIEWS.0,
    count_sql: TITLE_SEARCH_REVIEWS.1,
    slice_count: true,
    created: ev::HELPDESK_REVIEW_CREATED,
    created_fields: &["title"],
    updated: ev::HELPDESK_REVIEW_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("title")],
    deleted: ev::HELPDESK_REVIEW_DELETED,
};

pub(crate) static SLA: Crud = Crud {
    table: &tables::HELPDESK_SLAS,
    resource: "SLA",
    id_prefix: "sla",
    gates: SLAS,
    messages: messages(
        "Failed to list slas",
        "Failed to fetch sla",
        "Failed to create sla",
        "Failed to update sla",
        "Failed to delete sla",
    ),
    schema: sla_schema,
    filters: &[Filter::like("search")],
    list_sql: SLA_LIST.0,
    count_sql: SLA_LIST.1,
    slice_count: true,
    created: ev::SLA_CREATED,
    created_fields: &["name"],
    updated: ev::SLA_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("name")],
    deleted: ev::SLA_DELETED,
};

pub(crate) static TICKET_NOTES: Crud = Crud {
    table: &tables::HELPDESK_TICKET_NOTES,
    resource: "Ticket note",
    id_prefix: "tnote",
    gates: TICKETS,
    messages: messages(
        "Failed to list ticket notes",
        "Failed to fetch ticket note",
        "Failed to create ticket note",
        "Failed to update ticket note",
        "Failed to delete ticket note",
    ),
    schema: note_schema,
    filters: &[Filter::eq("ticketId"), Filter::eq("authorId")],
    list_sql: NOTE_LIST.0,
    count_sql: NOTE_LIST.1,
    slice_count: true,
    created: ev::TICKET_NOTE_CREATED,
    created_fields: &["ticketId", "authorId"],
    updated: ev::TICKET_NOTE_UPDATED,
    updated_fields: &[Changed::Existing("ticketId"), Changed::Existing("authorId")],
    deleted: ev::TICKET_NOTE_DELETED,
};

pub(crate) static TICKET_MESSAGES: Crud = Crud {
    table: &tables::HELPDESK_TICKET_MESSAGES,
    resource: "Ticket message",
    id_prefix: "tmsg",
    gates: TICKETS,
    messages: messages(
        "Failed to list ticket messages",
        "Failed to fetch ticket message",
        "Failed to create ticket message",
        "Failed to update ticket message",
        "Failed to delete ticket message",
    ),
    schema: message_schema,
    filters: &[
        Filter::eq("ticketId"),
        Filter::eq("authorId"),
        Filter::like("search"),
    ],
    list_sql: MESSAGE_LIST.0,
    count_sql: MESSAGE_LIST.1,
    slice_count: true,
    created: ev::HELPDESK_MESSAGE_CREATED,
    created_fields: &["ticketId", "authorId", "subject"],
    updated: ev::HELPDESK_MESSAGE_UPDATED,
    updated_fields: &[
        Changed::Existing("ticketId"),
        Changed::Existing("authorId"),
        Changed::UpdateOrExisting("subject"),
    ],
    deleted: ev::HELPDESK_MESSAGE_DELETED,
};

pub(crate) static SURVEYS: Crud = Crud {
    table: &tables::HELPDESK_SATISFACTION_SURVEYS,
    resource: "Satisfaction survey",
    id_prefix: "sat",
    gates: TICKETS,
    messages: messages(
        "Failed to list satisfaction surveys",
        "Failed to fetch satisfaction survey",
        "Failed to create satisfaction survey",
        "Failed to update satisfaction survey",
        "Failed to delete satisfaction survey",
    ),
    schema: survey_schema,
    filters: &[
        Filter::eq("ticketId"),
        Filter::eq("customerId"),
        Filter::eq("status"),
    ],
    list_sql: SURVEY_LIST.0,
    count_sql: SURVEY_LIST.1,
    slice_count: false,
    created: ev::SATISFACTION_SURVEY_CREATED,
    created_fields: &["ticketId", "customerId", "status"],
    updated: ev::SATISFACTION_SURVEY_UPDATED,
    updated_fields: &[
        Changed::Existing("ticketId"),
        Changed::Existing("customerId"),
        Changed::UpdateOrExisting("status"),
    ],
    deleted: ev::SATISFACTION_SURVEY_DELETED,
};
