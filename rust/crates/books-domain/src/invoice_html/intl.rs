//! `Intl.NumberFormat` (money, plain numbers) and `Intl.DateTimeFormat`
//! (long dates) as the printed invoice uses them, for the locales an entity
//! can have. The shapes per locale (pattern, symbol, separators, grouping,
//! month names) are Node's ICU output, exported into `data/invoice.json`
//! (`tools/invoice-export.mts`); the digits are ICU's: the shortest decimal
//! of the double, rounded half away from zero.

use serde_json::Value;

use crate::compliance::INVOICE_DATA;

/// The shapes of a locale: an exact tag, else its language, else `en-US`
/// (Intl's best-fit fallback for the tags WeldBooks sees).
fn shapes(locale: &str) -> &'static Value {
    let intl = &INVOICE_DATA["intl"];
    let by_tag = |tag: &str| {
        intl.as_object().and_then(|all| {
            all.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(tag))
                .map(|(_, value)| value)
        })
    };
    if let Some(found) = by_tag(locale) {
        return found;
    }
    let language = locale.split(['-', '_']).next().unwrap_or_default();
    by_tag(language).unwrap_or(&intl["en-US"])
}

/// The decimal digits of `value` (its shortest round-trip form), rounded to
/// `max_fraction` digits half away from zero, then trailing zeros dropped
/// down to `min_fraction`.
fn digits(value: f64, min_fraction: usize, max_fraction: usize) -> (String, String) {
    let text = format!("{}", value.abs());
    let (int, frac) = text.split_once('.').unwrap_or((text.as_str(), ""));
    let mut int: Vec<u8> = int.bytes().collect();
    let mut frac: Vec<u8> = frac.bytes().collect();
    if frac.len() > max_fraction {
        let round_up = frac[max_fraction] >= b'5';
        frac.truncate(max_fraction);
        if round_up {
            let mut carry = true;
            for digit in frac.iter_mut().rev() {
                if *digit == b'9' {
                    *digit = b'0';
                } else {
                    *digit += 1;
                    carry = false;
                    break;
                }
            }
            if carry {
                for digit in int.iter_mut().rev() {
                    if *digit == b'9' {
                        *digit = b'0';
                    } else {
                        *digit += 1;
                        carry = false;
                        break;
                    }
                }
                if carry {
                    int.insert(0, b'1');
                }
            }
        }
    }
    while frac.len() > min_fraction && frac.last() == Some(&b'0') {
        frac.pop();
    }
    while frac.len() < min_fraction {
        frac.push(b'0');
    }
    (
        String::from_utf8_lossy(&int).into_owned(),
        String::from_utf8_lossy(&frac).into_owned(),
    )
}

fn usize_of(value: &Value, fallback: usize) -> usize {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(fallback)
}

/// The integer digits with the locale's grouping.
fn grouped(int: &str, shape: &Value, number: &Value) -> String {
    let group = shape["group"].as_str().unwrap_or(",");
    let min_grouping = usize_of(&shape["minGrouping"], 1);
    let primary = usize_of(&number["primary"], 3).max(1);
    let secondary = usize_of(&number["secondary"], 3).max(1);
    if int.len() < primary + min_grouping {
        return int.to_owned();
    }
    let mut parts: Vec<&str> = Vec::new();
    let (head, last) = int.split_at(int.len() - primary);
    let mut rest = head;
    while rest.len() > secondary {
        let (left, right) = rest.split_at(rest.len() - secondary);
        parts.push(right);
        rest = left;
    }
    if !rest.is_empty() {
        parts.push(rest);
    }
    parts.reverse();
    parts.push(last);
    parts.join(group)
}

/// Fills a template (`["-", "€", "#"]`) with the formatted number.
fn fill(template: &Value, number: &str) -> String {
    template.as_array().map_or_else(
        || number.to_owned(),
        |parts| {
            parts
                .iter()
                .map(|p| match p.as_str() {
                    Some("#") => number,
                    Some(text) => text,
                    None => "",
                })
                .collect()
        },
    )
}

