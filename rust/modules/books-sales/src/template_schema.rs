//! `invoiceTemplateDocumentSchema` and the create / update schemas of the
//! invoice designer (`@weldsuite/books-domain/invoice-template/schema`), read
//! as Zod reads them: the fields in shape order, unknown keys dropped, the
//! blocks a discriminated union on `type`, and the document's
//! `superRefine` (exactly one line-items table, not repeated or hidden, no
//! duplicate block ids) settled last and only when nothing was aborted.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// How a field is read.
#[derive(Clone, Copy)]
enum Kind {
    Str(Option<usize>, Option<usize>),
    Num(f64, f64),
    Bool,
    Enum(&'static [&'static str]),
    /// `colorSchema`: `#rrggbb` or a theme token.
    Color,
    /// `hexColor`.
    Hex,
    ImageUrl,
    Obj(&'static [Spec]),
    /// `columns`: 1 to 12 line-item columns.
    Columns,
}

type Spec = (&'static str, Kind, bool);

const ALIGN: &[&str] = &["left", "center", "right"];
const COLOR_TOKENS: &[&str] = &["accent", "text", "muted"];
const TEMPLATE_FIELDS: &[&str] = &[
    "title",
    "invoiceNumber",
    "issueDate",
    "dueDate",
    "reference",
    "placeOfSupply",
    "currency",
    "total",
    "balanceDue",
    "amountPaid",
    "paymentTerms",
    "customerName",
    "customerEmail",
    "customerTaxId",
    "sellerName",
    "sellerLegalName",
    "sellerEmail",
    "sellerPhone",
    "sellerWebsite",
    "sellerTaxId",
    "sellerRegistrationId",
    "sellerIban",
    "sellerBic",
    "footerText",
];
const LINE_ITEM_COLUMNS: &[&str] = &[
    "index",
    "description",
    "hsnSac",
    "quantity",
    "unit",
    "unitPrice",
    "discount",
    "taxRate",
    "taxAmount",
    "amount",
    "amountWithTax",
];

const TEXT_STYLE: &[Spec] = &[
    ("fontSize", Kind::Num(5.0, 72.0), false),
    ("bold", Kind::Bool, false),
    ("italic", Kind::Bool, false),
    ("color", Kind::Color, false),
    ("align", Kind::Enum(ALIGN), false),
    ("lineHeight", Kind::Num(0.8, 3.0), false),
    ("uppercase", Kind::Bool, false),
];
const BOX_STYLE: &[Spec] = &[
    ("background", Kind::Color, false),
    ("borderColor", Kind::Color, false),
    ("borderWidth", Kind::Num(0.0, 10.0), false),
    ("radius", Kind::Num(0.0, 40.0), false),
    ("padding", Kind::Num(0.0, 40.0), false),
];
const LABEL_STYLE: &[Spec] = &[
    ("show", Kind::Bool, false),
    ("text", Kind::Str(None, Some(120)), false),
    ("fontSize", Kind::Num(5.0, 36.0), false),
    ("color", Kind::Color, false),
    ("bold", Kind::Bool, false),
    ("uppercase", Kind::Bool, false),
];
const BASE: &[Spec] = &[
    ("id", Kind::Str(Some(1), Some(40)), true),
    ("x", Kind::Num(-50.0, 1000.0), true),
    ("y", Kind::Num(-50.0, 1000.0), true),
    ("w", Kind::Num(2.0, 1000.0), true),
    ("h", Kind::Num(0.5, 1000.0), true),
    ("everyPage", Kind::Bool, false),
    ("hidden", Kind::Bool, false),
    ("locked", Kind::Bool, false),
    ("box", Kind::Obj(BOX_STYLE), false),
];
const PARTY: &[Spec] = &[
    ("label", Kind::Obj(LABEL_STYLE), false),
    ("style", Kind::Obj(TEXT_STYLE), false),
    ("boldName", Kind::Bool, false),
    ("inline", Kind::Bool, false),
];
const COLUMN: &[Spec] = &[
    ("key", Kind::Enum(LINE_ITEM_COLUMNS), true),
    ("width", Kind::Num(0.0, 100.0), true),
    ("label", Kind::Str(None, Some(60)), false),
    ("align", Kind::Enum(ALIGN), false),
];
const TABLE_HEADER: &[Spec] = &[
    ("background", Kind::Color, false),
    ("color", Kind::Color, false),
    ("bold", Kind::Bool, false),
    ("uppercase", Kind::Bool, false),
    ("fontSize", Kind::Num(5.0, 16.0), false),
    ("rule", Kind::Color, false),
];
const TOTAL_ROW: &[Spec] = &[
    ("fontSize", Kind::Num(5.0, 36.0), false),
    ("color", Kind::Color, false),
    ("background", Kind::Color, false),
    ("rule", Kind::Color, false),
];
const MARGINS: &[Spec] = &[
    ("top", Kind::Num(0.0, 300.0), true),
    ("bottom", Kind::Num(0.0, 300.0), true),
];
const THEME: &[Spec] = &[
    ("font", Kind::Enum(&["helvetica", "times", "courier"]), true),
    ("accent", Kind::Hex, true),
    ("text", Kind::Hex, true),
    ("muted", Kind::Hex, true),
    ("fontSize", Kind::Num(6.0, 14.0), true),
];

/// The block types, in the union's order.
const BLOCK_TYPES: &[&str] = &[
    "text",
    "field",
    "logo",
    "image",
    "seller",
    "billTo",
    "shipTo",
    "lineItems",
    "totals",
    "payment",
    "notes",
    "terms",
    "legal",
    "rect",
    "line",
    "pageNumber",
];

/// The fields of a block after `type` (the party blocks put their shared
/// fields before it).
fn block_fields(kind: &str) -> (&'static [Spec], &'static [Spec]) {
    const NONE: &[Spec] = &[];
    match kind {
        "text" => (
            NONE,
            &[
                ("text", Kind::Str(None, Some(5000)), true),
                ("style", Kind::Obj(TEXT_STYLE), false),
            ],
        ),
        "field" => (
            NONE,
            &[
                ("field", Kind::Enum(TEMPLATE_FIELDS), true),
                ("layout", Kind::Enum(&["stacked", "inline", "value"]), false),
                ("label", Kind::Obj(LABEL_STYLE), false),
                ("style", Kind::Obj(TEXT_STYLE), false),
            ],
        ),
        "logo" => (
            NONE,
            &[
                ("align", Kind::Enum(ALIGN), false),
                ("fallbackStyle", Kind::Obj(TEXT_STYLE), false),
            ],
        ),
        "image" => (
            NONE,
            &[
                ("src", Kind::ImageUrl, true),
                ("align", Kind::Enum(ALIGN), false),
            ],
        ),
        "seller" => (
            PARTY,
            &[
                ("showContact", Kind::Bool, false),
                ("showTaxIds", Kind::Bool, false),
            ],
        ),
        "billTo" => (PARTY, &[("showEmail", Kind::Bool, false)]),
        "shipTo" => (PARTY, NONE),
        "lineItems" => (
            NONE,
            &[
                ("columns", Kind::Columns, true),
                ("fontSize", Kind::Num(5.0, 16.0), false),
                ("header", Kind::Obj(TABLE_HEADER), false),
                ("rowRule", Kind::Color, false),
                ("zebra", Kind::Color, false),
                ("rowPadding", Kind::Num(0.0, 16.0), false),
            ],
        ),
        "totals" => (
            NONE,
            &[
                ("style", Kind::Obj(TEXT_STYLE), false),
                ("total", Kind::Obj(TOTAL_ROW), false),
                ("showBalance", Kind::Bool, false),
            ],
        ),
        "payment" => (
            NONE,
            &[
                ("label", Kind::Obj(LABEL_STYLE), false),
                ("style", Kind::Obj(TEXT_STYLE), false),
                ("showInstructions", Kind::Bool, false),
                ("showBank", Kind::Bool, false),
            ],
        ),
        "notes" => (
            NONE,
            &[
                ("label", Kind::Obj(LABEL_STYLE), false),
                ("style", Kind::Obj(TEXT_STYLE), false),
            ],
        ),
        "terms" => (
            NONE,
            &[
                ("label", Kind::Obj(LABEL_STYLE), false),
                ("style", Kind::Obj(TEXT_STYLE), false),
                ("text", Kind::Str(None, Some(5000)), false),
            ],
        ),
        "legal" | "pageNumber" => (NONE, &[("style", Kind::Obj(TEXT_STYLE), false)]),
        "line" => (
            NONE,
            &[
                ("color", Kind::Color, false),
                ("thickness", Kind::Num(0.25, 10.0), false),
                (
                    "orientation",
                    Kind::Enum(&["horizontal", "vertical"]),
                    false,
                ),
            ],
        ),
        _ => (NONE, NONE),
    }
}

/// Issue codes that abort a parse (a refinement above them doesn't run).
const ABORTING: [&str; 5] = [
    "invalid_type",
    "invalid_enum_value",
    "invalid_literal",
    "invalid_union",
    "invalid_union_discriminator",
];

fn aborted_since(issues: &Issues, from: usize) -> bool {
    issues
        .issues_since(from)
        .iter()
        .any(|issue| ABORTING.contains(&issue["code"].as_str().unwrap_or_default()))
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_hex(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `/^(https?://|data:image/(png|jpeg);base64,)/i`.
fn is_image_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:image/png;base64,")
        || lower.starts_with("data:image/jpeg;base64,")
}

fn regex_issue(issues: &mut Issues, key: &str) {
    issues.push_issue(
        key,
        json!({ "validation": "regex", "code": "invalid_string", "message": "Invalid" }),
    );
}

/// `colorSchema` at `key` (present).
fn read_color(issues: &mut Issues, key: &str, value: &Value) -> Option<Value> {
    if let Value::String(text) = value {
        if is_hex(text) || COLOR_TOKENS.contains(&text.as_str()) {
            return Some(value.clone());
        }
        // The hex option parsed the string (dirty): its regex issue stands for the union.
        regex_issue(issues, key);
        return None;
    }
    let path = issues.path_of(key);
    let got = received(value);
    let tokens = "'accent' | 'text' | 'muted'";
    issues.push_issue(
        key,
        json!({
            "code": "invalid_union",
            "unionErrors": [
                { "issues": [{ "code": "invalid_type", "expected": "string", "received": got, "path": path, "message": format!("Expected string, received {got}") }], "name": "ZodError" },
                { "issues": [{ "code": "invalid_type", "expected": tokens, "received": got, "path": path, "message": format!("Expected {tokens}, received {got}") }], "name": "ZodError" },
            ],
            "message": "Invalid input",
        }),
    );
    None
}

fn read_field(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    spec: &Spec,
    out: &mut Map<String, Value>,
) {
    let (key, kind, required) = *spec;
    let presence = if required {
        Presence::Required
    } else {
        Presence::Optional
    };
    let value = match kind {
        Kind::Str(min, max) => issues
            .text(fields, key, presence, min, max)
            .into_option()
            .map(Value::String),
        Kind::Num(min, max) => issues
            .number(
                fields,
                key,
                presence,
                Number {
                    min: Some(min),
                    max: Some(max),
                    ..Number::default()
                },
            )
            .into_option()
            .map(js::number_value),
        Kind::Bool => issues
            .boolean(fields, key, presence)
            .into_option()
            .map(Value::Bool),
        Kind::Enum(options) => issues
            .choice(fields, key, presence, options)
            .into_option()
            .map(Value::String),
        Kind::Color => match fields.get(key) {
            None if !required => None,
            None => {
                issues.text(fields, key, Presence::Required, None, None);
                None
            }
            Some(value) => read_color(issues, key, value),
        },
        Kind::Hex => match issues.text(fields, key, presence, None, None) {
            Field::Set(text) if is_hex(&text) => Some(Value::String(text)),
            Field::Set(_) => {
                regex_issue(issues, key);
                None
            }
            _ => None,
        },
        Kind::ImageUrl => {
            // `.max(500000).regex(...)`: a too-long string still gets its regex check.
            let text = issues
                .text(fields, key, presence, None, Some(500_000))
                .into_option();
            if let Some(Value::String(raw)) = fields.get(key)
                && !is_image_url(raw)
            {
                regex_issue(issues, key);
                None
            } else {
                text.map(Value::String)
            }
        }
        Kind::Obj(specs) => issues
            .nested(fields, key, presence, |issues, inner| {
                Value::Object(read_object(issues, inner, specs))
            })
            .into_option(),
        Kind::Columns => issues
            .list(fields, key, presence, Some(1), Some(12), |issues, item| {
                let inner = issues.object(item)?;
                Some(Value::Object(read_object(issues, inner, COLUMN)))
            })
            .into_option()
            .map(Value::Array),
    };
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

fn read_object(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    specs: &[Spec],
) -> Map<String, Value> {
    let mut out = Map::new();
    for spec in specs {
        read_field(issues, fields, spec, &mut out);
    }
    out
}

/// One block of the discriminated union.
fn read_block(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let kind = fields.get("type").and_then(Value::as_str);
    let Some(kind) = kind.filter(|k| BLOCK_TYPES.contains(k)) else {
        issues.invalid_discriminator("type", BLOCK_TYPES);
        return None;
    };
    let (before_type, after_type) = block_fields(kind);
    let mut out = read_object(issues, fields, BASE);
    for spec in before_type {
        read_field(issues, fields, spec, &mut out);
    }
    out.insert("type".into(), json!(kind));
    for spec in after_type {
        read_field(issues, fields, spec, &mut out);
    }
    Some(Value::Object(out))
}

/// A document read without its refinement; `aborted` when a type check failed.
fn read_document_fields(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    match fields.get("version") {
        Some(value) if value.as_f64() == Some(1.0) => {
            out.insert("version".into(), json!(1));
        }
        value => {
            let got = value.cloned();
            let mut issue = json!({ "code": "invalid_literal", "expected": 1, "message": "Invalid literal value, expected 1" });
            if let Some(got) = got {
                issue["received"] = got;
            }
            issues.push_issue("version", issue);
        }
    }
    read_field(
        issues,
        fields,
        &("paperSize", Kind::Enum(&["a4", "letter"]), true),
        &mut out,
    );
    read_field(
        issues,
        fields,
        &("margins", Kind::Obj(MARGINS), true),
        &mut out,
    );
    read_field(issues, fields, &("theme", Kind::Obj(THEME), true), &mut out);
    if let Some(blocks) = issues
        .list(
            fields,
            "blocks",
            Presence::Required,
            None,
            Some(200),
            read_block,
        )
        .into_option()
    {
        out.insert("blocks".into(), Value::Array(blocks));
    }
    out
}

/// The document's `superRefine`, at the document's path.
fn refine_document(issues: &mut Issues, fields: &Map<String, Value>) {
    let blocks = fields
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tables: Vec<&Value> = blocks.iter().filter(|b| b["type"] == "lineItems").collect();
    let path = [json!("document"), json!("blocks")];
    if tables.len() != 1 {
        issues.custom_at(&path, "A template has exactly one line-items table");
    }
    if tables.first().is_some_and(|t| t["everyPage"] == true) {
        issues.custom_at(&path, "The line-items table cannot repeat on every page");
    }
    if tables.first().is_some_and(|t| t["hidden"] == true) {
        issues.custom_at(&path, "The line-items table cannot be hidden");
    }
    let mut seen: Vec<String> = Vec::new();
    for block in &blocks {
        let id = block["id"].as_str().unwrap_or_default().to_owned();
        if seen.contains(&id) {
            issues.custom_at(&path, &format!("Duplicate block id {id}"));
        }
        seen.push(id);
    }
}

/// A document at `key`: the parsed value, and the refinement to settle after
/// every other field (`None` when it doesn't run).
fn read_document(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> (Option<Value>, bool) {
    let before = issues.count();
    let document = issues
        .nested(body, "document", presence, read_document_fields)
        .into_option();
    let refine =
        body.get("document").is_some_and(Value::is_object) && !aborted_since(issues, before);
    (document.map(Value::Object), refine)
}

/// `createInvoiceTemplateSchema`.
#[derive(Debug, Clone)]
pub(crate) struct CreateTemplate {
    pub entity_id: String,
    pub name: String,
    pub is_default: Option<bool>,
    pub document: Value,
}

/// `updateInvoiceTemplateSchema`.
#[derive(Debug, Clone, Default)]
pub(crate) struct UpdateTemplate {
    pub name: Option<String>,
    pub is_default: Option<bool>,
    pub document: Option<Value>,
}

/// Settles the document's refinement after every other field.
fn settle(issues: &mut Issues, body: &Map<String, Value>, refine: bool) {
    if refine && let Some(Value::Object(document)) = body.get("document") {
        refine_document(issues, document);
    }
}

pub(crate) fn read_create(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> Option<CreateTemplate> {
    let entity_id = issues.text(body, "entityId", Presence::Required, Some(1), Some(30));
    let name = issues.text_with(
        body,
        "name",
        Presence::Required,
        Text::trimmed(Some(1), Some(120)),
    );
    let is_default = issues.boolean(body, "isDefault", Presence::Optional);
    let (document, refine) = read_document(issues, body, Presence::Required);
    settle(issues, body, refine);
    Some(CreateTemplate {
        entity_id: entity_id.into_option()?,
        name: name.into_option()?,
        is_default: is_default.into_option(),
        document: document?,
    })
}

pub(crate) fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> UpdateTemplate {
    let name = issues.text_with(
        body,
        "name",
        Presence::Optional,
        Text::trimmed(Some(1), Some(120)),
    );
    let is_default = issues.boolean(body, "isDefault", Presence::Optional);
    let (document, refine) = read_document(issues, body, Presence::Optional);
    settle(issues, body, refine);
    UpdateTemplate {
        name: name.into_option(),
        is_default: is_default.into_option(),
        document,
    }
}
