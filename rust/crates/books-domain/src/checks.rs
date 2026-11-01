//! Check printing (`us-compliance/checks`): the amount in words, the
//! courtesy amount, the MICR E-13B line for blank check stock, the fractional
//! routing number and the layout data (field positions in points) of the
//! Letter check stocks the platform prints with jsPDF.

use serde_json::{Map, Value, json};

use crate::js::{math_round, number_value};
use crate::nacha::aba_checksum_valid;

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const SCALES: [&str; 4] = ["", "thousand", "million", "billion"];

/// Largest amount a check can say in words.
pub const CHECK_MAX_AMOUNT: f64 = 999_999_999_999.99;

fn under_thousand(n: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let hundreds = n / 100;
    let rest = n % 100;
    if hundreds > 0 {
        parts.push(format!("{} hundred", ONES[usize::try_from(hundreds).unwrap_or(0)]));
    }
    if rest > 0 {
        if rest < 20 {
            parts.push(ONES[usize::try_from(rest).unwrap_or(0)].to_owned());
        } else {
            let tens = TENS[usize::try_from(rest / 10).unwrap_or(0)];
            let ones = rest % 10;
            parts.push(if ones > 0 {
                format!("{tens}-{}", ONES[usize::try_from(ones).unwrap_or(0)])
            } else {
                tens.to_owned()
            });
        }
    }
    parts.join(" ")
}

fn whole_number_in_words(n: i64) -> String {
    if n == 0 {
        return "zero".to_owned();
    }
    let mut groups: Vec<String> = Vec::new();
    let mut remaining = n;
    let mut scale = 0;
    while remaining > 0 {
        let group = remaining % 1000;
        if group > 0 {
            let words = under_thousand(group);
            groups.insert(
                0,
                if scale > 0 {
                    format!("{words} {}", SCALES.get(scale).copied().unwrap_or_default())
                } else {
                    words
                },
            );
        }
        remaining /= 1000;
        scale += 1;
    }
    groups.join(" ")
}

fn valid_amount(amount: f64) -> bool {
    amount.is_finite() && (0.0..=CHECK_MAX_AMOUNT).contains(&amount)
}

/// `amountInWords(amount)`: "One thousand two hundred thirty-four and
/// 56/100"; `None` where TypeScript throws (negative, not finite, too big).
pub fn amount_in_words(amount: f64) -> Option<String> {
    if !valid_amount(amount) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    let total_cents = math_round(amount * 100.0) as i64;
    let words = whole_number_in_words(total_cents / 100);
    let mut chars = words.chars();
    let first = chars.next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
    Some(format!(
        "{first}{} and {:02}/100",
        chars.as_str(),
        total_cents % 100
    ))
}

/// `courtesyAmount(amount)`: "$**1,234.56"; `None` where TypeScript throws.
pub fn courtesy_amount(amount: f64) -> Option<String> {
    if !valid_amount(amount) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    let cents = math_round(amount * 100.0) as i64;
    let dollars = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in dollars.chars().enumerate() {
        if i > 0 && (dollars.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    Some(format!("$**{grouped}.{:02}", cents % 100))
}

// ── MICR ────────────────────────────────────────────────────────────────────

/// U+2446: brackets the routing (transit) number.
pub const MICR_TRANSIT: char = '\u{2446}';
/// U+2447: brackets the amount the bank encodes.
pub const MICR_AMOUNT: char = '\u{2447}';
/// U+2448: ends the account field and brackets the auxiliary on-us field.
pub const MICR_ON_US: char = '\u{2448}';
/// U+2449: a hyphen in an account number.
pub const MICR_DASH: char = '\u{2449}';

/// `MicrInput`.
#[derive(Debug, Clone)]
pub struct MicrInput<'a> {
    pub routing_number: &'a str,
    pub account_number: &'a str,
    pub check_number: &'a str,
    /// `personal`: the check number after the account; else business.
    pub personal: bool,
    pub check_number_width: usize,
}

/// `MicrFields`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicrFields {
    pub aux_on_us: String,
    pub transit: String,
    pub on_us: String,
}

