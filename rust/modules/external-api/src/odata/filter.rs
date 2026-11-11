//! `$filter` (`routes/v1/odata/filter.ts`): a tokenizer and a
//! recursive-descent parser that turn the text into a typed tree. Nothing
//! here knows about SQL (`sql.rs` does that).
//!
//! ```text
//!   or      := and ( 'or' and )*
//!   and     := not ( 'and' not )*
//!   not     := 'not' not | primary
//!   primary := '(' or ')' | operand cmpOp operand | textFn | any
//!   cmpOp   := eq | ne | gt | ge | lt | le
//!   operand := property | literal | year(p) | month(p) | day(p)
//!   textFn  := contains(p, 's') | startswith(p, 's') | endswith(p, 's')
//!   any     := collectionProperty '/any(' v ':' v ' eq ' 's' ')'
//! ```
//!
//! A comparison has a property (or a date function of one) on one side and a
//! literal on the other, in either order. Property names are resolved against
//! the catalogue; a name that is not in it is a 400. Literals are typed
//! against the property (a mismatch is a 400). Limits: 2 000 characters
//! (UTF-16 units, as JavaScript counts), nesting depth 10, 30 comparisons.
//!
//! The messages are the worker's, token for token: they name what was found.

use weldsuite_core_domain::js::number_text;
use weldsuite_kit::validation::js_trim;

use super::catalog::{EdmType, EntitySet, Property};
use super::error::ODataError;

pub(crate) const MAX_FILTER_LENGTH: usize = 2000;
pub(crate) const MAX_FILTER_DEPTH: usize = 10;
pub(crate) const MAX_FILTER_COMPARISONS: usize = 30;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const INT32_MAX: f64 = 2_147_483_647.0;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CmpOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

impl CmpOp {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "eq" => Self::Eq,
            "ne" => Self::Ne,
            "gt" => Self::Gt,
            "ge" => Self::Ge,
            "lt" => Self::Lt,
            "le" => Self::Le,
            _ => return None,
        })
    }

    /// `FLIP`: the operator with its sides swapped.
    fn flip(self) -> Self {
        match self {
            Self::Eq => Self::Eq,
            Self::Ne => Self::Ne,
            Self::Gt => Self::Lt,
            Self::Ge => Self::Le,
            Self::Lt => Self::Gt,
            Self::Le => Self::Ge,
        }
    }

    pub(crate) fn is_equality(self) -> bool {
        matches!(self, Self::Eq | Self::Ne)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DateFn {
    Year,
    Month,
    Day,
}

impl DateFn {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "year" => Self::Year,
            "month" => Self::Month,
            "day" => Self::Day,
            _ => return None,
        })
    }

    /// The field `extract()` takes.
    pub(crate) fn field(self) -> &'static str {
        match self {
            Self::Year => "year",
            Self::Month => "month",
            Self::Day => "day",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextFn {
    Contains,
    StartsWith,
    EndsWith,
}

impl TextFn {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "contains" => Self::Contains,
            "startswith" => Self::StartsWith,
            "endswith" => Self::EndsWith,
            _ => return None,
        })
    }
}

/// `Literal`. Numbers are JavaScript's (`f64`); an `Int` is a safe integer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Literal {
    Null,
    String(String),
    Int(f64),
    Double(f64),
    Boolean(bool),
    /// `ts` is `YYYY-MM-DD HH:MM:SS.mmm` in UTC; a bare date has `day_end`,
    /// the start of the next day.
    DateTime {
        ts: String,
        day_end: Option<String>,
    },
}

impl Literal {
    /// `lit.type`.
    fn type_name(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::String(_) => "string",
            Self::Int(_) => "int",
            Self::Double(_) => "double",
            Self::Boolean(_) => "boolean",
            Self::DateTime { .. } => "datetime",
        }
    }
}

