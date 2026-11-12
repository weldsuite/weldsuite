//! Answer normalisation and validation, one field at a time (`answers.ts`).
//!
//! Raw answers are JSON as the renderer sends them. Normalising trims
//! strings (a blank one is no answer), de-duplicates choice ids, drops a
//! choice answer's literal `other` id, drops matrix rows and composite parts
//! the field doesn't have (or has disabled), and gives a website without a
//! scheme `https://`. A value of the wrong shape is `invalid`.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use super::blocks::fields_of;
use super::definition::{Field, FieldKind, FileAnswerItem, FormDefinition};
use super::js::{
    JS_SPACE_CLASS, code_points, finite_number, is_integer, js_cmp, js_round, js_trim, ser_num,
};

/// Why an answer is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerErrorCode {
    Required,
    Invalid,
    InvalidEmail,
    InvalidUrl,
    InvalidPhone,
    InvalidDate,
    DateTooEarly,
    DateTooLate,
    TooLong,
    TooSmall,
    TooLarge,
    NotInteger,
    TooManyDecimals,
    InvalidChoice,
    TooFewChoices,
    TooManyChoices,
    MustAccept,
    TooManyFiles,
}

/// A refused answer; `part` names the sub-field or matrix row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AnswerError {
    pub code: AnswerErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
}

impl AnswerError {
    fn new(code: AnswerErrorCode) -> Self {
        Self { code, part: None }
    }

    fn at(code: AnswerErrorCode, part: &str) -> Self {
        Self {
            code,
            part: Some(part.to_owned()),
        }
    }
}

/// A choice field's answer: the selected ids and the typed "Other" text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceAnswer {
    pub choice_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
}

impl ChoiceAnswer {
    /// The selected ids, plus `other` when there is an Other text.
    pub fn selected_with_other(&self) -> Vec<String> {
        let mut ids = self.choice_ids.clone();
        if self.other.is_some() {
            ids.push("other".to_owned());
        }
        ids
    }
}

/// A normalised answer. Serialises to the shape stored in
/// `form_responses.answers[fieldId]`.
#[derive(Debug, Clone, PartialEq)]
pub enum AnswerValue {
    /// Text fields and dates.
    Text(String),
    /// Number, rating, opinion scale, NPS.
    Number(f64),
    /// Yes/no and legal.
    Bool(bool),
    /// Choice fields.
    Choice(ChoiceAnswer),
    /// A ranking: choice ids, best first.
    Ranking(Vec<String>),
    /// A matrix: column ids per row, in the field's row order.
    Matrix(Vec<(String, Vec<String>)>),
    /// File upload.
    Files(Vec<FileAnswerItem>),
    /// Signature.
    File(FileAnswerItem),
    /// Contact info and address: the parts in display order.
    Parts(Vec<(String, String)>),
}

impl AnswerValue {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_choice(&self) -> Option<&ChoiceAnswer> {
        match self {
            Self::Choice(choice) => Some(choice),
            _ => None,
        }
    }

    /// A matrix row's columns.
    pub fn row(&self, row_id: &str) -> Option<&[String]> {
        match self {
            Self::Matrix(rows) => rows
                .iter()
                .find(|(id, _)| id == row_id)
                .map(|(_, columns)| columns.as_slice()),
            _ => None,
        }
    }

    /// A composite field's part.
    pub fn part(&self, name: &str) -> Option<&str> {
        match self {
            Self::Parts(parts) => parts
                .iter()
                .find(|(part, _)| part == name)
                .map(|(_, value)| value.as_str()),
            _ => None,
        }
    }

    /// The answer as JSON.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

impl Serialize for AnswerValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(text) => serializer.serialize_str(text),
            Self::Number(number) => ser_num(number, serializer),
            Self::Bool(flag) => serializer.serialize_bool(*flag),
            Self::Choice(choice) => choice.serialize(serializer),
            Self::Ranking(ids) => ids.serialize(serializer),
            Self::Matrix(rows) => {
                let mut map = serializer.serialize_map(Some(rows.len()))?;
                for (row, columns) in rows {
                    map.serialize_entry(row, columns)?;
                }
                map.end()
            }
            Self::Files(items) => items.serialize(serializer),
            Self::File(item) => item.serialize(serializer),
            Self::Parts(parts) => {
                let mut map = serializer.serialize_map(Some(parts.len()))?;
                for (part, value) in parts {
                    map.serialize_entry(part, value)?;
                }
                map.end()
            }
        }
    }
}

