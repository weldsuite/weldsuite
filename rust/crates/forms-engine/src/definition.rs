//! The WeldForms definition, `formDefinitionSchema` of
//! `packages/core/forms-engine/src/definition.ts` (the source of truth).
//!
//! Deserialising applies the schema's checks and defaults: a
//! [`FormDefinition`] or [`FormThemeTokens`] read with serde is what
//! `schema.parse(value)` returns, or an error carrying Zod's issues. The
//! checks are in [`super::schema`]; [`FormDefinition::parse`] returns the
//! issues themselves. Serialising writes the parsed shape back as Zod's
//! output would (defaults filled in, absent optional keys left out, whole
//! numbers as integers).

use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::js::{ser_num, ser_opt_num};
use super::schema::{self, SchemaIssue};

pub const DEFINITION_SCHEMA_VERSION: u32 = 1;

fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Media and choices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
}

/// Where the media sits next to the question in the conversational layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaPlacement {
    #[default]
    Above,
    SplitLeft,
    SplitRight,
    Background,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Media {
    pub kind: MediaKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default)]
    pub placement: MediaPlacement,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub label: String,
    /// Picture choice only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// Added to the `score` variable when chosen.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub score: Option<f64>,
    /// Marks the right answer in a quiz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct: Option<bool>,
}

/// A part of a contact info or address field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubField {
    pub enabled: bool,
    pub required: bool,
}

impl SubField {
    const fn new(enabled: bool, required: bool) -> Self {
        Self { enabled, required }
    }
}

// ---------------------------------------------------------------------------
// Field properties, one struct per type
// ---------------------------------------------------------------------------

/// `properties: z.object({}).default({})` (yes/no, legal, signature).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NoProps {}

/// Short and long text.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub max_length: Option<f64>,
}

/// Email and website.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PlaceholderProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_country: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NumberProps {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub min: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub max: Option<f64>,
    /// Allowed decimal places; 0 = whole numbers only.
    #[serde(default, serialize_with = "ser_num")]
    pub decimals: f64,
}