impl MicrFields {
    pub fn to_json(&self) -> Value {
        json!({ "auxOnUs": self.aux_on_us, "transit": self.transit, "onUs": self.on_us })
    }

    /// The fields with the symbols as MICR font letters.
    pub fn as_font_letters(&self) -> Self {
        Self {
            aux_on_us: micr_to_font_letters(&self.aux_on_us),
            transit: micr_to_font_letters(&self.transit),
            on_us: micr_to_font_letters(&self.on_us),
        }
    }
}

/// `validateMicrInput(input)`: the problems, empty when the line can be built.
pub fn validate_micr_input(input: &MicrInput<'_>) -> Vec<String> {
    let mut problems = Vec::new();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !(input.routing_number.len() == 9 && digits(input.routing_number)) {
        problems.push("The routing number must be 9 digits".to_owned());
    } else if !aba_checksum_valid(input.routing_number) {
        problems.push("The routing number fails the ABA checksum".to_owned());
    }
    let account: String = input
        .account_number
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if account.is_empty()
        || !account.chars().all(|c| c.is_ascii_digit() || c == '-')
        || !account.chars().any(|c| c.is_ascii_digit())
    {
        problems.push("The account number may only hold digits and hyphens".to_owned());
    } else if account.len() > 18 {
        problems.push("The account number is longer than 18 characters".to_owned());
    }
    if !digits(input.check_number) {
        problems.push("The check number must be digits".to_owned());
    } else if input.check_number.len() > 12 {
        problems.push("The check number is longer than 12 digits".to_owned());
    }
    problems
}

/// `buildMicrFields(input)`; `Err` (the problems joined) where TypeScript
/// throws.
pub fn build_micr_fields(input: &MicrInput<'_>) -> Result<MicrFields, String> {
    let problems = validate_micr_input(input);
    if !problems.is_empty() {
        return Err(problems.join("; "));
    }
    let account: String = input
        .account_number
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == '-' { MICR_DASH } else { c })
        .collect();
    let width = input.check_number_width;
    let check = format!("{:0>width$}", input.check_number);
    let transit = format!("{MICR_TRANSIT}{}{MICR_TRANSIT}", input.routing_number);
    if input.personal {
        return Ok(MicrFields {
            aux_on_us: String::new(),
            transit,
            on_us: format!("{account}{MICR_ON_US} {check}"),
        });
    }
    Ok(MicrFields {
        aux_on_us: format!("{MICR_ON_US}{check}{MICR_ON_US}"),
        transit,
        on_us: format!("{account}{MICR_ON_US}"),
    })
}

/// `buildMicrLine(input)`: the fields joined by a space.
pub fn build_micr_line(input: &MicrInput<'_>) -> Result<String, String> {
    let fields = build_micr_fields(input)?;
    Ok([fields.aux_on_us, fields.transit, fields.on_us]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" "))
}

/// `micrToFontLetters(text)`: A transit, B amount, C on-us, D dash.
pub fn micr_to_font_letters(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            MICR_TRANSIT => 'A',
            MICR_AMOUNT => 'B',
            MICR_ON_US => 'C',
            MICR_DASH => 'D',
            other => other,
        })
        .collect()
}