/// Answers by field id.
pub type Answers = BTreeMap<String, AnswerValue>;

/// An answer after normalising: none, of the wrong shape, or a value to check.
#[derive(Debug, Clone, PartialEq)]
pub enum PreparedAnswer {
    Empty,
    Invalid(AnswerError),
    Value(AnswerValue),
}

fn invalid() -> PreparedAnswer {
    PreparedAnswer::Invalid(AnswerError::new(AnswerErrorCode::Invalid))
}

fn invalid_at(part: &str) -> PreparedAnswer {
    PreparedAnswer::Invalid(AnswerError::at(AnswerErrorCode::Invalid, part))
}

/// A string array, as owned strings; `None` for anything else.
fn string_array(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// `[...new Set(values)]`: first occurrences, in order.
fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// `/^[a-z][a-z0-9+.-]*:\/\//i`.
fn has_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn prepare_file_item(value: &Value) -> Option<FileAnswerItem> {
    let item = value.as_object()?;
    let file_id = item.get("fileId")?.as_str().filter(|id| !id.is_empty())?;
    let name = item.get("name")?.as_str()?;
    let r#type = item.get("type")?.as_str()?;
    let size = item
        .get("size")
        .and_then(Value::as_f64)
        .filter(|size| is_integer(*size) && *size >= 0.0)?;
    Some(FileAnswerItem {
        file_id: file_id.to_owned(),
        name: name.to_owned(),
        size,
        r#type: r#type.to_owned(),
    })
}

/// `ownValue(record, key) ?? fallback` reads: absent and `null` are the same.
fn present<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    record.get(key).filter(|value| !value.is_null())
}

fn prepare_choice(field: &Field, raw: &Value) -> PreparedAnswer {
    let Some(record) = raw.as_object() else {
        return invalid();
    };
    let ids = match present(record, "choiceIds") {
        None => Vec::new(),
        Some(value) => match string_array(value) {
            Some(ids) => ids,
            None => return invalid(),
        },
    };
    let other = match present(record, "other") {
        None => "",
        Some(Value::String(text)) => text.as_str(),
        Some(_) => return invalid(),
    };
    let has_other_choice = field.choices().iter().any(|choice| choice.id == "other");
    let choice_ids = dedupe(
        ids.into_iter()
            .filter(|id| !id.is_empty() && (has_other_choice || id != "other")),
    );
    let other = js_trim(other);
    if choice_ids.is_empty() && other.is_empty() {
        return PreparedAnswer::Empty;
    }
    PreparedAnswer::Value(AnswerValue::Choice(ChoiceAnswer {
        choice_ids,
        other: (!other.is_empty()).then(|| other.to_owned()),
    }))
}

fn prepare_matrix(rows: &[super::definition::MatrixItem], raw: &Value) -> PreparedAnswer {
    let Some(record) = raw.as_object() else {
        return invalid();
    };
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for row in rows {
        let Some(columns) = present(record, &row.id) else {
            continue;
        };
        let Some(columns) = string_array(columns) else {
            return invalid_at(&row.id);
        };
        let ids = dedupe(columns.into_iter().filter(|id| !id.is_empty()));
        if ids.is_empty() {
            continue;
        }
        // `out[row.id] = ids`: a repeated row id keeps its first place.
        match out.iter_mut().find(|(id, _)| *id == row.id) {
            Some(entry) => entry.1 = ids,
            None => out.push((row.id.clone(), ids)),
        }
    }
    if out.is_empty() {
        PreparedAnswer::Empty
    } else {
        PreparedAnswer::Value(AnswerValue::Matrix(out))
    }
}

