//! Brazil (`jurisdictions/br` and books-api's `br-entity-setup`): CNPJ, CPF
//! and Inscrição Estadual checks, legal forms and regimes, states, CEP, Pix
//! keys, and the entity settings (`jurisdictionSettings`) a Brazilian entity
//! is created or patched with.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

use super::{DATA, TaxIdValidation, js_trim, strip};

fn strings(value: &'static Value) -> Vec<&'static str> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// `BR_TAX_REGIMES`.
pub fn tax_regimes() -> Vec<&'static str> {
    strings(&DATA["br"]["regimes"])
}

/// `BR_ENTITY_TYPES`.
pub fn entity_types() -> Vec<&'static str> {
    strings(&DATA["br"]["entityTypes"])
}

/// `isBrTaxRegime(value)`.
pub fn is_tax_regime(value: &str) -> bool {
    tax_regimes().contains(&value)
}

/// `isBrEntityType(value)`.
pub fn is_entity_type(value: &str) -> bool {
    entity_types().contains(&value)
}

/// `brRegimeOf(classification)`: the regime, Simples Nacional by default.
pub fn regime_of(classification: Option<&str>) -> &str {
    match classification {
        Some(c) if is_tax_regime(c) => c,
        _ => "simples_nacional",
    }
}

/// `allowedBrRegimes(entityType)`.
pub fn allowed_regimes(entity_type: Option<&str>) -> Vec<&'static str> {
    match entity_type {
        Some("mei") => vec!["mei"],
        Some("sa") => vec!["lucro_presumido", "lucro_real"],
        _ => vec!["simples_nacional", "lucro_presumido", "lucro_real"],
    }
}

// ── identifiers ─────────────────────────────────────────────────────────────

fn mod11_digit(values: &[i64], weights: &[i64]) -> i64 {
    let sum: i64 = values.iter().zip(weights).map(|(v, w)| v * w).sum();
    let remainder = sum.rem_euclid(11);
    if remainder < 2 { 0 } else { 11 - remainder }
}

/// `cnpjCheckDigits(first12)`: alphanumeric CNPJs count each character's
/// code minus 48.
pub fn cnpj_check_digits(first12: &str) -> String {
    let values: Vec<i64> = first12
        .chars()
        .map(|c| i64::from(u32::from(c)) - 48)
        .collect();
    let d1 = mod11_digit(&values, &[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    let mut with_first = values;
    with_first.push(d1);
    let d2 = mod11_digit(&with_first, &[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    format!("{d1}{d2}")
}

fn all_same(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| chars.all(|c| c == first))
}

/// `validateCnpj(value)`.
pub fn validate_cnpj(value: &str) -> TaxIdValidation {
    let normalized = strip(value, &['.', '/', '-']).to_uppercase();
    let b = normalized.as_bytes();
    let shaped = b.len() == 14
        && b[..12]
            .iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
        && b[12..].iter().all(u8::is_ascii_digit);
    if !shaped {
        return TaxIdValidation::fail("CNPJ must have 14 characters (e.g. 11.222.333/0001-81)");
    }
    if all_same(&normalized) {
        return TaxIdValidation::fail("CNPJ is not valid");
    }
    if cnpj_check_digits(&normalized[..12]) != normalized[12..] {
        return TaxIdValidation::fail("CNPJ check digits are wrong: check the number for a typo");
    }
    TaxIdValidation::ok(format!(
        "{}.{}.{}/{}-{}",
        &normalized[..2],
        &normalized[2..5],
        &normalized[5..8],
        &normalized[8..12],
        &normalized[12..]
    ))
}

/// `cpfCheckDigits(first9)`.
pub fn cpf_check_digits(first9: &str) -> String {
    let values: Vec<i64> = first9
        .chars()
        .map(|c| i64::from(c.to_digit(10).unwrap_or(0)))
        .collect();
    let dv = |digits: &[i64], start: i64| {
        let sum: i64 = (0_i64..).zip(digits).map(|(i, d)| d * (start - i)).sum();
        let remainder = (sum * 10).rem_euclid(11);
        if remainder == 10 { 0 } else { remainder }
    };
    let d1 = dv(&values, 10);
    let mut with_first = values;
    with_first.push(d1);
    let d2 = dv(&with_first, 11);
    format!("{d1}{d2}")
}

/// `validateCpf(value)`.
pub fn validate_cpf(value: &str) -> TaxIdValidation {
    let normalized = strip(value, &['.', '-']);
    if normalized.len() != 11 || !normalized.bytes().all(|b| b.is_ascii_digit()) {
        return TaxIdValidation::fail("CPF must have 11 digits (e.g. 529.982.247-25)");
    }
    if all_same(&normalized) {
        return TaxIdValidation::fail("CPF is not valid");
    }
    if cpf_check_digits(&normalized[..9]) != normalized[9..] {
        return TaxIdValidation::fail("CPF check digits are wrong: check the number for a typo");
    }
    TaxIdValidation::ok(format!(
        "{}.{}.{}-{}",
        &normalized[..3],
        &normalized[3..6],
        &normalized[6..9],
        &normalized[9..]
    ))
}

/// `validateCnpjOrCpf(value)`: a CPF when it is 11 digits, else a CNPJ.
pub fn validate_cnpj_or_cpf(value: &str) -> TaxIdValidation {
    let compact = strip(value, &['.', '/', '-']).to_uppercase();
    if compact.len() == 11 && compact.bytes().all(|b| b.is_ascii_digit()) {
        return validate_cpf(&compact);
    }
    validate_cnpj(&compact)
}

/// `validateInscricaoEstadual(value)`: 2 to 14 digits, or `ISENTO`.
pub fn validate_inscricao_estadual(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value).to_uppercase();
    if trimmed == "ISENTO" {
        return TaxIdValidation::ok("ISENTO");
    }
    let digits = strip(&trimmed, &['.', '/', '-']);
    if !(2..=14).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return TaxIdValidation::fail("Inscrição Estadual must be 2 to 14 digits, or ISENTO");
    }
    TaxIdValidation::ok(digits)
}

/// `normalizeCep(value)`: `00000-000`, or `None` without 8 digits.
pub fn normalize_cep(value: &str) -> Option<String> {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 8).then(|| format!("{}-{}", &digits[..5], &digits[5..]))
}