/// `/^\d{1,2}-\d{1,4}$/`.
pub fn is_fractional_numerator(value: &str) -> bool {
    let Some((left, right)) = value.split_once('-') else {
        return false;
    };
    let digits = |s: &str, max: usize| {
        (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
    };
    digits(left, 2) && digits(right, 4)
}

/// `fractionalRouting(routingNumber, numerator)`: "90-7162/0210"; `Ok(None)`
/// without a numerator, `Err` where TypeScript throws.
pub fn fractional_routing(routing_number: &str, numerator: Option<&str>) -> Result<Option<String>, String> {
    let Some(numerator) = numerator.filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    if !(routing_number.len() == 9 && routing_number.bytes().all(|b| b.is_ascii_digit())) {
        return Err("The routing number must be 9 digits".to_owned());
    }
    if !is_fractional_numerator(numerator) {
        return Err("The numerator looks like 90-7162".to_owned());
    }
    Ok(Some(format!("{numerator}/{}", &routing_number[..4])))
}

// ── Layouts ─────────────────────────────────────────────────────────────────

/// `CHECK_LAYOUTS`: `(id, label, description)`.
pub const CHECK_LAYOUTS: [(&str, &str, &str); 4] = [
    (
        "voucher_top",
        "Check on top, two stubs",
        "One check per Letter page with the check at the top and two voucher stubs below.",
    ),
    (
        "voucher_middle",
        "Check in the middle, two stubs",
        "One check per Letter page with a stub above and below the check.",
    ),
    (
        "voucher_bottom",
        "Check at the bottom, two stubs",
        "One check per Letter page with two stubs above the check.",
    ),
    (
        "three_per_page",
        "Three checks per page",
        "Three checks per Letter page, without stubs.",
    ),
];

/// `CHECK_LAYOUTS` as the routes answer it.
pub fn check_layouts_json() -> Value {
    Value::Array(
        CHECK_LAYOUTS
            .iter()
            .map(|(id, label, description)| {
                json!({ "id": id, "label": label, "description": description })
            })
            .collect(),
    )
}

/// `isCheckLayoutId(value)`.
pub fn is_check_layout_id(value: &str) -> bool {
    CHECK_LAYOUTS.iter().any(|(id, _, _)| *id == value)
}

const PAGE_WIDTH: f64 = 612.0;
const PAGE_HEIGHT: f64 = 792.0;
const VOUCHER_FACE_HEIGHT: f64 = 252.0;
const VOUCHER_STUB_HEIGHT: f64 = 270.0;
const THREE_UP_FACE_HEIGHT: f64 = 264.0;
const MARGIN: f64 = 36.0;
const MICR_FONT_SIZE: f64 = 12.0;
const MICR_PITCH: f64 = 9.0;
const MICR_RIGHT_MARGIN: f64 = 22.5;
const MICR_BASELINE_FROM_BOTTOM: f64 = 13.5;

/// `CheckAlignment` with the defaults filled in (`{ dx: 0, dy: 0, micrDx: 0, micrDy: 0, ...alignment }`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CheckAlignment {
    pub dx: f64,
    pub dy: f64,
    pub micr_dx: f64,
    pub micr_dy: f64,
}

/// `text(x, y, width, fontSize, extra)`: a `TextBox`.
fn text_box(x: f64, y: f64, width: f64, font_size: f64, extra: &[(&str, Value)]) -> Value {
    let mut out = Map::new();
    out.insert("x".to_owned(), number_value(x));
    out.insert("y".to_owned(), number_value(y));
    out.insert("width".to_owned(), number_value(width));
    out.insert("align".to_owned(), json!("left"));
    out.insert("fontSize".to_owned(), number_value(font_size));
    out.insert("font".to_owned(), json!("helvetica"));
    for (key, value) in extra {
        out.insert((*key).to_owned(), value.clone());
    }
    Value::Object(out)
}

fn micr_x(position: f64) -> f64 {
    PAGE_WIDTH - MICR_RIGHT_MARGIN - position * MICR_PITCH
}