fn prepare_files(raw: &Value) -> PreparedAnswer {
    let Some(entries) = raw.as_array() else {
        return invalid();
    };
    let mut items: Vec<FileAnswerItem> = Vec::new();
    for entry in entries {
        let Some(item) = prepare_file_item(entry) else {
            return invalid();
        };
        if items.iter().any(|seen| seen.file_id == item.file_id) {
            continue;
        }
        items.push(item);
    }
    if items.is_empty() {
        PreparedAnswer::Empty
    } else {
        PreparedAnswer::Value(AnswerValue::Files(items))
    }
}

fn prepare_parts(field: &Field, raw: &Value) -> PreparedAnswer {
    let Some(record) = raw.as_object() else {
        return invalid();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for part in field.parts() {
        if !part.enabled {
            continue;
        }
        let Some(value) = present(record, part.name) else {
            continue;
        };
        let Some(text) = value.as_str() else {
            return invalid_at(part.name);
        };
        let trimmed = js_trim(text);
        if !trimmed.is_empty() {
            out.push((part.name.to_owned(), trimmed.to_owned()));
        }
    }
    if out.is_empty() {
        PreparedAnswer::Empty
    } else {
        PreparedAnswer::Value(AnswerValue::Parts(out))
    }
}

/// Normalises a raw answer for a field. Absent, `null` and a blank string
/// are no answer.
pub fn prepare_answer(field: &Field, raw: Option<&Value>) -> PreparedAnswer {
    let raw = match raw {
        None | Some(Value::Null) => return PreparedAnswer::Empty,
        Some(Value::String(text)) if js_trim(text).is_empty() => return PreparedAnswer::Empty,
        Some(raw) => raw,
    };
    let value = |answer| PreparedAnswer::Value(answer);
    match &field.kind {
        FieldKind::ShortText(_)
        | FieldKind::LongText(_)
        | FieldKind::Email(_)
        | FieldKind::Phone(_)
        | FieldKind::Date(_) => match raw {
            Value::String(text) => value(AnswerValue::Text(js_trim(text).to_owned())),
            _ => invalid(),
        },
        FieldKind::Website(_) => match raw {
            Value::String(text) => {
                let url = js_trim(text);
                value(AnswerValue::Text(if has_scheme(url) {
                    url.to_owned()
                } else {
                    format!("https://{url}")
                }))
            }
            _ => invalid(),
        },
        FieldKind::Number(_)
        | FieldKind::Rating(_)
        | FieldKind::OpinionScale(_)
        | FieldKind::Nps(_) => match finite_number(raw) {
            Some(number) => value(AnswerValue::Number(number)),
            None => invalid(),
        },
        FieldKind::YesNo(_) | FieldKind::Legal(_) => match raw {
            Value::Bool(flag) => value(AnswerValue::Bool(*flag)),
            _ => invalid(),
        },
        FieldKind::MultipleChoice(_) | FieldKind::Dropdown(_) | FieldKind::PictureChoice(_) => {
            prepare_choice(field, raw)
        }
        FieldKind::Ranking(_) => match string_array(raw) {
            None => invalid(),
            Some(ids) if ids.is_empty() => PreparedAnswer::Empty,
            Some(ids) => value(AnswerValue::Ranking(ids)),
        },
        FieldKind::Matrix(props) => prepare_matrix(&props.rows, raw),
        FieldKind::FileUpload(_) => prepare_files(raw),
        FieldKind::Signature(_) => match prepare_file_item(raw) {
            Some(item) => value(AnswerValue::File(item)),
            None => invalid(),
        },
        FieldKind::ContactInfo(_) | FieldKind::Address(_) => prepare_parts(field, raw),
    }
}

/// The normalised answer, or `None` when there is none or it has the wrong shape.
pub fn normalize_answer(field: &Field, raw: Option<&Value>) -> Option<AnswerValue> {
    match prepare_answer(field, raw) {
        PreparedAnswer::Value(answer) => Some(answer),
        PreparedAnswer::Empty | PreparedAnswer::Invalid(_) => None,
    }
}

/// Whether a value counts as an answer (one of the wrong shape does; `false` does).
pub fn is_answered(field: &Field, raw: Option<&Value>) -> bool {
    !matches!(prepare_answer(field, raw), PreparedAnswer::Empty)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    let part = format!("[^{JS_SPACE_CLASS}@]+");
    Regex::new(&format!(r"^{part}@{part}\.{part}$")).expect("the email pattern compiles")
});

