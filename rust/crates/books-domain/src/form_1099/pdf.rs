//! Layout data of the recipient and payer copies of 1099-NEC / 1099-MISC
//! (`us-compliance/form-1099-pdf-data`): fields with their positions on a
//! US Letter page (points, top-left origin) and the text blocks. The
//! recipient TIN is always the last four digits.

use serde_json::{Map, Value, json};

use super::{form_1099_box, grouped_money};

/// `FORM_1099_COPIES`.
pub const COPIES: [&str; 4] = ["B", "1", "2", "C"];

/// `Form1099PdfAddress`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Address {
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: Option<String>,
}

/// `Form1099PdfInput`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Input {
    pub form: String,
    pub tax_year: i64,
    pub payer_name: String,
    pub payer_name_line2: Option<String>,
    pub payer_address: Address,
    pub payer_phone: Option<String>,
    pub payer_tin_type: String,
    pub payer_tin: String,
    pub recipient_name: String,
    pub recipient_business_name: Option<String>,
    pub recipient_address: Address,
    pub recipient_tin_type: String,
    pub recipient_tin_last4: String,
    pub recipient_account_number: Option<String>,
    pub boxes: Vec<(String, f64)>,
    pub corrected: bool,
    pub states: Vec<super::iris::StateEntry>,
    pub copies: Option<Vec<String>>,
}

/// `maskTin(tinType, last4)` of the copies.
pub fn mask_tin(tin_type: &str, last4: &str) -> String {
    let digits: String = last4.chars().filter(char::is_ascii_digit).collect();
    let tail: String = digits
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let tail = format!("{tail:*>4}");
    if tin_type == "ein" {
        format!("**-***{tail}")
    } else {
        format!("***-**-{tail}")
    }
}

/// `formatTin(tinType, tin)`.
pub fn format_tin(tin_type: &str, tin: &str) -> String {
    let d: String = tin.chars().filter(char::is_ascii_digit).collect();
    if d.len() != 9 {
        return d;
    }
    if tin_type == "ein" {
        format!("{}-{}", &d[..2], &d[2..])
    } else {
        format!("{}-{}-{}", &d[..3], &d[3..5], &d[5..])
    }
}

/// `formatMoney(value)`: empty for nothing or zero.
pub fn format_money(value: Option<f64>) -> String {
    match value.filter(|v| v.is_finite()) {
        Some(v) if super::compute::to_cents(v) != 0 => {
            grouped_money(crate::js::math_round(v * 100.0) / 100.0)
        }
        _ => String::new(),
    }
}