fn face_fields(top: f64, height: f64, a: CheckAlignment) -> Value {
    let dx = a.dx;
    let dy = top + a.dy;
    let micr_baseline = top + height - MICR_BASELINE_FROM_BOTTOM + a.micr_dy;
    let micr_field = |near: f64, far: f64, align: &str| {
        json!({
            "x": number_value(micr_x(far) + a.micr_dx),
            "y": number_value(micr_baseline),
            "width": number_value((far - near + 1.0) * MICR_PITCH),
            "align": align,
            "fontSize": number_value(MICR_FONT_SIZE),
            "font": "micr",
        })
    };
    let signature_y = dy + height - 66.0;
    let bold = ("bold", json!(true));
    let right = ("align", json!("right"));
    json!({
        "payer": text_box(MARGIN + dx, dy + 34.0, 250.0, 10.0, &[bold.clone(), ("lineHeight", json!(12))]),
        "bank": text_box(300.0 + dx, dy + 34.0, 170.0, 9.0, &[("align", json!("center")), ("lineHeight", json!(11))]),
        "checkNumber": text_box(476.0 + dx, dy + 30.0, 100.0, 11.0, &[right.clone(), bold.clone()]),
        "fractional": text_box(476.0 + dx, dy + 18.0, 100.0, 7.0, &[right.clone()]),
        "dateLabel": text_box(440.0 + dx, dy + 88.0, 34.0, 6.5, &[]),
        "date": text_box(476.0 + dx, dy + 88.0, 100.0, 10.0, &[right.clone()]),
        "payeeLabel": text_box(MARGIN + dx, dy + 118.0, 60.0, 6.5, &[]),
        "payee": text_box(96.0 + dx, dy + 118.0, 360.0, 10.0, &[bold.clone()]),
        "payeeAddress": text_box(96.0 + dx, dy + 130.0, 360.0, 8.0, &[("lineHeight", json!(9))]),
        "amountBox": { "x": number_value(470.0 + dx), "y": number_value(dy + 104.0), "width": 106, "height": 20 },
        "amount": text_box(474.0 + dx, dy + 118.0, 98.0, 11.0, &[right.clone(), bold]),
        "amountWords": text_box(MARGIN + dx, dy + 160.0, 456.0, 10.0, &[]),
        "dollarsLabel": text_box(500.0 + dx, dy + 160.0, 76.0, 7.0, &[right]),
        "memoLabel": text_box(MARGIN + dx, signature_y - 2.0, 30.0, 6.5, &[]),
        "memo": text_box(68.0 + dx, signature_y - 2.0, 230.0, 9.0, &[]),
        "signatureLine": {
            "x1": number_value(340.0 + dx),
            "y1": number_value(signature_y),
            "x2": number_value(576.0 + dx),
            "y2": number_value(signature_y),
        },
        "voidAfter": text_box(340.0 + dx, signature_y + 10.0, 236.0, 6.5, &[("align", json!("center"))]),
        "micrAuxOnUs": micr_field(45.0, 64.0, "right"),
        "micrTransit": micr_field(33.0, 43.0, "left"),
        "micrOnUs": micr_field(14.0, 32.0, "right"),
    })
}

fn voucher_fields(top: f64, height: f64, a: CheckAlignment) -> Value {
    let dx = a.dx;
    let dy = top + a.dy;
    let row_height = 12.0;
    let table_top = dy + 76.0;
    let table_height = height - 76.0 - 44.0;
    let bold = ("bold", json!(true));
    let right = ("align", json!("right"));
    let column = |key: &str, x: f64, width: f64, align: &str| {
        json!({ "key": key, "x": number_value(x), "width": number_value(width), "align": align })
    };
    json!({
        "payer": text_box(MARGIN + dx, dy + 26.0, 300.0, 9.0, &[bold.clone()]),
        "title": text_box(MARGIN + dx, dy + 40.0, 200.0, 7.0, &[]),
        "payee": text_box(MARGIN + dx, dy + 58.0, 330.0, 10.0, &[bold.clone()]),
        "date": text_box(380.0 + dx, dy + 58.0, 90.0, 9.0, &[right.clone()]),
        "checkNumber": text_box(476.0 + dx, dy + 58.0, 100.0, 10.0, &[right.clone(), bold.clone()]),
        "table": {
            "x": number_value(MARGIN + dx),
            "y": number_value(table_top),
            "width": 540,
            "height": number_value(table_height),
            "rowHeight": number_value(row_height),
            "maxRows": number_value((table_height / row_height).floor()),
            "fontSize": 8,
            "columns": [
                column("date", MARGIN + dx, 72.0, "left"),
                column("reference", 112.0 + dx, 200.0, "left"),
                column("description", 318.0 + dx, 152.0, "left"),
                column("amount", 476.0 + dx, 100.0, "right"),
            ],
        },
        "totalLabel": text_box(400.0 + dx, dy + height - 24.0, 70.0, 8.0, &[right.clone(), bold.clone()]),
        "total": text_box(476.0 + dx, dy + height - 24.0, 100.0, 10.0, &[right, bold]),
    })
}