/// `/^https?:\/\/[^\s/?#:@.]+(\.[^\s/?#:@.]+)+(:\d{1,5})?([/?#]\S*)?$/i`.
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    let label = format!("[^{JS_SPACE_CLASS}/?#:@.]+");
    Regex::new(&format!(
        r"^[hH][tT][tT][pP][sS]?://{label}(\.{label})+(:[0-9]{{1,5}})?([/?#][^{JS_SPACE_CLASS}]*)?$"
    ))
    .expect("the URL pattern compiles")
});

/// At most 254 code points and `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
pub fn is_valid_email(text: &str) -> bool {
    code_points(text) <= 254 && EMAIL_RE.is_match(text)
}

/// `http(s)://`, a host with a dot, an optional port, then a path, query or fragment.
pub fn is_valid_url(text: &str) -> bool {
    URL_RE.is_match(text)
}

/// `^\+?[0-9 ()-]+$` with 6 to 20 digits.
pub fn is_valid_phone(text: &str) -> bool {
    let rest = text.strip_prefix('+').unwrap_or(text);
    if rest.is_empty()
        || !rest
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '(' | ')' | '-'))
    {
        return false;
    }
    let digits = text.chars().filter(char::is_ascii_digit).count();
    (6..=20).contains(&digits)
}