// ── states, time zones ──────────────────────────────────────────────────────

/// A state: `uf`, `name`, `ibge`, `timezone`.
pub fn states() -> &'static [Value] {
    DATA["br"]["states"].as_array().map_or(&[], Vec::as_slice)
}

/// `plainName`: accents dropped, trimmed, lower case.
fn plain_name(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    js_trim(
        &value
            .nfd()
            .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
            .collect::<String>(),
    )
    .to_lowercase()
}

/// `brState(code)`: by UF, IBGE code or name (accents optional).
pub fn state(code: &str) -> Option<&'static Value> {
    if code.is_empty() {
        return None;
    }
    let trimmed = js_trim(code).to_uppercase();
    states()
        .iter()
        .find(|s| s["uf"].as_str() == Some(trimmed.as_str()))
        .or_else(|| {
            states()
                .iter()
                .find(|s| s["ibge"].as_str() == Some(trimmed.as_str()))
        })
        .or_else(|| {
            let plain = plain_name(code);
            states()
                .iter()
                .find(|s| s["name"].as_str().map(plain_name).as_deref() == Some(plain.as_str()))
        })
}

/// `timezoneOfUf(uf)`.
pub fn timezone_of_uf(uf: Option<&str>) -> String {
    uf.filter(|u| !u.is_empty())
        .and_then(|uf| {
            let upper = uf.to_uppercase();
            states()
                .iter()
                .find(|s| s["uf"].as_str() == Some(upper.as_str()))
                .and_then(|s| s["timezone"].as_str())
        })
        .unwrap_or("America/Sao_Paulo")
        .to_owned()
}

/// `isPlausiblePixKey(key)`: a CPF/CNPJ, a +55 phone number, an e-mail or a
/// random key.
pub fn is_plausible_pix_key(key: &str) -> bool {
    let k = js_trim(key);
    let b = k.as_bytes();
    let cpf = b.len() == 11 && b.iter().all(u8::is_ascii_digit);
    let cnpj = b.len() == 14
        && b[..12]
            .iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
        && b[12..].iter().all(u8::is_ascii_digit);
    if cpf || cnpj {
        return true;
    }
    if let Some(rest) = k.strip_prefix("+55")
        && (10..=11).contains(&rest.len())
        && rest.bytes().all(|c| c.is_ascii_digit())
    {
        return true;
    }
    if is_plausible_email(k) && k.chars().map(char::len_utf16).sum::<usize>() <= 77 {
        return true;
    }
    let lower = k.to_lowercase();
    let parts: Vec<&str> = lower.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(len, part)| part.len() == *len && part.bytes().all(|c| c.is_ascii_hexdigit()))
}