/// `FilterNode`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node<'a> {
    And(Vec<Node<'a>>),
    Or(Vec<Node<'a>>),
    Not(Box<Node<'a>>),
    Cmp {
        op: CmpOp,
        prop: &'a Property,
        func: Option<DateFn>,
        lit: Literal,
    },
    Text {
        func: TextFn,
        prop: &'a Property,
        value: String,
    },
    Any {
        prop: &'a Property,
        value: String,
    },
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Open,
    Close,
    Comma,
    Colon,
    Slash,
    End,
    Str(String),
    Int(f64),
    Double(f64),
    DateTime(Literal),
    Ident(String),
}

impl Token {
    /// `describe(token)`: how a message names what it found.
    fn describe(&self) -> String {
        match self {
            Self::End => "end of expression".to_owned(),
            Self::Str(value) | Self::Ident(value) => format!("'{value}'"),
            Self::Open => "'('".to_owned(),
            Self::Close => "')'".to_owned(),
            Self::Comma => "','".to_owned(),
            Self::Colon => "':'".to_owned(),
            Self::Slash => "'/'".to_owned(),
            Self::Int(_) => "'int'".to_owned(),
            Self::Double(_) => "'double'".to_owned(),
            Self::DateTime(_) => "'datetime'".to_owned(),
        }
    }
}

fn bad_request(message: impl Into<String>) -> ODataError {
    ODataError::bad_request(message)
}

/// `n` ASCII digits at `at`, as a number.
fn digits(bytes: &[u8], at: usize, n: usize) -> Option<i64> {
    let slice = bytes.get(at..at + n)?;
    slice.iter().try_fold(0_i64, |acc, b| {
        b.is_ascii_digit().then(|| acc * 10 + i64::from(b - b'0'))
    })
}

/// What `DATETIME` matched.
struct DateMatch {
    end: usize,
    year: i64,
    month: i64,
    day: i64,
    /// Hours and minutes; `None` for a bare date.
    time: Option<(i64, i64)>,
    second: i64,
    milli: i64,
    /// Minutes to add to reach UTC (a `+02:00` zone is `-120`).
    shift_minutes: i64,
}

/// The `DATETIME` pattern at `at`:
/// `YYYY-MM-DD(THH:MM(:SS(.f{1,9})?)?(Z|[+- ]HH:MM)?)?`. A space where the
/// offset's `+` was: an unescaped `+` in a query string reads as a space.
fn match_datetime(bytes: &[u8], at: usize) -> Option<DateMatch> {
    let is = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    let year = digits(bytes, at, 4)?;
    if !is(at + 4, b'-') {
        return None;
    }
    let month = digits(bytes, at + 5, 2)?;
    if !is(at + 7, b'-') {
        return None;
    }
    let day = digits(bytes, at + 8, 2)?;
    let mut found = DateMatch {
        end: at + 10,
        year,
        month,
        day,
        time: None,
        second: 0,
        milli: 0,
        shift_minutes: 0,
    };
    let start = found.end;
    let (Some(hour), Some(minute)) = (digits(bytes, start + 1, 2), digits(bytes, start + 4, 2))
    else {
        return Some(found);
    };
    if !is(start, b'T') || !is(start + 3, b':') {
        return Some(found);
    }
    found.time = Some((hour, minute));
    let mut end = start + 6;
    if is(end, b':')
        && let Some(second) = digits(bytes, end + 1, 2)
    {
        found.second = second;
        end += 3;
        let fraction = bytes.get(end + 1..).map_or(0, |rest| {
            rest.iter()
                .take(9)
                .take_while(|b| b.is_ascii_digit())
                .count()
        });
        if is(end, b'.') && fraction > 0 {
            // `Number(frac.slice(0, 3).padEnd(3, '0'))`.
            let shown = fraction.min(3);
            let mut milli = digits(bytes, end + 1, shown).unwrap_or(0);
            for _ in shown..3 {
                milli *= 10;
            }
            found.milli = milli;
            end += 1 + fraction;
        }
    }
    if is(end, b'Z') {
        end += 1;
    } else if let Some(sign) = bytes.get(end).filter(|b| matches!(b, b'+' | b'-' | b' '))
        && let (Some(hours), true, Some(minutes)) = (
            digits(bytes, end + 1, 2),
            is(end + 3, b':'),
            digits(bytes, end + 4, 2),
        )
    {
        let offset = hours * 60 + minutes;
        found.shift_minutes = if *sign == b'-' { offset } else { -offset };
        end += 6;
    }
    found.end = end;
    Some(found)
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The civil date of a day count from 1970-01-01: `(year, month, day)`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// `${iso.slice(0, 10)} ${iso.slice(11, 23)}` of `new Date(epoch).toISOString()`.
/// A year past 9999 prints as `+0YYYYY`, so the slices then cut it short, as
/// they do in JavaScript (the database refuses the value on both backends).
fn timestamp_text(epoch_ms: i64) -> String {
    let (year, month, day) = civil_from_days(epoch_ms.div_euclid(DAY_MS));
    let in_day = epoch_ms.rem_euclid(DAY_MS);
    let (hour, minute) = (in_day / 3_600_000, in_day / 60_000 % 60);
    let (second, milli) = (in_day / 1000 % 60, in_day % 1000);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    let iso = format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z");
    let slice = |from: usize, to: usize| iso.get(from..to.min(iso.len())).unwrap_or_default();
    format!("{} {}", slice(0, 10), slice(11, 23))
}

/// `dateLiteral(m)`: the instant in UTC, checked.
fn date_literal(found: &DateMatch, raw: &str) -> Result<Literal, ODataError> {
    let (hour, minute) = found.time.unwrap_or((0, 0));
    if found.day < 1
        || found.day > days_in_month(found.year, found.month)
        || hour > 23
        || minute > 59
        || found.second > 59
    {
        return Err(bad_request(format!("'{raw}' is not a valid date or time")));
    }
    let epoch = days_from_civil(found.year, found.month, found.day) * DAY_MS
        + hour * 3_600_000
        + minute * 60_000
        + found.second * 1000
        + found.milli
        + found.shift_minutes * 60_000;
    let (year, _, _) = civil_from_days(epoch.div_euclid(DAY_MS));
    if !(1..=9999).contains(&year) {
        return Err(bad_request(format!("'{raw}' is out of range")));
    }
    Ok(Literal::DateTime {
        ts: timestamp_text(epoch),
        day_end: found.time.is_none().then(|| timestamp_text(epoch + DAY_MS)),
    })
}

/// The end of the `NUMBER` pattern at `at`: `-?\d+(\.\d+)?([eE][+-]?\d+)?`.
fn match_number(bytes: &[u8], at: usize) -> usize {
    let run = |from: usize| {
        bytes.get(from..).map_or(0, |rest| {
            rest.iter().take_while(|b| b.is_ascii_digit()).count()
        })
    };
    let mut end = at + usize::from(bytes.get(at) == Some(&b'-'));
    end += run(end);
    if bytes.get(end) == Some(&b'.') && run(end + 1) > 0 {
        end += 1 + run(end + 1);
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        if run(end + 1 + sign) > 0 {
            end += 1 + sign + run(end + 1 + sign);
        }
    }
    end
}

/// `Unexpected character '<ch>' in $filter`, with the character as
/// JavaScript's `text[i]` gives it: one UTF-16 unit.
fn unexpected_character(ch: char) -> ODataError {
    let mut units = [0_u16; 2];
    if ch.encode_utf16(&mut units).len() == 2 {
        return ODataError::bad_request_quoting_unit(
            "Unexpected character '",
            units[0],
            "' in $filter",
        );
    }
    bad_request(format!("Unexpected character '{ch}' in $filter"))
}

fn tokenize(text: &str) -> Result<Vec<Token>, ODataError> {
    let bytes = text.as_bytes();
    let is_digit = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        match byte {
            b' ' | b'\t' => i += 1,
            b'(' | b')' | b',' | b':' | b'/' => {
                out.push(match byte {
                    b'(' => Token::Open,
                    b')' => Token::Close,
                    b',' => Token::Comma,
                    b':' => Token::Colon,
                    _ => Token::Slash,
                });
                i += 1;
            }
            b'\'' => {
                let mut value = String::new();
                let mut j = i + 1;
                loop {
                    // A quote is one byte, so these cuts fall between characters.
                    let Some(offset) = bytes[j..].iter().position(|b| *b == b'\'') else {
                        return Err(bad_request("Unterminated string literal in $filter"));
                    };
                    value.push_str(&text[j..j + offset]);
                    j += offset;
                    if bytes.get(j + 1) == Some(&b'\'') {
                        value.push('\'');
                        j += 2;
                        continue;
                    }
                    break;
                }
                out.push(Token::Str(value));
                i = j + 1;
            }
            _ if byte.is_ascii_digit() || (byte == b'-' && is_digit(i + 1)) => {
                let date = if byte == b'-' {
                    None
                } else {
                    match_datetime(bytes, i)
                };
                if let Some(found) = date {
                    out.push(Token::DateTime(date_literal(&found, &text[i..found.end])?));
                    i = found.end;
                } else {
                    let end = match_number(bytes, i);
                    let raw = &text[i..end];
                    let value: f64 = raw.parse().unwrap_or(f64::NAN);
                    let integer = !raw.contains(['.', 'e', 'E']);
                    if !value.is_finite() || (integer && value.abs() > MAX_SAFE_INTEGER) {
                        return Err(bad_request(format!("'{raw}' is out of range")));
                    }
                    out.push(if integer {
                        Token::Int(value)
                    } else {
                        Token::Double(value)
                    });
                    i = end;
                }
                if let Some(&next) = bytes.get(i)
                    && (next.is_ascii_alphanumeric() || next == b'_' || next == b'.')
                {
                    return Err(unexpected_character(char::from(next)));
                }
            }
            _ if byte.is_ascii_alphabetic() || byte == b'_' => {
                let length = bytes[i..]
                    .iter()
                    .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                    .count();
                out.push(Token::Ident(text[i..i + length].to_owned()));
                i += length;
            }
            _ => {
                let ch = text[i..]
                    .chars()
                    .next()
                    .unwrap_or(char::REPLACEMENT_CHARACTER);
                return Err(unexpected_character(ch));
            }
        }
    }
    out.push(Token::End);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

enum Operand<'a> {
    Prop(&'a Property),
    Func(DateFn, &'a Property),
    Lit(Literal),
    Pred(Node<'a>),
}

/// `checkLiteral`: the literal, checked against the type it is compared with.
fn check_literal(op: CmpOp, name: &str, edm: EdmType, lit: Literal) -> Result<Literal, ODataError> {
    if lit == Literal::Null {
        if !op.is_equality() {
            return Err(bad_request(format!(
                "null can only be compared with eq or ne (property '{name}')"
            )));
        }
        return Ok(lit);
    }
    let mismatch = |lit: &Literal| {
        bad_request(format!(
            "Cannot compare {} '{name}' with a {} literal",
            edm.name(),
            lit.type_name()
        ))
    };
    let fits = match edm {
        EdmType::String => matches!(lit, Literal::String(_)),
        EdmType::Int32 | EdmType::Int64 => matches!(lit, Literal::Int(_)),
        EdmType::Double => matches!(lit, Literal::Int(_) | Literal::Double(_)),
        EdmType::Boolean => matches!(lit, Literal::Boolean(_)),
        EdmType::DateTimeOffset => matches!(lit, Literal::DateTime { .. }),
        EdmType::StringCollection => {
            return Err(bad_request(format!(
                "Property '{name}' is a collection: use {name}/any(t: t eq 'value')"
            )));
        }
    };
    if !fits {
        return Err(mismatch(&lit));
    }
    if edm == EdmType::Int32
        && let Literal::Int(value) = lit
        && value.abs() > INT32_MAX
    {
        return Err(bad_request(format!(
            "'{}' does not fit {} '{name}'",
            number_text(value),
            edm.name()
        )));
    }
    if edm == EdmType::Boolean && !op.is_equality() {
        return Err(bad_request(format!(
            "Booleans can only be compared with eq or ne (property '{name}')"
        )));
    }
    Ok(lit)
}

struct Parser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    comparisons: usize,
    set: &'a EntitySet,
}

impl<'a> Parser<'a> {
    fn parse(mut self) -> Result<Node<'a>, ODataError> {
        let node = self.or(0)?;
        if *self.peek() != Token::End {
            return Err(bad_request(format!(
                "Unexpected {} in $filter",
                self.peek().describe()
            )));
        }
        Ok(node)
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::End)
    }

    fn next(&mut self) -> Token {
        let token = self.peek().clone();
        if token != Token::End {
            self.pos += 1;
        }
        token
    }

    fn is_ident(&self, name: &str) -> bool {
        matches!(self.peek(), Token::Ident(value) if value == name)
    }

    /// `expect(t)`; `symbol` is how the message writes the wanted token.
    fn expect(&mut self, wanted: &Token, symbol: char) -> Result<(), ODataError> {
        let token = self.next();
        if token != *wanted {
            return Err(bad_request(format!(
                "Expected '{symbol}' but found {} in $filter",
                token.describe()
            )));
        }
        Ok(())
    }

    fn count(&mut self) -> Result<(), ODataError> {
        self.comparisons += 1;
        if self.comparisons > MAX_FILTER_COMPARISONS {
            return Err(bad_request(format!(
                "$filter has more than {MAX_FILTER_COMPARISONS} comparisons"
            )));
        }
        Ok(())
    }

    fn deeper(depth: usize) -> Result<usize, ODataError> {
        if depth + 1 > MAX_FILTER_DEPTH {
            return Err(bad_request(format!(
                "$filter is nested deeper than {MAX_FILTER_DEPTH} levels"
            )));
        }
        Ok(depth + 1)
    }

    fn or(&mut self, depth: usize) -> Result<Node<'a>, ODataError> {
        let mut args = vec![self.and(depth)?];
        while self.is_ident("or") {
            self.next();
            args.push(self.and(depth)?);
        }
        Ok(if args.len() == 1 {
            args.swap_remove(0)
        } else {
            Node::Or(args)
        })
    }

    fn and(&mut self, depth: usize) -> Result<Node<'a>, ODataError> {
        let mut args = vec![self.not(depth)?];
        while self.is_ident("and") {
            self.next();
            args.push(self.not(depth)?);
        }
        Ok(if args.len() == 1 {
            args.swap_remove(0)
        } else {
            Node::And(args)
        })
    }

    fn not(&mut self, depth: usize) -> Result<Node<'a>, ODataError> {
        if self.is_ident("not") {
            self.next();
            let depth = Self::deeper(depth)?;
            return Ok(Node::Not(Box::new(self.not(depth)?)));
        }
        self.primary(depth)
    }

    fn primary(&mut self, depth: usize) -> Result<Node<'a>, ODataError> {
        if *self.peek() == Token::Open {
            self.next();
            let depth = Self::deeper(depth)?;
            let node = self.or(depth)?;
            self.expect(&Token::Close, ')')?;
            return Ok(node);
        }
        let left = self.operand()?;
        let token = self.peek().clone();
        if let Token::Ident(word) = &token
            && let Some(op) = CmpOp::parse(word)
        {
            self.next();
            let right = self.operand()?;
            return self.comparison(op, left, right);
        }
        if let Operand::Pred(node) = left {
            return Ok(node);
        }
        Err(bad_request(format!(
            "Expected a comparison (eq, ne, gt, ge, lt, le) but found {} in $filter",
            token.describe()
        )))
    }

    fn comparison(
        &mut self,
        op: CmpOp,
        left: Operand<'a>,
        right: Operand<'a>,
    ) -> Result<Node<'a>, ODataError> {
        if matches!(left, Operand::Pred(_)) || matches!(right, Operand::Pred(_)) {
            return Err(bad_request(
                "A function result cannot be compared; use the function on its own",
            ));
        }
        // A literal on the left swaps the sides and flips the operator.
        let (subject, literal, operator) = if matches!(left, Operand::Lit(_)) {
            (right, left, op.flip())
        } else {
            (left, right, op)
        };
        let (prop, func, lit) = match (subject, literal) {
            (Operand::Prop(prop), Operand::Lit(lit)) => (prop, None, lit),
            (Operand::Func(func, prop), Operand::Lit(lit)) => (prop, Some(func), lit),
            _ => {
                return Err(bad_request(
                    "A comparison needs a property on one side and a literal on the other",
                ));
            }
        };
        self.count()?;
        let edm = if func.is_some() {
            EdmType::Int32
        } else {
            prop.edm
        };
        let lit = check_literal(operator, &prop.name, edm, lit)?;
        Ok(Node::Cmp {
            op: operator,
            prop,
            func,
            lit,
        })
    }

    fn property(&self, name: &str) -> Result<&'a Property, ODataError> {
        let Some(prop) = self.set.property(name) else {
            return Err(bad_request(format!(
                "Unknown property '{name}' on {}",
                self.set.name
            )));
        };
        if !prop.filterable {
            return Err(bad_request(format!(
                "Property '{name}' cannot be used in $filter"
            )));
        }
        Ok(prop)
    }

    fn operand(&mut self) -> Result<Operand<'a>, ODataError> {
        let token = self.next();
        match token {
            Token::Str(value) => Ok(Operand::Lit(Literal::String(value))),
            Token::Int(value) => Ok(Operand::Lit(Literal::Int(value))),
            Token::Double(value) => Ok(Operand::Lit(Literal::Double(value))),
            Token::DateTime(literal) => Ok(Operand::Lit(literal)),
            Token::Ident(name) => self.identifier(&name),
            other => Err(bad_request(format!(
                "Unexpected {} in $filter",
                other.describe()
            ))),
        }
    }

    fn identifier(&mut self, name: &str) -> Result<Operand<'a>, ODataError> {
        match self.peek() {
            Token::Open => {
                self.next();
                self.call(name)
            }
            Token::Slash => self.path(name),
            _ => match name {
                "true" | "false" => Ok(Operand::Lit(Literal::Boolean(name == "true"))),
                "null" => Ok(Operand::Lit(Literal::Null)),
                _ => Ok(Operand::Prop(self.property(name)?)),
            },
        }
    }

    /// A function call, the `(` already consumed.
    fn call(&mut self, name: &str) -> Result<Operand<'a>, ODataError> {
        let date = DateFn::parse(name);
        let text = TextFn::parse(name);
        if date.is_none() && text.is_none() {
            return Err(ODataError::not_implemented(format!(
                "The function '{name}' is not supported in $filter"
            )));
        }
        let Operand::Prop(prop) = self.operand()? else {
            return Err(bad_request(format!(
                "The first argument of {name}() must be a property"
            )));
        };
        if let Some(func) = date {
            self.expect(&Token::Close, ')')?;
            if prop.edm != EdmType::DateTimeOffset {
                return Err(bad_request(format!(
                    "{name}() needs a date property, '{}' is {}",
                    prop.name,
                    prop.edm.name()
                )));
            }
            return Ok(Operand::Func(func, prop));
        }
        self.expect(&Token::Comma, ',')?;
        let value = self.operand()?;
        self.expect(&Token::Close, ')')?;
        if prop.edm != EdmType::String {
            return Err(bad_request(format!(
                "{name}() needs a string property, '{}' is {}",
                prop.name,
                prop.edm.name()
            )));
        }
        let (Operand::Lit(Literal::String(value)), Some(func)) = (value, text) else {
            return Err(bad_request(format!(
                "The second argument of {name}() must be a string literal"
            )));
        };
        self.count()?;
        Ok(Operand::Pred(Node::Text { func, prop, value }))
    }

    /// `property/any(t: t eq 'x')`; every other path is navigation or a
    /// lambda we do not run.
    fn path(&mut self, name: &str) -> Result<Operand<'a>, ODataError> {
        let prop = self.property(name)?;
        self.next();
        let member = self.next();
        if member != Token::Ident("any".to_owned()) || *self.peek() != Token::Open {
            return Err(ODataError::not_implemented(format!(
                "Navigation paths and lambdas other than any() are not supported ({name}/…)"
            )));
        }
        self.next();
        if prop.edm != EdmType::StringCollection {
            return Err(bad_request(format!(
                "any() needs a collection property, '{name}' is {}",
                prop.edm.name()
            )));
        }
        let variable = match self.next() {
            Token::Close => {
                return Err(ODataError::not_implemented(
                    "any() without a predicate is not supported",
                ));
            }
            Token::Ident(variable) => variable,
            _ => return Err(bad_request("Expected a variable name in any()")),
        };
        self.expect(&Token::Colon, ':')?;
        let again = self.next();
        let op = self.next();
        let value = self.next();
        if again != Token::Ident(variable.clone()) || op != Token::Ident("eq".to_owned()) {
            return Err(ODataError::not_implemented(format!(
                "Only any({variable}: {variable} eq 'value') is supported"
            )));
        }
        let Token::Str(value) = value else {
            return Err(bad_request(format!(
                "any() compares with a string literal, not {}",
                value.describe()
            )));
        };
        self.expect(&Token::Close, ')')?;
        self.count()?;
        Ok(Operand::Pred(Node::Any { prop, value }))
    }
}