/// `YYYY-MM-DD` and a real calendar date (year 1 to 9999).
pub fn is_valid_date(text: &str) -> bool {
    if !super::schema::is_date_text(text) {
        return false;
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    if year < 1 || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days
}

/// Whether `n` has at most `decimals` decimal places, with a tolerance for
/// float noise: `|s - round(s)| <= max(1e-9, |s| * 1e-12)`, `s = n * 10^decimals`.
pub fn has_at_most_decimals(number: f64, decimals: f64) -> bool {
    // `10 ** decimals`: exact for the schema's whole 0 to 6 (and up to 22).
    let factor = if is_integer(decimals) && (0.0..=22.0).contains(&decimals) {
        #[allow(clippy::cast_possible_truncation)] // whole, 0 to 22
        let exponent = decimals as i32;
        10f64.powi(exponent)
    } else {
        10f64.powf(decimals)
    };
    let scaled = number * factor;
    (scaled - js_round(scaled)).abs() <= f64::max(1e-9, scaled.abs() * 1e-12)
}

fn is_integer_in(number: f64, min: f64, max: f64) -> bool {
    is_integer(number) && number >= min && number <= max
}

fn error(code: AnswerErrorCode) -> AnswerError {
    AnswerError::new(code)
}

fn check_choice(field: &Field, answer: &ChoiceAnswer) -> Option<AnswerError> {
    let (allow_other, single, min, max) = match &field.kind {
        FieldKind::MultipleChoice(props) => (
            props.allow_other,
            !props.multiple,
            props.min_selections,
            props.max_selections,
        ),
        FieldKind::PictureChoice(props) => (
            props.allow_other,
            !props.multiple,
            props.min_selections,
            props.max_selections,
        ),
        _ => (false, true, None, None),
    };
    let choices = field.choices();
    if answer
        .choice_ids
        .iter()
        .any(|id| !choices.iter().any(|choice| choice.id == *id))
    {
        return Some(error(AnswerErrorCode::InvalidChoice));
    }
    if answer.other.is_some() && !allow_other {
        return Some(error(AnswerErrorCode::InvalidChoice));
    }
    #[allow(clippy::cast_precision_loss)] // a handful of selections
    let count = (answer.choice_ids.len() + usize::from(answer.other.is_some())) as f64;
    if single {
        return (count > 1.0).then(|| AnswerError::new(AnswerErrorCode::TooManyChoices));
    }
    if min.is_some_and(|min| count < min) {
        return Some(error(AnswerErrorCode::TooFewChoices));
    }
    if max.is_some_and(|max| count > max) {
        return Some(error(AnswerErrorCode::TooManyChoices));
    }
    None
}

fn check_matrix(
    field: &Field,
    props: &super::definition::MatrixProps,
    rows: &[(String, Vec<String>)],
) -> Option<AnswerError> {
    for row in &props.rows {
        let Some((_, columns)) = rows.iter().find(|(id, _)| *id == row.id) else {
            if field.required {
                return Some(AnswerError::at(AnswerErrorCode::Required, &row.id));
            }
            continue;
        };
        if columns
            .iter()
            .any(|column| !props.columns.iter().any(|known| known.id == *column))
        {
            return Some(AnswerError::at(AnswerErrorCode::InvalidChoice, &row.id));
        }
        if !props.multiple && columns.len() > 1 {
            return Some(AnswerError::at(AnswerErrorCode::TooManyChoices, &row.id));
        }
    }
    None
}

fn check_parts(field: &Field, parts: &[(String, String)]) -> Option<AnswerError> {
    let contact = matches!(field.kind, FieldKind::ContactInfo(_));
    for part in field.parts() {
        if !part.enabled {
            continue;
        }
        let Some((_, value)) = parts.iter().find(|(name, _)| name == part.name) else {
            if part.required {
                return Some(AnswerError::at(AnswerErrorCode::Required, part.name));
            }
            continue;
        };
        if contact && part.name == "email" && !is_valid_email(value) {
            return Some(AnswerError::at(AnswerErrorCode::InvalidEmail, part.name));
        }
        if contact && part.name == "phone" && !is_valid_phone(value) {
            return Some(AnswerError::at(AnswerErrorCode::InvalidPhone, part.name));
        }
    }
    None
}

/// Checks a normalised (non-empty) answer against its field.
pub fn check_answer(field: &Field, answer: &AnswerValue) -> Option<AnswerError> {
    use AnswerErrorCode as Code;
    match (&field.kind, answer) {
        (FieldKind::ShortText(props) | FieldKind::LongText(props), AnswerValue::Text(text)) => {
            #[allow(clippy::cast_precision_loss)] // a text's length
            let too_long = props
                .max_length
                .is_some_and(|max| code_points(text) as f64 > max);
            too_long.then(|| AnswerError::new(Code::TooLong))
        }
        (FieldKind::Email(_), AnswerValue::Text(text)) => {
            (!is_valid_email(text)).then(|| AnswerError::new(Code::InvalidEmail))
        }
        (FieldKind::Phone(_), AnswerValue::Text(text)) => {
            (!is_valid_phone(text)).then(|| AnswerError::new(Code::InvalidPhone))
        }
        (FieldKind::Website(_), AnswerValue::Text(text)) => {
            (!is_valid_url(text)).then(|| AnswerError::new(Code::InvalidUrl))
        }
        (FieldKind::Number(props), AnswerValue::Number(number)) => {
            let number = *number;
            if !has_at_most_decimals(number, props.decimals) {
                #[allow(clippy::float_cmp)] // `decimals === 0`
                let whole = props.decimals == 0.0;
                return Some(error(if whole {
                    Code::NotInteger
                } else {
                    Code::TooManyDecimals
                }));
            }
            if props.min.is_some_and(|min| number < min) {
                return Some(error(Code::TooSmall));
            }
            if props.max.is_some_and(|max| number > max) {
                return Some(error(Code::TooLarge));
            }
            None
        }
        (FieldKind::Rating(props), AnswerValue::Number(number)) => {
            (!is_integer_in(*number, 1.0, props.steps)).then(|| AnswerError::new(Code::Invalid))
        }
        (FieldKind::OpinionScale(props), AnswerValue::Number(number)) => {
            (!is_integer_in(*number, props.start, props.end))
                .then(|| AnswerError::new(Code::Invalid))
        }
        (FieldKind::Nps(_), AnswerValue::Number(number)) => {
            (!is_integer_in(*number, 0.0, 10.0)).then(|| AnswerError::new(Code::Invalid))
        }
        (FieldKind::Date(props), AnswerValue::Text(date)) => {
            if !is_valid_date(date) {
                return Some(error(Code::InvalidDate));
            }
            if props
                .min
                .as_deref()
                .is_some_and(|min| js_cmp(date, min).is_lt())
            {
                return Some(error(Code::DateTooEarly));
            }
            if props
                .max
                .as_deref()
                .is_some_and(|max| js_cmp(date, max).is_gt())
            {
                return Some(error(Code::DateTooLate));
            }
            None
        }
        (
            FieldKind::MultipleChoice(_) | FieldKind::Dropdown(_) | FieldKind::PictureChoice(_),
            AnswerValue::Choice(choice),
        ) => check_choice(field, choice),
        (FieldKind::Legal(_), AnswerValue::Bool(false)) if field.required => {
            Some(error(Code::MustAccept))
        }
        (FieldKind::Ranking(props), AnswerValue::Ranking(ranked)) => {
            let set: HashSet<&str> = ranked.iter().map(String::as_str).collect();
            let ok = ranked.len() == props.choices.len()
                && set.len() == ranked.len()
                && props
                    .choices
                    .iter()
                    .all(|choice| set.contains(choice.id.as_str()));
            (!ok).then(|| AnswerError::new(Code::Invalid))
        }
        (FieldKind::Matrix(props), AnswerValue::Matrix(rows)) => check_matrix(field, props, rows),
        (FieldKind::FileUpload(props), AnswerValue::Files(items)) => {
            #[allow(clippy::cast_precision_loss)] // at most a few files
            let too_many = items.len() as f64 > props.max_files;
            too_many.then(|| AnswerError::new(Code::TooManyFiles))
        }
        (FieldKind::ContactInfo(_) | FieldKind::Address(_), AnswerValue::Parts(parts)) => {
            check_parts(field, parts)
        }
        // Yes/no, an accepted or optional legal field, a signature; an answer
        // of another field's shape never reaches here.
        _ => None,
    }
}

/// Validates one field's raw answer; `None` = unanswered.
pub fn validate_answer(field: &Field, raw: Option<&Value>) -> Option<AnswerError> {
    match prepare_answer(field, raw) {
        PreparedAnswer::Empty => field
            .required
            .then(|| AnswerError::new(AnswerErrorCode::Required)),
        PreparedAnswer::Invalid(error) => Some(error),
        PreparedAnswer::Value(answer) => check_answer(field, &answer),
    }
}

/// Every field's answer, normalised and checked.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectedAnswers {
    /// The answers without an error.
    pub valid: Answers,
    /// Every field's error (required ones included), on the path or not.
    pub errors: BTreeMap<String, AnswerError>,
}