fn is_plausible_email(k: &str) -> bool {
    let parts: Vec<&str> = k.split('@').collect();
    let [local, domain] = parts.as_slice() else {
        return false;
    };
    if local.is_empty()
        || domain.is_empty()
        || local.chars().any(super::is_js_space)
        || domain.chars().any(super::is_js_space)
    {
        return false;
    }
    let inner: Vec<char> = domain.chars().collect();
    inner.len() > 2 && inner[1..inner.len() - 1].contains(&'.')
}

/// `brProfileOf(metadata)`: the tax profile a seeded rate carries.
pub fn profile_of(metadata: Option<&Value>) -> Option<&Value> {
    let br = metadata?.get("br")?;
    (br.get("profile").is_some_and(Value::is_string)
        && br.get("kind").is_some_and(Value::is_string))
    .then_some(br)
}

// ── entity settings ─────────────────────────────────────────────────────────

/// Why an entity can't be set up (`EntitySetupError`'s message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupError(pub String);

impl From<SetupError> for crate::http::Refusal {
    fn from(error: SetupError) -> Self {
        Self::bad_request(error.0)
    }
}

fn trimmed_pattern(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
    matches: impl Fn(&str) -> bool,
    message: &str,
) {
    match issues.text_with(body, key, Presence::Optional, Text::trimmed(None, None)) {
        Field::Set(text) if matches(&text) => {
            out.insert(key.to_owned(), json!(text));
        }
        Field::Set(_) => issues.issue_at(
            key,
            json!({ "validation": "regex", "code": "invalid_string", "message": message }),
        ),
        _ => {}
    }
}

fn digits_only(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_digit())
}