/// Display order of day, month and year; the answer is always `YYYY-MM-DD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DateFormat {
    #[default]
    #[serde(rename = "DMY")]
    Dmy,
    #[serde(rename = "MDY")]
    Mdy,
    #[serde(rename = "YMD")]
    Ymd,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DateProps {
    #[serde(default)]
    pub format: DateFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipleChoiceProps {
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub min_selections: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub max_selections: Option<f64>,
    #[serde(default)]
    pub allow_other: bool,
    #[serde(default)]
    pub randomize: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct DropdownProps {
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub randomize: bool,
    #[serde(default)]
    pub alphabetical: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // the schema's flags
pub struct PictureChoiceProps {
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub min_selections: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub max_selections: Option<f64>,
    #[serde(default)]
    pub allow_other: bool,
    #[serde(default)]
    pub randomize: bool,
    #[serde(default = "yes")]
    pub show_labels: bool,
}

impl Default for PictureChoiceProps {
    fn default() -> Self {
        Self {
            choices: Vec::new(),
            multiple: false,
            min_selections: None,
            max_selections: None,
            allow_other: false,
            randomize: false,
            show_labels: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RatingShape {
    #[default]
    Star,
    Heart,
    Thumb,
    Circle,
}

fn five() -> f64 {
    5.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RatingProps {
    #[serde(default = "five", serialize_with = "ser_num")]
    pub steps: f64,
    #[serde(default)]
    pub shape: RatingShape,
}

impl Default for RatingProps {
    fn default() -> Self {
        Self {
            steps: five(),
            shape: RatingShape::Star,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ScaleLabels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
}

fn one() -> f64 {
    1.0
}

fn ten() -> f64 {
    10.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpinionScaleProps {
    /// 0 or 1.
    #[serde(default = "one", serialize_with = "ser_num")]
    pub start: f64,
    #[serde(default = "ten", serialize_with = "ser_num")]
    pub end: f64,
    #[serde(default)]
    pub labels: ScaleLabels,
}

impl Default for OpinionScaleProps {
    fn default() -> Self {
        Self {
            start: one(),
            end: ten(),
            labels: ScaleLabels::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NpsLabels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NpsProps {
    #[serde(default)]
    pub labels: NpsLabels,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RankingProps {
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub randomize: bool,
}

/// A matrix row or column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixItem {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MatrixProps {
    pub rows: Vec<MatrixItem>,
    pub columns: Vec<MatrixItem>,
    #[serde(default)]
    pub multiple: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAccept {
    #[default]
    Any,
    Images,
    Documents,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadProps {
    #[serde(default = "one", serialize_with = "ser_num")]
    pub max_files: f64,
    /// Per file; the platform maximum is 25 MB.
    #[serde(default = "ten", serialize_with = "ser_num")]
    pub max_size_mb: f64,
    #[serde(default)]
    pub accept: FileAccept,
}

impl Default for FileUploadProps {
    fn default() -> Self {
        Self {
            max_files: one(),
            max_size_mb: ten(),
            accept: FileAccept::Any,
        }
    }
}

macro_rules! sub_field_default {
    ($name:ident, $enabled:literal, $required:literal) => {
        fn $name() -> SubField {
            SubField::new($enabled, $required)
        }
    };
}

sub_field_default!(on_required, true, true);
sub_field_default!(on_optional, true, false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactFields {
    #[serde(default = "on_required")]
    pub first_name: SubField,
    #[serde(default = "on_required")]
    pub last_name: SubField,
    #[serde(default = "on_required")]
    pub email: SubField,
    #[serde(default = "on_optional")]
    pub phone: SubField,
    #[serde(default = "on_optional")]
    pub company: SubField,
}

impl Default for ContactFields {
    fn default() -> Self {
        Self {
            first_name: on_required(),
            last_name: on_required(),
            email: on_required(),
            phone: on_optional(),
            company: on_optional(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContactInfoProps {
    #[serde(default)]
    pub fields: ContactFields,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressFields {
    #[serde(default = "on_required")]
    pub line1: SubField,
    #[serde(default = "on_optional")]
    pub line2: SubField,
    #[serde(default = "on_required")]
    pub city: SubField,
    #[serde(default = "on_optional")]
    pub state: SubField,
    #[serde(default = "on_required")]
    pub postal_code: SubField,
    #[serde(default = "on_required")]
    pub country: SubField,
}

impl Default for AddressFields {
    fn default() -> Self {
        Self {
            line1: on_required(),
            line2: on_optional(),
            city: on_required(),
            state: on_optional(),
            postal_code: on_required(),
            country: on_required(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AddressProps {
    #[serde(default)]
    pub fields: AddressFields,
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

macro_rules! field_kinds {
    ($($variant:ident($props:ty) = $name:literal,)*) => {
        /// A field's type with its properties.
        #[derive(Debug, Clone, PartialEq)]
        pub enum FieldKind {
            $($variant($props),)*
        }

        /// Every field type, in the schema's order (`FIELD_TYPES`).
        pub const FIELD_TYPES: &[&str] = &[$($name,)*];

        impl FieldKind {
            /// The `type` of the field (`short_text`, `multiple_choice`, …).
            pub fn type_name(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $name,)*
                }
            }

            fn from_json(type_name: &str, properties: Option<Value>) -> Result<Self, serde_json::Error> {
                match type_name {
                    $($name => Ok(Self::$variant(props(properties)?)),)*
                    other => Err(serde_json::Error::custom(format!("unknown field type {other:?}"))),
                }
            }

            fn serialize_properties<M: SerializeMap>(&self, map: &mut M) -> Result<(), M::Error> {
                match self {
                    $(Self::$variant(props) => map.serialize_entry("properties", props),)*
                }
            }
        }
    };
}

field_kinds! {
    ShortText(TextProps) = "short_text",
    LongText(TextProps) = "long_text",
    Email(PlaceholderProps) = "email",
    Phone(PhoneProps) = "phone",
    Number(NumberProps) = "number",
    Website(PlaceholderProps) = "website",
    Date(DateProps) = "date",
    MultipleChoice(MultipleChoiceProps) = "multiple_choice",
    Dropdown(DropdownProps) = "dropdown",
    PictureChoice(PictureChoiceProps) = "picture_choice",
    YesNo(NoProps) = "yes_no",
    Legal(NoProps) = "legal",
    Rating(RatingProps) = "rating",
    OpinionScale(OpinionScaleProps) = "opinion_scale",
    Nps(NpsProps) = "nps",
    Ranking(RankingProps) = "ranking",
    Matrix(MatrixProps) = "matrix",
    FileUpload(FileUploadProps) = "file_upload",
    Signature(NoProps) = "signature",
    ContactInfo(ContactInfoProps) = "contact_info",
    Address(AddressProps) = "address",
}

/// A field's `properties`, or its defaults when the key is left out.
fn props<T: Default + for<'de> Deserialize<'de>>(
    properties: Option<Value>,
) -> Result<T, serde_json::Error> {
    properties.map_or_else(|| Ok(T::default()), serde_json::from_value)
}

/// A question: any block but a statement, a group or a page break.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub id: String,
    /// Editable slug used in recall, prefill, integrations and exports.
    pub r#ref: String,
    pub title: String,
    pub description: Option<String>,
    pub media: Option<Media>,
    pub required: bool,
    /// The answer stays in forms-api: not on the entity-event bus, in
    /// notification emails or in WeldConnect payloads (ADR FORMS-004).
    pub sensitive: Option<bool>,
    pub kind: FieldKind,
}

/// The keys every field has.
#[derive(Deserialize)]
struct FieldBase {
    id: String,
    r#ref: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    media: Option<Media>,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    sensitive: Option<bool>,
}

impl Field {
    fn from_json(value: Value) -> Result<Self, serde_json::Error> {
        let type_name = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let properties = value.get("properties").cloned();
        let base: FieldBase = serde_json::from_value(value)?;
        Ok(Self {
            id: base.id,
            r#ref: base.r#ref,
            title: base.title,
            description: base.description,
            media: base.media,
            required: base.required,
            sensitive: base.sensitive,
            kind: FieldKind::from_json(&type_name, properties)?,
        })
    }
}

impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("ref", &self.r#ref)?;
        map.serialize_entry("title", &self.title)?;
        if let Some(description) = &self.description {
            map.serialize_entry("description", description)?;
        }
        if let Some(media) = &self.media {
            map.serialize_entry("media", media)?;
        }
        map.serialize_entry("required", &self.required)?;
        if let Some(sensitive) = &self.sensitive {
            map.serialize_entry("sensitive", sensitive)?;
        }
        map.serialize_entry("type", self.kind.type_name())?;
        self.kind.serialize_properties(&mut map)?;
        map.end()
    }
}

// ---------------------------------------------------------------------------
// Layout blocks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Statement {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub media: Option<Media>,
    #[serde(default)]
    pub properties: ButtonProps,
}

impl Serialize for Statement {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("ref", &self.r#ref)?;
        map.serialize_entry("type", "statement")?;
        map.serialize_entry("title", &self.title)?;
        if let Some(description) = &self.description {
            map.serialize_entry("description", description)?;
        }
        if let Some(media) = &self.media {
            map.serialize_entry("media", media)?;
        }
        map.serialize_entry("properties", &self.properties)?;
        map.end()
    }
}

/// A child of a group: a field or a statement (groups don't nest).
#[derive(Debug, Clone, PartialEq)]
pub enum GroupChild {
    Field(Field),
    Statement(Statement),
}

impl GroupChild {
    pub fn id(&self) -> &str {
        match self {
            Self::Field(field) => &field.id,
            Self::Statement(statement) => &statement.id,
        }
    }

    pub fn r#ref(&self) -> &str {
        match self {
            Self::Field(field) => &field.r#ref,
            Self::Statement(statement) => &statement.r#ref,
        }
    }

    pub fn as_field(&self) -> Option<&Field> {
        match self {
            Self::Field(field) => Some(field),
            Self::Statement(_) => None,
        }
    }

    /// Zod's `z.union([fieldBlockSchema, statementBlockSchema])`.
    fn from_json(value: Value) -> Result<Self, serde_json::Error> {
        if value.get("type").and_then(Value::as_str) == Some("statement") {
            serde_json::from_value(value).map(Self::Statement)
        } else {
            Field::from_json(value).map(Self::Field)
        }
    }
}

impl<'de> Deserialize<'de> for GroupChild {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_json(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl Serialize for GroupChild {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Field(field) => field.serialize(serializer),
            Self::Statement(statement) => statement.serialize(serializer),
        }
    }
}

/// Fields and statements shown together as one step.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Group {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub media: Option<Media>,
    #[serde(default)]
    pub properties: ButtonProps,
    pub children: Vec<GroupChild>,
}

impl Serialize for Group {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("ref", &self.r#ref)?;
        map.serialize_entry("type", "group")?;
        map.serialize_entry("title", &self.title)?;
        if let Some(description) = &self.description {
            map.serialize_entry("description", description)?;
        }
        if let Some(media) = &self.media {
            map.serialize_entry("media", media)?;
        }
        map.serialize_entry("properties", &self.properties)?;
        map.serialize_entry("children", &self.children)?;
        map.end()
    }
}

/// Starts a new page in the classic layout; ignored by the conversational one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PageBreak {
    pub id: String,
    pub r#ref: String,
    #[serde(default)]
    pub title: String,
}

impl Serialize for PageBreak {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("ref", &self.r#ref)?;
        map.serialize_entry("type", "page_break")?;
        map.serialize_entry("title", &self.title)?;
        map.end()
    }
}

/// A top-level block.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Field(Field),
    Statement(Statement),
    Group(Group),
    PageBreak(PageBreak),
}

impl Block {
    pub fn id(&self) -> &str {
        match self {
            Self::Field(field) => &field.id,
            Self::Statement(statement) => &statement.id,
            Self::Group(group) => &group.id,
            Self::PageBreak(page_break) => &page_break.id,
        }
    }

    pub fn r#ref(&self) -> &str {
        match self {
            Self::Field(field) => &field.r#ref,
            Self::Statement(statement) => &statement.r#ref,
            Self::Group(group) => &group.r#ref,
            Self::PageBreak(page_break) => &page_break.r#ref,
        }
    }

    /// The block's `type`: a field type, `statement`, `group` or `page_break`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Field(field) => field.kind.type_name(),
            Self::Statement(_) => "statement",
            Self::Group(_) => "group",
            Self::PageBreak(_) => "page_break",
        }
    }

    pub fn as_field(&self) -> Option<&Field> {
        match self {
            Self::Field(field) => Some(field),
            _ => None,
        }
    }

    pub fn is_page_break(&self) -> bool {
        matches!(self, Self::PageBreak(_))
    }

    /// Zod's `z.union([fieldBlockSchema, statement, group, pageBreak])`.
    fn from_json(value: Value) -> Result<Self, serde_json::Error> {
        match value.get("type").and_then(Value::as_str) {
            Some("statement") => serde_json::from_value(value).map(Self::Statement),
            Some("group") => serde_json::from_value(value).map(Self::Group),
            Some("page_break") => serde_json::from_value(value).map(Self::PageBreak),
            _ => Field::from_json(value).map(Self::Field),
        }
    }
}

impl<'de> Deserialize<'de> for Block {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_json(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl Serialize for Block {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Field(field) => field.serialize(serializer),
            Self::Statement(statement) => statement.serialize(serializer),
            Self::Group(group) => group.serialize(serializer),
            Self::PageBreak(page_break) => page_break.serialize(serializer),
        }
    }
}

// ---------------------------------------------------------------------------
// Welcome, endings, hidden fields, variables
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WelcomeScreen {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Media>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndingButton {
    pub text: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ending {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Media>,
    /// Show the `score` variable (quizzes).
    #[serde(default)]
    pub show_score: bool,
    /// Show each scored question with the respondent's answer and the right one.
    #[serde(default)]
    pub show_answers: bool,
    /// Go straight to this URL after submit; recall allowed (URL-encoded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<EndingButton>,
}

/// A value that comes in through the URL or an embed (`?utm_source=…`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HiddenField {
    pub name: String,
}

/// A variable changed by calculations; `score` always exists besides these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Variable {
    Number {
        name: String,
        #[serde(default, serialize_with = "ser_num")]
        initial: f64,
    },
    Text {
        name: String,
        #[serde(default)]
        initial: String,
    },
}

impl Variable {
    pub fn name(&self) -> &str {
        match self {
            Self::Number { name, .. } | Self::Text { name, .. } => name,
        }
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Self::Text { .. })
    }
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

/// A constant operand: text, a number, a boolean, or a list of choice ids.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstantValue {
    Text(String),
    Number(f64),
    Bool(bool),
    List(Vec<String>),
}

impl<'de> Deserialize<'de> for ConstantValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::String(text) => Ok(Self::Text(text)),
            Value::Number(number) => number
                .as_f64()
                .map(Self::Number)
                .ok_or_else(|| D::Error::custom("not a number")),
            Value::Bool(flag) => Ok(Self::Bool(flag)),
            Value::Array(items) => items
                .into_iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text),
                    _ => Err(D::Error::custom("a list holds strings")),
                })
                .collect::<Result<_, _>>()
                .map(Self::List),
            _ => Err(D::Error::custom(
                "a constant is text, a number, a boolean or a list",
            )),
        }
    }
}

impl Serialize for ConstantValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(text) => serializer.serialize_str(text),
            Self::Number(number) => ser_num(number, serializer),
            Self::Bool(flag) => serializer.serialize_bool(*flag),
            Self::List(items) => items.serialize(serializer),
        }
    }
}

/// A value in a condition or calculation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operand {
    /// An answer; `row_id` picks a matrix row, `part` a contact or address part.
    Field {
        id: String,
        #[serde(rename = "rowId", default, skip_serializing_if = "Option::is_none")]
        row_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<String>,
    },
    Hidden {
        name: String,
    },
    Variable {
        name: String,
    },
    Constant {
        value: ConstantValue,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOperator {
    Is,
    IsNot,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    GreaterThan,
    GreaterOrEqual,
    LessThan,
    LessOrEqual,
    IsAnswered,
    IsEmpty,
    /// Choice fields: at least one of the constant's choice ids is selected.
    AnyOf,
    /// Choice fields: every one of the constant's choice ids is selected.
    AllOf,
    /// Choice fields: none of the constant's choice ids is selected.
    NoneOf,
    Before,
    After,
}

/// Every operator, in the schema's order (`CONDITION_OPERATORS`).
pub const CONDITION_OPERATORS: &[&str] = &[
    "is",
    "is_not",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "is_answered",
    "is_empty",
    "any_of",
    "all_of",
    "none_of",
    "before",
    "after",
];

impl ConditionOperator {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Is => "is",
            Self::IsNot => "is_not",
            Self::Contains => "contains",
            Self::NotContains => "not_contains",
            Self::StartsWith => "starts_with",
            Self::EndsWith => "ends_with",
            Self::GreaterThan => "greater_than",
            Self::GreaterOrEqual => "greater_or_equal",
            Self::LessThan => "less_than",
            Self::LessOrEqual => "less_or_equal",
            Self::IsAnswered => "is_answered",
            Self::IsEmpty => "is_empty",
            Self::AnyOf => "any_of",
            Self::AllOf => "all_of",
            Self::NoneOf => "none_of",
            Self::Before => "before",
            Self::After => "after",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub left: Operand,
    pub operator: ConditionOperator,
    /// Absent for `is_answered` / `is_empty`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Operand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp {
    And,
    Or,
}

/// A group inside a group: conditions only (one level of nesting).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NestedGroup {
    pub op: GroupOp,
    pub conditions: Vec<Condition>,
}

/// An entry of a condition group: Zod's `z.union([condition, nestedGroup])`,
/// read as the option Zod keeps.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ConditionItem {
    Condition(Condition),
    Group(NestedGroup),
}

impl<'de> Deserialize<'de> for ConditionItem {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let item = if schema::reads_as_condition(&value) {
            serde_json::from_value(value).map(Self::Condition)
        } else {
            serde_json::from_value(value).map(Self::Group)
        };
        item.map_err(D::Error::custom)
    }
}

/// AND/OR of conditions, one level of nesting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionGroup {
    pub op: GroupOp,
    pub conditions: Vec<ConditionItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Target {
    Block { id: String },
    Ending { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalcOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Set,
}

impl CalcOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Subtract => "subtract",
            Self::Multiply => "multiply",
            Self::Divide => "divide",
            Self::Set => "set",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Calculation {
    pub id: String,
    /// `None` (`null`) = always.
    #[serde(default)]
    pub when: Option<ConditionGroup>,
    pub variable: String,
    pub op: CalcOp,
    pub value: Operand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Jump {
    pub id: String,
    pub when: ConditionGroup,
    pub to: Target,
}

/// Logic of one top-level block, run when the respondent leaves it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockLogic {
    pub block_id: String,
    #[serde(default)]
    pub calculations: Vec<Calculation>,
    #[serde(default)]
    pub jumps: Vec<Jump>,
    /// `None` (`null`) = the next block.
    #[serde(default)]
    pub otherwise: Option<Target>,
}

/// Which ending to show when the path runs past the last block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndingRule {
    pub id: String,
    pub when: ConditionGroup,
    pub ending_id: String,
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormLayout {
    #[default]
    Conversational,
    Classic,
}

/// Languages of the renderer's own texts (Next, Submit, errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormLanguage {
    #[default]
    En,
    Nl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressBar {
    #[default]
    Percentage,
    Proportion,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    #[serde(default)]
    pub layout: FormLayout,
    #[serde(default)]
    pub language: FormLanguage,
    #[serde(default)]
    pub progress_bar: ProgressBar,
    #[serde(default = "yes")]
    pub show_question_numbers: bool,
    /// Conversational: allow going back to the previous question.
    #[serde(default = "yes")]
    pub allow_back: bool,
}

impl Default for Presentation {
    fn default() -> Self {
        Self {
            layout: FormLayout::Conversational,
            language: FormLanguage::En,
            progress_bar: ProgressBar::Percentage,
            show_question_numbers: true,
            allow_back: true,
        }
    }
}

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/// What a form contains and how it behaves (`FormDefinition`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct FormDefinition {
    pub schema_version: u32,
    pub presentation: Presentation,
    pub welcome: Option<WelcomeScreen>,
    pub blocks: Vec<Block>,
    pub endings: Vec<Ending>,
    pub hidden: Vec<HiddenField>,
    pub variables: Vec<Variable>,
    pub logic: Vec<BlockLogic>,
    pub ending_rules: Vec<EndingRule>,
}

/// The definition's keys with their defaults, read once the schema passed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDefinition {
    #[serde(default)]
    presentation: Presentation,
    #[serde(default)]
    welcome: Option<WelcomeScreen>,
    blocks: Vec<Block>,
    endings: Vec<Ending>,
    #[serde(default)]
    hidden: Vec<HiddenField>,
    #[serde(default)]
    variables: Vec<Variable>,
    #[serde(default)]
    logic: Vec<BlockLogic>,
    #[serde(default)]
    ending_rules: Vec<EndingRule>,
}

impl FormDefinition {
    /// `formDefinitionSchema.safeParse(value)`: the parsed definition with
    /// the defaults applied, or Zod's issues.
    pub fn parse(value: &Value) -> Result<Self, Vec<SchemaIssue>> {
        let issues = schema::check_definition(value);
        if !issues.is_empty() {
            return Err(issues);
        }
        let raw: RawDefinition = serde_json::from_value(value.clone())
            .map_err(|err| vec![SchemaIssue::unexpected(&err)])?;
        Ok(Self {
            schema_version: DEFINITION_SCHEMA_VERSION,
            presentation: raw.presentation,
            welcome: raw.welcome,
            blocks: raw.blocks,
            endings: raw.endings,
            hidden: raw.hidden,
            variables: raw.variables,
            logic: raw.logic,
            ending_rules: raw.ending_rules,
        })
    }
}

impl TryFrom<Value> for FormDefinition {
    type Error = String;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::parse(&value).map_err(|issues| schema::describe(&issues))
    }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeFont {
    #[default]
    Inter,
    System,
    Serif,
    Mono,
    Rounded,
    Grotesk,
}

fn white() -> String {
    "#ffffff".to_owned()
}

fn dark_grey() -> String {
    "#1f2937".to_owned()
}

fn blue() -> String {
    "#2563eb".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    #[serde(default = "white")]
    pub background: String,
    #[serde(default = "dark_grey")]
    pub question: String,
    #[serde(default = "blue")]
    pub answer: String,
    #[serde(default = "blue")]
    pub button: String,
    #[serde(default = "white")]
    pub button_text: String,
}

impl Default for ThemeColors {
    fn default() -> Self {
        Self {
            background: white(),
            question: dark_grey(),
            answer: blue(),
            button: blue(),
            button_text: white(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBackground {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// 0 (none) to 100 (opaque) darkening over the image.
    #[serde(default, serialize_with = "ser_num")]
    pub overlay: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeRadius {
    None,
    Small,
    #[default]
    Medium,
    Large,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeAlignment {
    #[default]
    Left,
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeFontSize {
    Small,
    #[default]
    Medium,
    Large,
}

/// A form theme (`formThemeTokensSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct FormThemeTokens {
    pub font: ThemeFont,
    pub colors: ThemeColors,
    pub background: ThemeBackground,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub radius: ThemeRadius,
    pub alignment: ThemeAlignment,
    pub font_size: ThemeFontSize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTheme {
    #[serde(default)]
    font: ThemeFont,
    #[serde(default)]
    colors: ThemeColors,
    #[serde(default)]
    background: ThemeBackground,
    #[serde(default)]
    logo_url: Option<String>,
    #[serde(default)]
    radius: ThemeRadius,
    #[serde(default)]
    alignment: ThemeAlignment,
    #[serde(default)]
    font_size: ThemeFontSize,
}

impl FormThemeTokens {
    /// `formThemeTokensSchema.safeParse(value)`.
    pub fn parse(value: &Value) -> Result<Self, Vec<SchemaIssue>> {
        let issues = schema::check_theme(value);
        if !issues.is_empty() {
            return Err(issues);
        }
        let raw: RawTheme = serde_json::from_value(value.clone())
            .map_err(|err| vec![SchemaIssue::unexpected(&err)])?;
        Ok(Self {
            font: raw.font,
            colors: raw.colors,
            background: raw.background,
            logo_url: raw.logo_url,
            radius: raw.radius,
            alignment: raw.alignment,
            font_size: raw.font_size,
        })
    }
}

impl Default for FormThemeTokens {
    fn default() -> Self {
        Self {
            font: ThemeFont::Inter,
            colors: ThemeColors::default(),
            background: ThemeBackground::default(),
            logo_url: None,
            radius: ThemeRadius::Medium,
            alignment: ThemeAlignment::Left,
            font_size: ThemeFontSize::Medium,
        }
    }
}

impl TryFrom<Value> for FormThemeTokens {
    type Error = String;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::parse(&value).map_err(|issues| schema::describe(&issues))
    }
}

// ---------------------------------------------------------------------------
// Answers as stored
// ---------------------------------------------------------------------------

/// A file the session uploaded; `file_id` is a `form_response_files` id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAnswerItem {
    pub file_id: String,
    pub name: String,
    #[serde(serialize_with = "ser_num")]
    pub size: f64,
    pub r#type: String,
}