fn street_of(address: &Address) -> Vec<String> {
    [Some(address.line1.as_str()), address.line2.as_deref()]
        .into_iter()
        .map(|l| l.unwrap_or_default().trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect()
}

fn place_of(address: &Address) -> String {
    let state_zip = [address.state.as_str(), address.zip.as_str()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let place = [address.city.trim(), state_zip.trim()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let country = address
        .country
        .as_deref()
        .filter(|c| !c.is_empty() && c.to_uppercase() != "US")
        .map(str::trim)
        .unwrap_or_default();
    [place.as_str(), country]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

const LEGEND_B: &str = "This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.";

fn copy_info(copy: &str) -> (&'static str, &'static str) {
    match copy {
        "B" => ("Copy B - For Recipient", LEGEND_B),
        "1" => (
            "Copy 1 - For State Tax Department",
            "For State Tax Department.",
        ),
        "2" => (
            "Copy 2 - To be filed with recipient's state income tax return, when required",
            "To be filed with recipient's state income tax return, when required.",
        ),
        _ => (
            "Copy C - For Payer",
            "For payer's records. For Privacy Act and Paperwork Reduction Act Notice, see the current General Instructions for Certain Information Returns.",
        ),
    }
}

const TIN_INSTRUCTION: &str = "Recipient's taxpayer identification number (TIN). For your protection, this form may show only the last four digits of your TIN (SSN, ITIN, ATIN or EIN). The payer has reported your complete TIN to the IRS.";
const ACCOUNT_INSTRUCTION: &str = "Account number. May show an account or other unique number the payer assigned to distinguish your account.";
const CORRECTED_INSTRUCTION: &str = "If this form is marked \"CORRECTED\", it replaces a form you received earlier. Use this one for your return.";
const STATE_INSTRUCTION: &str = "State information. Shows the state income and any state income tax withheld, reportable to your state tax department.";

const NEC_INSTRUCTIONS: [&str; 9] = [
    "Instructions for Recipient",
    TIN_INSTRUCTION,
    ACCOUNT_INSTRUCTION,
    "Box 1. Shows nonemployee compensation. If you are in the trade or business of catching fish, box 1 may show cash you received for the sale of fish. If the payments in box 1 are subject to self-employment tax, report them on Schedule C or Schedule F (Form 1040) and figure the tax on Schedule SE (Form 1040). You received this form instead of Form W-2 because the payer did not treat you as an employee and did not withhold income tax or social security and Medicare tax.",
    "Box 2. If checked, consumer products totaling $5,000 or more were sold to you for resale, on a buy-sell, deposit-commission or other basis. Any income from your sale of these products is reported on your return as business income.",
    "Box 3. Shows excess golden parachute payments subject to a 20% excise tax. Report the tax on Schedule 2 (Form 1040).",
    "Box 4. Shows backup withholding. A payer must withhold on certain payments if you did not give the payer your TIN. See Form W-9. Include this amount as tax withheld on your income tax return.",
    STATE_INSTRUCTION,
    CORRECTED_INSTRUCTION,
];

const MISC_INSTRUCTIONS: [&str; 19] = [
    "Instructions for Recipient",
    TIN_INSTRUCTION,
    ACCOUNT_INSTRUCTION,
    "Box 1. Shows rents from real estate or personal property. Report on Schedule E (Form 1040) if it is rental income, or on Schedule C or F if you are in that trade or business.",
    "Box 2. Shows royalties from oil, gas or mineral properties, copyrights and patents. Report on Schedule E (Form 1040), or on Schedule C if the royalties are from your trade or business.",
    "Box 3. Shows other income not reported elsewhere on the form. Report it on the appropriate line of your return.",
    "Box 4. Shows backup withholding or withholding on Indian gaming profits paid to tribal members. Include it as tax withheld on your return.",
    "Box 5. Shows your share of the proceeds from the sale of a catch or the fair market value of a distribution in kind from a fishing boat.",
    "Box 6. Shows payments to physicians or other suppliers of health and medical services. Report on Schedule C if it is your trade or business income.",
    "Box 7. If checked, consumer products totaling $5,000 or more were sold to you for resale. Report income from their sale on your return as business income.",
    "Box 8. Shows substitute payments in place of dividends or tax-exempt interest received by your broker on your behalf as a result of a loan of your securities.",
    "Box 9. Shows crop insurance proceeds. Report them on Schedule F (Form 1040) unless you elect to defer them to the following year.",
    "Box 10. Shows gross proceeds paid to an attorney in connection with legal services. The amount is not necessarily income to the attorney.",
    "Box 11. Shows cash paid for fish bought for resale from persons in the business of catching fish.",
    "Box 12. Shows deferrals under a nonqualified deferred compensation plan that are subject to section 409A.",
    "Box 13. If checked, you have a filing requirement under the Foreign Account Tax Compliance Act (FATCA).",
    "Box 14. Shows income under a nonqualified deferred compensation plan that does not meet the requirements of section 409A. This amount is also subject to an additional 20% tax and interest.",
    STATE_INSTRUCTION,
    CORRECTED_INSTRUCTION,
];

const LEFT: f64 = 36.0;
const LEFT_WIDTH: f64 = 300.0;
const RIGHT: f64 = 336.0;
const RIGHT_WIDTH: f64 = 240.0;
const GRID_TOP: f64 = 90.0;
const ROW: f64 = 36.0;

#[allow(clippy::too_many_arguments)]
fn field(
    id: &str,
    label: &str,
    value: &str,
    kind: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    extra: &[(&str, Value)],
) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("label".into(), json!(label));
    out.insert("value".into(), json!(value));
    out.insert("kind".into(), json!(kind));
    for (key, v) in [("x", x), ("y", y), ("width", width), ("height", height)] {
        out.insert(key.into(), crate::js::number_value(v));
    }
    out.insert(
        "align".into(),
        json!(if kind == "amount" { "right" } else { "left" }),
    );
    for (key, v) in extra {
        out.insert((*key).into(), v.clone());
    }
    Value::Object(out)
}

fn box_label(code: &str) -> String {
    form_1099_box(code).map_or_else(String::new, |d| format!("{}  {}", d.number, d.label))
}

fn amount_of(input: &Input, code: &str) -> Option<f64> {
    input.boxes.iter().find(|(c, _)| c == code).map(|(_, v)| *v)
}

fn amount_field(code: &str, input: &Input, x: f64, y: f64, width: f64, height: f64) -> Value {
    field(
        &format!("box_{code}"),
        &box_label(code),
        &format_money(amount_of(input, code)),
        "amount",
        x,
        y,
        width,
        height,
        &[("box", json!(code))],
    )
}

fn checkbox_field(code: &str, x: f64, y: f64, width: f64) -> Value {
    field(
        &format!("box_{code}"),
        &box_label(code),
        "",
        "checkbox",
        x,
        y,
        width,
        ROW,
        &[("checked", json!(false)), ("box", json!(code))],
    )
}

fn state_fields(input: &Input, codes: [&str; 3], y: f64, index: usize) -> Vec<Value> {
    let state = input.states.get(index);
    let suffix = format!("state{}", index + 1);
    let number = state.map_or_else(String::new, |s| {
        [
            s.code.to_uppercase(),
            s.payer_state_number.clone().unwrap_or_default(),
        ]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
    });
    vec![
        field(
            &format!("{suffix}_withheld"),
            &box_label(codes[0]),
            &format_money(state.and_then(|s| s.withheld)),
            "amount",
            RIGHT,
            y,
            80.0,
            ROW,
            &[("box", json!(codes[0]))],
        ),
        field(
            &format!("{suffix}_number"),
            &box_label(codes[1]),
            &number,
            "text",
            RIGHT + 80.0,
            y,
            80.0,
            ROW,
            &[("box", json!(codes[1]))],
        ),
        field(
            &format!("{suffix}_income"),
            &box_label(codes[2]),
            &format_money(state.and_then(|s| s.income)),
            "amount",
            RIGHT + 160.0,
            y,
            80.0,
            ROW,
            &[("box", json!(codes[2]))],
        ),
    ]
}

fn left_column(input: &Input) -> Vec<Value> {
    let mut payer_lines = vec![
        input.payer_name.clone(),
        input.payer_name_line2.clone().unwrap_or_default(),
    ];
    payer_lines.extend(street_of(&input.payer_address));
    payer_lines.push(place_of(&input.payer_address));
    payer_lines.push(input.payer_phone.clone().unwrap_or_default());
    let payer_lines: Vec<String> = payer_lines
        .into_iter()
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect();
    let recipient_name = [
        input.recipient_name.clone(),
        input.recipient_business_name.clone().unwrap_or_default(),
    ]
    .into_iter()
    .map(|l| l.trim().to_owned())
    .filter(|l| !l.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let multiline = [("multiline", json!(true))];
    vec![
        field(
            "payer",
            "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
            &payer_lines.join("\n"),
            "text",
            LEFT,
            GRID_TOP,
            LEFT_WIDTH,
            90.0,
            &multiline,
        ),
        field(
            "payer_tin",
            "PAYER'S TIN",
            &format_tin(&input.payer_tin_type, &input.payer_tin),
            "tin",
            LEFT,
            GRID_TOP + 90.0,
            150.0,
            ROW,
            &[],
        ),
        field(
            "recipient_tin",
            "RECIPIENT'S TIN",
            &mask_tin(&input.recipient_tin_type, &input.recipient_tin_last4),
            "tin",
            LEFT + 150.0,
            GRID_TOP + 90.0,
            150.0,
            ROW,
            &[],
        ),
        field(
            "recipient_name",
            "RECIPIENT'S name",
            &recipient_name,
            "text",
            LEFT,
            GRID_TOP + 126.0,
            LEFT_WIDTH,
            ROW,
            &multiline,
        ),
        field(
            "recipient_street",
            "Street address (including apt. no.)",
            &street_of(&input.recipient_address).join(", "),
            "text",
            LEFT,
            GRID_TOP + 162.0,
            LEFT_WIDTH,
            ROW,
            &[],
        ),
        field(
            "recipient_place",
            "City or town, state or province, country, and ZIP or foreign postal code",
            &place_of(&input.recipient_address),
            "text",
            LEFT,
            GRID_TOP + 198.0,
            LEFT_WIDTH,
            ROW,
            &[],
        ),
        field(
            "account_number",
            "Account number (see instructions)",
            input
                .recipient_account_number
                .as_deref()
                .unwrap_or_default(),
            "text",
            LEFT,
            GRID_TOP + 234.0,
            LEFT_WIDTH,
            ROW,
            &[],
        ),
    ]
}

fn header(input: &Input) -> Vec<Value> {
    vec![
        field(
            "corrected",
            "CORRECTED (if checked)",
            "",
            "checkbox",
            RIGHT,
            GRID_TOP,
            100.0,
            ROW,
            &[("checked", json!(input.corrected))],
        ),
        field(
            "tax_year",
            "For calendar year",
            &input.tax_year.to_string(),
            "text",
            RIGHT + 100.0,
            GRID_TOP,
            RIGHT_WIDTH - 100.0,
            ROW,
            &[],
        ),
    ]
}

fn nec_fields(input: &Input) -> (Vec<Value>, f64) {
    let top = GRID_TOP + ROW;
    let mut fields = header(input);
    fields.push(amount_field("nec_1", input, RIGHT, top, RIGHT_WIDTH, 54.0));
    fields.push(checkbox_field("nec_2", RIGHT, top + 54.0, RIGHT_WIDTH));
    fields.push(amount_field(
        "nec_3",
        input,
        RIGHT,
        top + 90.0,
        RIGHT_WIDTH,
        ROW,
    ));
    fields.push(amount_field(
        "nec_4",
        input,
        RIGHT,
        top + 126.0,
        RIGHT_WIDTH,
        ROW,
    ));
    fields.extend(state_fields(
        input,
        ["nec_5", "nec_6", "nec_7"],
        top + 162.0,
        0,
    ));
    fields.extend(state_fields(
        input,
        ["nec_5", "nec_6", "nec_7"],
        top + 198.0,
        1,
    ));
    (fields, GRID_TOP + 270.0)
}

const MISC_ROWS: [[&str; 2]; 7] = [
    ["misc_1", "misc_2"],
    ["misc_3", "misc_4"],
    ["misc_5", "misc_6"],
    ["misc_7", "misc_8"],
    ["misc_9", "misc_10"],
    ["misc_11", "misc_12"],
    ["misc_13", "misc_14"],
];

#[allow(clippy::cast_precision_loss)]
fn misc_fields(input: &Input) -> (Vec<Value>, f64) {
    let half = RIGHT_WIDTH / 2.0;
    let mut fields = header(input);
    for (index, row) in MISC_ROWS.iter().enumerate() {
        let y = GRID_TOP + ROW + index as f64 * ROW;
        for (column, code) in row.iter().enumerate() {
            let x = RIGHT + column as f64 * half;
            if *code == "misc_7" || *code == "misc_13" {
                fields.push(checkbox_field(code, x, y, half));
            } else {
                fields.push(amount_field(code, input, x, y, half, ROW));
            }
        }
    }
    let state_top = GRID_TOP + ROW + MISC_ROWS.len() as f64 * ROW;
    fields.extend(state_fields(
        input,
        ["misc_15", "misc_16", "misc_17"],
        state_top,
        0,
    ));
    fields.extend(state_fields(
        input,
        ["misc_15", "misc_16", "misc_17"],
        state_top + ROW,
        1,
    ));
    (fields, state_top + 2.0 * ROW)
}

/// `form1099PdfCopies(input)`.
pub fn form_1099_pdf_copies(input: &Input) -> Vec<Value> {
    let copies: Vec<String> = input
        .copies
        .clone()
        .unwrap_or_else(|| COPIES.iter().map(|c| (*c).to_owned()).collect());
    let nec = input.form == "nec";
    let (box_fields, bottom) = if nec {
        nec_fields(input)
    } else {
        misc_fields(input)
    };
    let mut fields = left_column(input);
    fields.extend(box_fields);
    let form_name = if nec { "1099-NEC" } else { "1099-MISC" };
    let instructions: &[&str] = if nec {
        &NEC_INSTRUCTIONS
    } else {
        &MISC_INSTRUCTIONS
    };
    let title = if nec {
        "Form 1099-NEC - Nonemployee Compensation"
    } else {
        "Form 1099-MISC - Miscellaneous Information"
    };
    copies
        .iter()
        .map(|copy| {
            let (label, legend) = copy_info(copy);
            let legend_y = bottom.max(GRID_TOP + 270.0) + 12.0;
            let mut blocks = vec![json!({
                "id": "legend", "x": LEFT, "y": legend_y, "width": 540, "fontSize": 8, "lineHeight": 10,
                "bold": true, "paragraphs": [legend],
            })];
            if copy == "B" {
                blocks.push(json!({
                    "id": "instructions", "x": LEFT, "y": legend_y + 36.0, "width": 540, "fontSize": 7,
                    "lineHeight": 8.5, "paragraphs": instructions, "paragraphGap": 4,
                }));
            }
            json!({
                "form": input.form,
                "copy": copy,
                "taxYear": input.tax_year,
                "page": { "width": 612, "height": 792, "unit": "pt", "origin": "top-left" },
                "title": format!("{title} ({})", input.tax_year),
                "copyLabel": label,
                "labelFontSize": 6.5,
                "valueFontSize": 10,
                "fields": fields,
                "blocks": blocks,
                "footer": format!(
                    "Form {form_name} ({})  |  {label}{}",
                    input.tax_year,
                    if copy == "B" { "  |  Keep for your records" } else { "" }
                ),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tins_and_money() {
        assert_eq!(mask_tin("ein", "6789"), "**-***6789");
        assert_eq!(mask_tin("ssn", "89"), "***-**-**89");
        assert_eq!(format_tin("ein", "123456789"), "12-3456789");
        assert_eq!(format_tin("ssn", "123456789"), "123-45-6789");
        assert_eq!(format_money(Some(1234.5)), "1,234.50");
        assert_eq!(format_money(Some(0.0)), "");
    }
}