/// `collectAnswers`: every field's answer normalised and checked; unknown
/// ids dropped.
pub fn collect_answers(
    def: &FormDefinition,
    answers: Option<&Map<String, Value>>,
) -> CollectedAnswers {
    let mut out = CollectedAnswers::default();
    for field in fields_of(def) {
        let raw = answers.and_then(|answers| answers.get(&field.id));
        match prepare_answer(field, raw) {
            PreparedAnswer::Empty => {
                if field.required {
                    out.errors.insert(
                        field.id.clone(),
                        AnswerError::new(AnswerErrorCode::Required),
                    );
                }
            }
            PreparedAnswer::Invalid(error) => {
                out.errors.insert(field.id.clone(), error);
            }
            PreparedAnswer::Value(answer) => match check_answer(field, &answer) {
                Some(error) => {
                    out.errors.insert(field.id.clone(), error);
                }
                None => {
                    out.valid.insert(field.id.clone(), answer);
                }
            },
        }
    }
    out
}

/// The normalised answers of every field that has one (errors not checked);
/// unknown ids dropped.
pub fn normalize_answers(def: &FormDefinition, answers: Option<&Map<String, Value>>) -> Answers {
    let mut out = Answers::new();
    for field in fields_of(def) {
        if let Some(answer) =
            normalize_answer(field, answers.and_then(|answers| answers.get(&field.id)))
        {
            out.insert(field.id.clone(), answer);
        }
    }
    out
}