/// `getCheckLayout(id, alignment)`: field positions for a Letter check
/// layout, in points from the page's top-left corner. `None` for an unknown
/// layout (TypeScript throws).
pub fn get_check_layout(id: &str, alignment: CheckAlignment) -> Option<Value> {
    let (_, label, _) = CHECK_LAYOUTS.iter().find(|(known, _, _)| *known == id)?;
    let face = |top: f64, height: f64| {
        json!({ "top": number_value(top), "height": number_value(height), "fields": face_fields(top, height, alignment) })
    };
    let voucher = |top: f64| {
        json!({
            "top": number_value(top),
            "height": number_value(VOUCHER_STUB_HEIGHT),
            "fields": voucher_fields(top, VOUCHER_STUB_HEIGHT, alignment),
        })
    };
    let (faces, vouchers) = match id {
        "voucher_top" => (
            vec![face(0.0, VOUCHER_FACE_HEIGHT)],
            vec![
                voucher(VOUCHER_FACE_HEIGHT),
                voucher(VOUCHER_FACE_HEIGHT + VOUCHER_STUB_HEIGHT),
            ],
        ),
        "voucher_middle" => (
            vec![face(VOUCHER_STUB_HEIGHT, VOUCHER_FACE_HEIGHT)],
            vec![
                voucher(0.0),
                voucher(VOUCHER_STUB_HEIGHT + VOUCHER_FACE_HEIGHT),
            ],
        ),
        "voucher_bottom" => (
            vec![face(2.0 * VOUCHER_STUB_HEIGHT, VOUCHER_FACE_HEIGHT)],
            vec![voucher(0.0), voucher(VOUCHER_STUB_HEIGHT)],
        ),
        _ => (
            (0..3)
                .map(|slot| face(f64::from(slot) * THREE_UP_FACE_HEIGHT, THREE_UP_FACE_HEIGHT))
                .collect(),
            Vec::new(),
        ),
    };
    Some(json!({
        "id": id,
        "label": label,
        "page": { "width": number_value(PAGE_WIDTH), "height": number_value(PAGE_HEIGHT) },
        "faces": faces,
        "vouchers": vouchers,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_figures() {
        assert_eq!(
            amount_in_words(1234.56).as_deref(),
            Some("One thousand two hundred thirty-four and 56/100")
        );
        assert_eq!(amount_in_words(0.07).as_deref(), Some("Zero and 07/100"));
        assert_eq!(
            amount_in_words(2_000_000.0).as_deref(),
            Some("Two million and 00/100")
        );
        assert_eq!(courtesy_amount(1234.56).as_deref(), Some("$**1,234.56"));
        assert_eq!(courtesy_amount(80.0).as_deref(), Some("$**80.00"));
        assert!(amount_in_words(-1.0).is_none());
    }

    #[test]
    fn micr_lines() {
        let input = MicrInput {
            routing_number: "021000021",
            account_number: "0001 2345-6789",
            check_number: "1001",
            personal: false,
            check_number_width: 6,
        };
        assert_eq!(
            build_micr_line(&input).expect("line"),
            "\u{2448}001001\u{2448} \u{2446}021000021\u{2446} 00012345\u{2449}6789\u{2448}"
        );
        let fields = build_micr_fields(&input).expect("fields").as_font_letters();
        assert_eq!(fields.on_us, "00012345D6789C");
        assert_eq!(
            fractional_routing("021000021", Some("90-7162")).expect("ok").as_deref(),
            Some("90-7162/0210")
        );
    }

    #[test]
    fn layouts() {
        let layout = get_check_layout("three_per_page", CheckAlignment::default()).expect("layout");
        assert_eq!(layout["faces"].as_array().map(Vec::len), Some(3));
        let shifted = get_check_layout(
            "voucher_top",
            CheckAlignment {
                dy: 4.0,
                ..CheckAlignment::default()
            },
        )
        .expect("layout");
        assert_eq!(shifted["faces"][0]["fields"]["payer"]["y"], json!(38));
        assert_eq!(shifted["faces"][0]["fields"]["micrTransit"]["x"], json!(202.5));
        assert!(get_check_layout("nope", CheckAlignment::default()).is_none());
    }
}