/// `parseFilter(text, set)`: a `$filter` value against an entity set.
pub(crate) fn parse_filter<'a>(text: &str, set: &'a EntitySet) -> Result<Node<'a>, ODataError> {
    // `text.length`: UTF-16 units.
    if text.encode_utf16().count() > MAX_FILTER_LENGTH {
        return Err(bad_request(format!(
            "$filter is longer than {MAX_FILTER_LENGTH} characters"
        )));
    }
    if js_trim(text).is_empty() {
        return Err(bad_request("$filter is empty"));
    }
    Parser {
        tokens: tokenize(text)?,
        pos: 0,
        comparisons: 0,
        set,
    }
    .parse()
}

#[cfg(test)]
mod tests {
    use http::StatusCode;

    use super::super::catalog::find_entity_set;
    use super::*;

    fn conversations() -> &'static EntitySet {
        find_entity_set("Conversations").expect("the set")
    }

    fn parse(text: &str) -> Node<'static> {
        match parse_filter(text, conversations()) {
            Ok(node) => node,
            Err(error) => panic!("{text}: {}", error.message),
        }
    }

    fn failure(text: &str) -> ODataError {
        match parse_filter(text, conversations()) {
            Ok(_) => panic!("expected {text:?} to be refused"),
            Err(error) => error,
        }
    }

    fn rejects(text: &str) {
        assert_eq!(failure(text).status, StatusCode::BAD_REQUEST, "{text}");
    }

    fn unserved(text: &str) {
        assert_eq!(failure(text).status, StatusCode::NOT_IMPLEMENTED, "{text}");
    }

    /// The comparison a text parses to: operator, property name, function, literal.
    fn cmp(text: &str) -> (CmpOp, String, Option<DateFn>, Literal) {
        match parse(text) {
            Node::Cmp {
                op,
                prop,
                func,
                lit,
            } => (op, prop.name.clone(), func, lit),
            other => panic!("{text}: {other:?}"),
        }
    }

    fn lit(text: &str) -> Literal {
        cmp(text).3
    }

    fn ts(text: &str) -> String {
        match lit(text) {
            Literal::DateTime { ts, .. } => ts,
            other => panic!("{text}: {other:?}"),
        }
    }

    fn kinds(nodes: &[Node<'_>]) -> Vec<&'static str> {
        nodes
            .iter()
            .map(|node| match node {
                Node::And(_) => "and",
                Node::Or(_) => "or",
                Node::Not(_) => "not",
                Node::Cmp { .. } => "cmp",
                Node::Text { .. } => "text",
                Node::Any { .. } => "any",
            })
            .collect()
    }

    #[test]
    fn and_binds_tighter_than_or_and_parentheses_override() {
        let Node::Or(args) = parse("state eq 'a' or state eq 'b' and channel eq 'c'") else {
            panic!("an or");
        };
        assert_eq!(kinds(&args), ["cmp", "and"]);
        let Node::And(args) = parse("(state eq 'a' or state eq 'b') and channel eq 'c'") else {
            panic!("an and");
        };
        assert_eq!(kinds(&args), ["or", "cmp"]);
        let Node::And(args) = parse("not state eq 'a' and not not channel eq 'c'") else {
            panic!("an and");
        };
        assert_eq!(kinds(&args), ["not", "not"]);
        assert!(matches!(
            parse("not (state eq 'a' or state eq 'b')"),
            Node::Not(_)
        ));
        let Node::And(args) = parse("state eq 'a' and channel eq 'b' and priority eq 'c'") else {
            panic!("an and");
        };
        assert_eq!(args.len(), 3);
    }

    #[test]
    fn strings_read_doubled_quotes_and_special_characters() {
        assert_eq!(lit("title eq 'it''s'"), Literal::String("it's".into()));
        assert_eq!(lit("title eq ''"), Literal::String(String::new()));
        assert_eq!(lit("title eq ''''"), Literal::String("'".into()));
        assert_eq!(
            lit("title eq 'a and b (c) eq'"),
            Literal::String("a and b (c) eq".into())
        );
        assert_eq!(lit("title eq 'é😀'"), Literal::String("é😀".into()));
    }

    #[test]
    fn null_and_a_literal_on_the_left() {
        assert_eq!(cmp("title eq null").0, CmpOp::Eq);
        assert_eq!(lit("title eq null"), Literal::Null);
        let (op, name, _, literal) = cmp("null ne title");
        assert_eq!(
            (op, name.as_str(), literal),
            (CmpOp::Ne, "title", Literal::Null)
        );
        rejects("title gt null");
        rejects("null lt rating");
        let (op, name, _, literal) = cmp("5 lt rating");
        assert_eq!(
            (op, name.as_str(), literal),
            (CmpOp::Gt, "rating", Literal::Int(5.0))
        );
        assert_eq!(cmp("5 ge rating").0, CmpOp::Le);
        let (op, name, ..) = cmp("'open' eq state");
        assert_eq!((op, name.as_str()), (CmpOp::Eq, "state"));
    }

    #[test]
    fn integers_negatives_and_booleans() {
        assert_eq!(lit("rating ge -3"), Literal::Int(-3.0));
        assert_eq!(lit("rating eq 0"), Literal::Int(0.0));
        assert_eq!(lit("isMajorIncident eq true"), Literal::Boolean(true));
        assert_eq!(lit("isMajorIncident ne false"), Literal::Boolean(false));
    }

    #[test]
    fn date_times_in_utc_with_offsets_fractions_and_bare_dates() {
        assert_eq!(
            ts("createdAt ge 2026-01-31T00:00:00Z"),
            "2026-01-31 00:00:00.000"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T10:30:00+02:00"),
            "2026-01-31 08:30:00.000"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T10:30:00-05:00"),
            "2026-01-31 15:30:00.000"
        );
        // An unescaped `+` arrives as a space.
        assert_eq!(
            ts("createdAt ge 2026-01-31T10:30:00 02:00"),
            "2026-01-31 08:30:00.000"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T00:00:00.123456Z"),
            "2026-01-31 00:00:00.123"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T00:00:00.5Z"),
            "2026-01-31 00:00:00.500"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T09:15Z"),
            "2026-01-31 09:15:00.000"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-31T09:15:00"),
            "2026-01-31 09:15:00.000"
        );
        assert_eq!(
            ts("createdAt ge 2026-01-01T00:30:00+01:00"),
            "2025-12-31 23:30:00.000"
        );
        assert_eq!(
            lit("createdAt ge 2026-01-31"),
            Literal::DateTime {
                ts: "2026-01-31 00:00:00.000".into(),
                day_end: Some("2026-02-01 00:00:00.000".into()),
            }
        );
        assert_eq!(
            lit("createdAt lt 2024-02-29"),
            Literal::DateTime {
                ts: "2024-02-29 00:00:00.000".into(),
                day_end: Some("2024-03-01 00:00:00.000".into()),
            }
        );
        // An instant has no day end.
        assert!(matches!(
            lit("createdAt eq 2026-01-31T00:00:00Z"),
            Literal::DateTime { day_end: None, .. }
        ));
        // The last day JavaScript's slices still print, and the one they cut.
        assert_eq!(
            lit("createdAt eq 9999-12-31"),
            Literal::DateTime {
                ts: "9999-12-31 00:00:00.000".into(),
                day_end: Some("+010000-01 01T00:00:00.".into()),
            }
        );
    }

    #[test]
    fn impossible_dates_and_times_are_refused() {
        for text in [
            "2026-02-30",
            "2025-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-01-00",
            "2026-01-31T24:00:00Z",
            "2026-01-31T10:60:00Z",
            "2026-01-31T10:00:60Z",
        ] {
            assert_eq!(
                failure(&format!("createdAt eq {text}")).message,
                format!("'{text}' is not a valid date or time")
            );
        }
        for text in [
            "0001-01-01T00:00:00+05:00",
            "0000-06-01",
            "9999-12-31T23:59:59-01:00",
        ] {
            assert_eq!(
                failure(&format!("createdAt eq {text}")).message,
                format!("'{text}' is out of range")
            );
        }
    }

    #[test]
    fn functions_and_date_parts() {
        assert!(matches!(
            parse("contains(title,'x')"),
            Node::Text { func: TextFn::Contains, value, .. } if value == "x"
        ));
        assert!(matches!(
            parse("startswith(title, 'x')"),
            Node::Text {
                func: TextFn::StartsWith,
                ..
            }
        ));
        assert!(matches!(
            parse("endswith( email , 'x.test' )"),
            Node::Text { func: TextFn::EndsWith, prop, .. } if prop.name == "email"
        ));
        assert!(matches!(parse("not contains(title,'x')"), Node::Not(_)));
        let (op, _, func, literal) = cmp("year(createdAt) eq 2026");
        assert_eq!(
            (op, func, literal),
            (CmpOp::Eq, Some(DateFn::Year), Literal::Int(2026.0))
        );
        let (op, _, func, _) = cmp("month(createdAt) ge 6");
        assert_eq!((op, func), (CmpOp::Ge, Some(DateFn::Month)));
        let (op, _, func, _) = cmp("3 gt day(createdAt)");
        assert_eq!((op, func), (CmpOp::Lt, Some(DateFn::Day)));
        rejects("year(title) eq 2026");
        rejects("year(createdAt) eq '2026'");
        rejects("year(createdAt)");
    }

    #[test]
    fn any_on_a_collection_and_nothing_else_on_one() {
        assert!(matches!(
            parse("tags/any(t: t eq 'vip')"),
            Node::Any { prop, value } if prop.name == "tags" && value == "vip"
        ));
        assert!(matches!(
            parse("tags/any(x:x eq 'it''s')"),
            Node::Any { value, .. } if value == "it's"
        ));
        rejects("tags eq 'vip'");
        rejects("tags/any(t: t eq 5)");
        rejects("title/any(t: t eq 'x')");
        rejects("contains(tags,'x')");
        unserved("tags/all(t: t eq 'x')");
        unserved("tags/any(t: t ne 'x')");
        unserved("tags/any(t: u eq 'x')");
        unserved("tags/any()");
        rejects("tags/$count gt 1");
        unserved("title/length gt 1");
    }

    #[test]
    fn other_functions_are_501_and_unknown_properties_400() {
        for text in [
            "tolower(title) eq 'a'",
            "length(title) gt 3",
            "substringof('a', title)",
            "concat(title,'a') eq 'b'",
            "cast(title, 'Edm.Int32') eq 1",
        ] {
            unserved(text);
        }
        rejects("nope eq 'a'");
        rejects("Title eq 'a'");
        rejects("title eq 'a' and nope eq 1");
    }

    #[test]
    fn a_literal_of_the_wrong_type_is_refused() {
        for text in [
            "title eq 5",
            "conversationNumber eq 'x'",
            "conversationNumber eq 1.5",
            "conversationNumber eq true",
            "conversationNumber eq 2147483648",
            "isMajorIncident eq 'true'",
            "isMajorIncident gt true",
            "createdAt eq 5",
            "createdAt eq 'yesterday'",
            "title eq 2026-01-31",
            "title eq false",
        ] {
            rejects(text);
        }
        parse("conversationNumber eq 2147483647");
        rejects("conversationNumber eq -2147483648");
    }

    #[test]
    fn comparisons_need_a_property_and_a_literal() {
        for text in [
            "'a' eq 'b'",
            "title eq state",
            "1 eq 1",
            "contains(title,'a') eq true",
            "isMajorIncident",
            "true",
            "'x'",
        ] {
            rejects(text);
        }
    }

    #[test]
    fn malformed_input_is_refused() {
        for text in [
            "",
            "   ",
            "title eq",
            "title eq 'x",
            "(title eq 'x'",
            "title eq 'x')",
            "title == 'x'",
            "title eq 'x' and",
            "and title eq 'x'",
            "title eq 'x' title eq 'y'",
            "title EQ 'x'",
            "state eq 'a' AND state eq 'b'",
            "title.length eq 1",
            "title eq 'x';",
            "title eq $it",
            "title eq @a",
            "title eq 12abc",
            "rating eq 1e",
            "rating eq 99999999999999999999",
            "contains(title)",
            "contains(title,'a','b')",
            "contains('a',title)",
            "contains(title,state)",
            "contains(title,'a'",
            "title eq 2026-01-31Tx",
            "rating eq 1; DROP TABLE x",
            "rating eq 1 OR 1=1",
            "rating eq (1)",
            "rating eq 1/**/",
        ] {
            rejects(text);
        }
    }

    #[test]
    fn the_length_depth_and_comparison_limits() {
        rejects(&format!("title eq '{}'", "x".repeat(2000)));
        parse(&format!("title eq '{}'", "x".repeat(1980)));
        // The limit counts UTF-16 units: 1 000 emoji are 2 000 units.
        rejects(&format!("title eq '{}'", "😀".repeat(1000)));
        parse(&format!("title eq '{}'", "😀".repeat(990)));

        let nest = |depth: usize| format!("{}state eq 'a'{}", "(".repeat(depth), ")".repeat(depth));
        parse(&nest(10));
        rejects(&nest(11));
        rejects(&nest(400));
        parse(&format!("{}state eq 'a'", "not ".repeat(9)));
        rejects(&format!("{}state eq 'a'", "not ".repeat(11)));

        let many = |n: usize| {
            (0..n)
                .map(|i| format!("rating eq {i}"))
                .collect::<Vec<_>>()
                .join(" or ")
        };
        parse(&many(30));
        rejects(&many(31));
    }

    /// The messages are part of the answer: they name what was found.
    #[test]
    #[allow(clippy::too_many_lines)] // one table of filters and their messages
    fn the_messages_are_the_workers() {
        for (text, message) in [
            ("nope eq 'a'", "Unknown property 'nope' on Conversations"),
            ("title eq", "Unexpected end of expression in $filter"),
            (
                "title eq 5",
                "Cannot compare Edm.String 'title' with a int literal",
            ),
            ("title eq 'x", "Unterminated string literal in $filter"),
            (
                "state eq 'a' AND state eq 'b'",
                "Unexpected 'AND' in $filter",
            ),
            (
                "rating eq 1.5",
                "Cannot compare Edm.Int32 'rating' with a double literal",
            ),
            (
                "tags eq 1",
                "Property 'tags' is a collection: use tags/any(t: t eq 'value')",
            ),
            ("", "$filter is empty"),
            (
                "title gt null",
                "null can only be compared with eq or ne (property 'title')",
            ),
            (
                "conversationNumber eq 2147483648",
                "'2147483648' does not fit Edm.Int32 'conversationNumber'",
            ),
            (
                "isMajorIncident gt true",
                "Booleans can only be compared with eq or ne (property 'isMajorIncident')",
            ),
            (
                "title eq 2026-01-31",
                "Cannot compare Edm.String 'title' with a datetime literal",
            ),
            ("title eq 12abc", "Unexpected character 'a' in $filter"),
            ("rating eq 1e", "Unexpected character 'e' in $filter"),
            (
                "rating eq 99999999999999999999",
                "'99999999999999999999' is out of range",
            ),
            ("rating eq 1e999", "'1e999' is out of range"),
            ("title == 'x'", "Unexpected character '=' in $filter"),
            ("title eq 'x' title eq 'y'", "Unexpected 'title' in $filter"),
            ("title eq 'x')", "Unexpected ')' in $filter"),
            (
                "(title eq 'x'",
                "Expected ')' but found end of expression in $filter",
            ),
            (
                "isMajorIncident",
                "Expected a comparison (eq, ne, gt, ge, lt, le) but found end of expression in $filter",
            ),
            (
                "title 5",
                "Expected a comparison (eq, ne, gt, ge, lt, le) but found 'int' in $filter",
            ),
            (
                "title eq state",
                "A comparison needs a property on one side and a literal on the other",
            ),
            (
                "contains(title,'a') eq true",
                "A function result cannot be compared; use the function on its own",
            ),
            ("contains(title)", "Expected ',' but found ')' in $filter"),
            (
                "contains('a',title)",
                "The first argument of contains() must be a property",
            ),
            (
                "contains(title,state)",
                "The second argument of contains() must be a string literal",
            ),
            (
                "contains(tags,'x')",
                "contains() needs a string property, 'tags' is Collection(Edm.String)",
            ),
            (
                "year(title) eq 2026",
                "year() needs a date property, 'title' is Edm.String",
            ),
            (
                "year(createdAt) eq '2026'",
                "Cannot compare Edm.Int32 'createdAt' with a string literal",
            ),
            (
                "tolower(title) eq 'a'",
                "The function 'tolower' is not supported in $filter",
            ),
            (
                "title/length gt 1",
                "Navigation paths and lambdas other than any() are not supported (title/…)",
            ),
            (
                "title/any(t: t eq 'x')",
                "any() needs a collection property, 'title' is Edm.String",
            ),
            ("tags/any()", "any() without a predicate is not supported"),
            ("tags/any(1: t eq 'x')", "Expected a variable name in any()"),
            (
                "tags/any(t: u eq 'x')",
                "Only any(t: t eq 'value') is supported",
            ),
            (
                "tags/any(t: t eq 5)",
                "any() compares with a string literal, not 'int'",
            ),
            ("tags/$count gt 1", "Unexpected character '$' in $filter"),
            (
                "title eq 2026-01-31Tx",
                "Unexpected character 'T' in $filter",
            ),
            ("title eq (", "Unexpected '(' in $filter"),
        ] {
            assert_eq!(failure(text).message, message, "{text}");
        }
        assert_eq!(
            failure(&"(".repeat(11)).message,
            "$filter is nested deeper than 10 levels"
        );
        assert_eq!(
            failure(&format!("title eq '{}'", "x".repeat(2000))).message,
            "$filter is longer than 2000 characters"
        );
        // A character outside the basic plane is named by its first UTF-16 unit.
        assert_eq!(
            failure("title eq 😀").body(),
            r#"{"error":{"code":"BadRequest","message":"Unexpected character '\ud83d' in $filter"}}"#
        );
        assert_eq!(
            failure("title eq é").message,
            "Unexpected character 'é' in $filter"
        );
    }

    #[test]
    fn a_name_that_is_not_a_property_never_parses() {
        for name in [
            "id; DROP TABLE desk_conversations",
            "id) OR (1=1",
            "\"id\"",
            "id--",
            "state/**/eq",
            "' or 1=1 --",
            "id OR 1",
            "__proto__",
            "constructor",
            "toString",
        ] {
            assert!(
                parse_filter(&format!("{name} eq 'x'"), conversations()).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn the_calendar_arithmetic_round_trips() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 1, 31), 20_484);
        for days in [-719_468, -1, 0, 59, 60, 11_016, 20_484, 2_932_896] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
        assert_eq!(civil_from_days(2_932_896), (9999, 12, 31));
        assert_eq!(timestamp_text(1_769_817_600_250), "2026-01-31 00:00:00.250");
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2100, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(2026, 13), 0);
    }
}