fn negative(value: f64) -> bool {
    value < 0.0 || (value == 0.0 && value.is_sign_negative())
}

/// `new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)`.
pub fn format_currency(locale: &str, currency: &str, value: f64) -> String {
    let shapes = shapes(locale);
    let currency = currency.to_uppercase();
    let shape = shapes["currency"]
        .get(currency.as_str())
        .cloned()
        .unwrap_or_else(|| {
            // An ISO code without an export: the code where CHF stands.
            let chf = shapes["currency"]["CHF"].clone();
            let replaced: Vec<Value> = chf
                .get("positive")
                .and_then(Value::as_array)
                .map(|p| {
                    p.iter()
                        .map(|v| {
                            if v == "CHF" {
                                Value::String(currency.clone())
                            } else {
                                v.clone()
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let replaced_negative: Vec<Value> = chf
                .get("negative")
                .and_then(Value::as_array)
                .map(|p| {
                    p.iter()
                        .map(|v| {
                            if v == "CHF" {
                                Value::String(currency.clone())
                            } else {
                                v.clone()
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut shape = chf;
            shape["positive"] = Value::Array(replaced);
            shape["negative"] = Value::Array(replaced_negative);
            shape
        });
    let fraction = usize_of(&shape["digits"], 2);
    let (int, frac) = digits(value, fraction, fraction);
    let mut text = grouped(&int, &shape, &shapes["number"]);
    if !frac.is_empty() {
        text.push_str(shape["decimal"].as_str().unwrap_or("."));
        text.push_str(&frac);
    }
    let template = if negative(value) {
        &shape["negative"]
    } else {
        &shape["positive"]
    };
    fill(template, &text)
}

/// `new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)`.
pub fn format_number(locale: &str, value: f64) -> String {
    let number = &shapes(locale)["number"];
    let (int, frac) = digits(value, 0, 4);
    let mut text = grouped(&int, number, number);
    if !frac.is_empty() {
        text.push_str(number["decimal"].as_str().unwrap_or("."));
        text.push_str(&frac);
    }
    let template = if negative(value) {
        &number["negative"]
    } else {
        &number["positive"]
    };
    fill(template, &text)
}

/// `new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year:
/// 'numeric' }).format(date)` of a UTC instant (milliseconds).
pub fn format_long_date(locale: &str, millis: i64) -> String {
    let date = &shapes(locale)["date"];
    let days = millis.div_euclid(86_400_000);
    let (year, month, day) = crate::js::civil_from_days(days);
    let month_name = usize::try_from(month - 1)
        .ok()
        .and_then(|m| date["months"].get(m))
        .and_then(Value::as_str)
        .unwrap_or_default();
    date["pattern"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|p| match p.as_str() {
                    Some("{day}") => day.to_string(),
                    Some("{month}") => month_name.to_owned(),
                    Some("{year}") => year.to_string(),
                    Some(text) => text.to_owned(),
                    None => String::new(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's own output for every exported locale (`data/intl-cases.json`).
    #[test]
    fn matches_node() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../data/intl-cases.json")).expect("cases");
        let mut failures = Vec::new();
        for case in &cases {
            let locale = case["locale"].as_str().expect("locale");
            let out = case["out"].as_str().expect("out");
            let got = if let Some(date) = case["date"].as_str() {
                format_long_date(locale, crate::js::millis_of(date).expect("date"))
            } else {
                let mut value = case["value"].as_f64().expect("value");
                // JSON has no -0: the case printed with a sign is -0.
                if value == 0.0 && (out.contains('-') || out.contains('\u{2212}')) {
                    value = -0.0;
                }
                match case["currency"].as_str() {
                    Some(currency) => format_currency(locale, currency, value),
                    None => format_number(locale, value),
                }
            };
            if got != out {
                failures.push(format!("{case}: got {got:?}"));
            }
        }
        assert!(
            failures.is_empty(),
            "{} mismatches:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}