/// `brSettingsSchema.safeParse(present)`: the parsed settings (passthrough,
/// trimmed), or the first issue as `path: message`.
fn parse_settings(present: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut out = present.clone();
    let mut issues = Issues::default();
    let text = |issues: &mut Issues, out: &mut Map<String, Value>, key: &str, rules: Text| {
        if let Field::Set(value) = issues.text_with(present, key, Presence::Optional, rules) {
            out.insert(key.to_owned(), json!(value));
        }
    };
    let percent = |max: f64| Number {
        min: Some(0.0),
        max: Some(max),
        ..Number::default()
    };
    if let Field::Set(uf) =
        issues.text_with(present, "uf", Presence::Optional, Text::trimmed(None, None))
    {
        issues.string_length("uf", 2, uf.encode_utf16().count());
        out.insert("uf".to_owned(), json!(uf));
    }
    if present.contains_key("municipalityCode") {
        issues.pattern(
            present,
            "municipalityCode",
            Presence::Optional,
            None,
            None,
            |v| digits_only(v, 7),
            "The IBGE municipality code has 7 digits",
        );
    }
    text(
        &mut issues,
        &mut out,
        "municipalityName",
        Text::trimmed(None, Some(100)),
    );
    text(
        &mut issues,
        &mut out,
        "inscricaoMunicipal",
        Text::trimmed(None, Some(20)),
    );
    trimmed_pattern(
        &mut issues,
        present,
        "cnae",
        &mut out,
        |v| {
            let b = v.as_bytes();
            digits_only(v, 7)
                || (b.len() == 9
                    && digits_only(&v[..4], 4)
                    && b[4] == b'-'
                    && b[5].is_ascii_digit()
                    && b[6] == b'/'
                    && digits_only(&v[7..], 2))
        },
        "CNAE is 7 digits (e.g. 6201501)",
    );
    issues.number(
        present,
        "issRate",
        Presence::Optional,
        Number {
            min: Some(2.0),
            max: Some(5.0),
            ..Number::default()
        },
    );
    issues.choice(
        present,
        "simplesAnexo",
        Presence::Optional,
        &["I", "II", "III", "IV", "V"],
    );
    issues.boolean(present, "icmsContributor", Presence::Optional);
    issues.number(present, "cbsRate", Presence::Optional, percent(30.0));
    issues.number(present, "ibsRate", Presence::Optional, percent(30.0));
    text(
        &mut issues,
        &mut out,
        "pixKey",
        Text::trimmed(None, Some(77)),
    );
    text(
        &mut issues,
        &mut out,
        "pixCity",
        Text::trimmed(None, Some(15)),
    );
    if let Some(provider) = present.get("fiscalProvider")
        && provider != "focus_nfe"
    {
        issues.issue_at(
            "fiscalProvider",
            json!({ "received": provider, "code": "invalid_literal", "expected": "focus_nfe", "message": "Invalid literal value, expected \"focus_nfe\"" }),
        );
    }
    issues.choice(
        present,
        "fiscalEnvironment",
        Presence::Optional,
        &["homologacao", "producao"],
    );
    issues.choice(
        present,
        "nfseStandard",
        Presence::Optional,
        &["nacional", "municipal"],
    );
    if present.contains_key("nfeSeries") {
        issues.pattern(
            present,
            "nfeSeries",
            Presence::Optional,
            None,
            None,
            |v| (1..=3).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()),
            "Invalid",
        );
    }
    issues.number(
        present,
        "payroll12m",
        Presence::Optional,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    match issues.finish() {
        Ok(()) => Ok(out),
        Err(invalid) => {
            let first = invalid.issues().first().cloned().unwrap_or(Value::Null);
            let path: Vec<String> = first["path"]
                .as_array()
                .map(|p| {
                    p.iter()
                        .map(|seg| match seg {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Err(format!(
                "jurisdictionSettings.{}: {}",
                path.join("."),
                first["message"].as_str().unwrap_or_default()
            ))
        }
    }
}

/// `normalizeBrSettings(settings, address)`: the settings checked (null and
/// blank values dropped) against the address, with the UF, Pix city and the
/// time zone of the state.
pub fn normalize_settings(
    settings: Option<&Map<String, Value>>,
    address: Option<&Value>,
) -> Result<(Map<String, Value>, String), SetupError> {
    let present: Map<String, Value> = settings
        .map(|s| {
            s.iter()
                .filter(|(_, v)| !v.is_null() && v.as_str() != Some(""))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut next = parse_settings(&present).map_err(SetupError)?;
    let uf = next.get("uf").and_then(Value::as_str).map(str::to_owned);
    let lookup = uf
        .clone()
        .filter(|u| !u.is_empty())
        .or_else(|| address.and_then(|a| a["state"].as_str()).map(str::to_owned));
    let found = lookup.as_deref().and_then(state);
    if let Some(uf) = uf.as_deref().filter(|u| !u.is_empty())
        && found.is_none()
    {
        return Err(SetupError(format!("'{uf}' is not a Brazilian state (UF)")));
    }
    if let Some(found) = found {
        next.insert("uf".to_owned(), found["uf"].clone());
        if let Some(code) = next
            .get("municipalityCode")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            && code.get(..2) != found["ibge"].as_str()
        {
            return Err(SetupError(format!(
                "Municipality {code} is not in {}",
                found["uf"].as_str().unwrap_or_default()
            )));
        }
    }
    if let Some(key) = next
        .get("pixKey")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        && !is_plausible_pix_key(key)
    {
        return Err(SetupError(
            "The Pix key must be a CPF/CNPJ (digits only), an e-mail, a +55 phone number or a random key".to_owned(),
        ));
    }
    let has_city = next
        .get("pixCity")
        .is_some_and(|c| crate::js::truthy(Some(c)));
    if !has_city
        && let Some(city) = address
            .and_then(|a| a["city"].as_str())
            .filter(|c| !c.is_empty())
    {
        next.insert(
            "pixCity".to_owned(),
            json!(crate::js::slice_utf16(city, 15)),
        );
    }
    let timezone = timezone_of_uf(next.get("uf").and_then(Value::as_str));
    Ok((next, timezone))
}

/// `normalizeBrAddress(address)`: the CEP as `00000-000`.
pub fn normalize_address(address: Option<Value>) -> Result<Option<Value>, SetupError> {
    let Some(mut address) = address else {
        return Ok(None);
    };
    let Some(postal) = address["postalCode"].as_str().filter(|p| !p.is_empty()) else {
        return Ok(Some(address));
    };
    let cep = normalize_cep(postal)
        .ok_or_else(|| SetupError("The CEP must have 8 digits (00000-000)".to_owned()))?;
    address["postalCode"] = json!(cep);
    Ok(Some(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers() {
        assert!(validate_cnpj("11.222.333/0001-81").valid);
        assert!(!validate_cnpj("11.222.333/0001-82").valid);
        assert!(validate_cpf("529.982.247-25").valid);
        assert_eq!(normalize_cep("01310100").as_deref(), Some("01310-100"));
        assert!(is_plausible_pix_key("someone@example.com"));
    }
}
