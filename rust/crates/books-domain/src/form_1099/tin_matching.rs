//! IRS TIN Matching (`us-compliance/tin-matching`): the bulk upload files
//! (`type;TIN;name;account`, at most 100,000 records each) and the IRS answer
//! file, with each record's result code.

use unicode_normalization::UnicodeNormalization;

/// `TinMatchRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub party_id: String,
    /// `ein`, `ssn`, `itin` or `unknown`.
    pub tin_type: String,
    pub tin: String,
    pub name: String,
}

/// `TinMatchFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub filename: String,
    pub content: String,
    pub record_count: usize,
}

/// `TinMatchBuildResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub files: Vec<File>,
    /// `(partyId, reason)`.
    pub skipped: Vec<(String, &'static str)>,
}

const MAX_RECORDS: usize = 100_000;

/// `sanitizeTinMatchName(name)`.
pub fn sanitize_name(name: &str) -> String {
    let decomposed: String = name.nfd().collect();
    let kept: String = decomposed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '&' | '-'))
        .collect();
    let collapsed = kept
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    collapsed
        .chars()
        .take(40)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `tinMatchAccountNumber(partyId)`: the id's letters and digits, at most
/// the last 20.
pub fn account_number(party_id: &str) -> String {
    let alnum: Vec<char> = party_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let start = alnum.len().saturating_sub(20);
    alnum[start..].iter().collect()
}

/// `buildTinMatchingFiles(records)` (ITINs left out).
pub fn build_files(records: &[Record]) -> Built {
    let mut skipped = Vec::new();
    let mut owners: Vec<(String, String)> = Vec::new();
    let mut lines = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for record in records {
        if record.tin_type == "itin" {
            skipped.push((record.party_id.clone(), "itin_not_supported"));
            continue;
        }
        let digits: String = record
            .tin
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        if digits.len() != 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            skipped.push((record.party_id.clone(), "invalid_tin"));
            continue;
        }
        let name = sanitize_name(&record.name);
        if name.is_empty() {
            skipped.push((record.party_id.clone(), "missing_name"));
            continue;
        }
        let kind = match record.tin_type.as_str() {
            "ein" => "1",
            "ssn" => "2",
            _ => "3",
        };
        let key = format!("{kind};{digits};{}", name.to_uppercase());
        if seen.contains(&key) {
            skipped.push((record.party_id.clone(), "duplicate"));
            continue;
        }
        let account = account_number(&record.party_id);
        if owners
            .iter()
            .any(|(a, owner)| *a == account && *owner != record.party_id)
        {
            skipped.push((record.party_id.clone(), "account_collision"));
            continue;
        }
        seen.push(key);
        owners.push((account.clone(), record.party_id.clone()));
        lines.push(format!("{kind};{digits};{name};{account}"));
    }
    let files = lines
        .chunks(MAX_RECORDS)
        .enumerate()
        .map(|(index, chunk)| File {
            filename: format!("tin-matching-{:03}.txt", index + 1),
            content: format!("{}\r\n", chunk.join("\r\n")),
            record_count: chunk.len(),
        })
        .collect();
    Built { files, skipped }
}

/// `TinMatchResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchResult {
    pub party_id: Option<String>,
    pub account_number: String,
    /// `match`, `mismatch`, `not_issued`, `invalid` or `duplicate`.
    pub status: &'static str,
    pub code: u8,
    pub tin_last4: Option<String>,
    pub line: usize,
}

/// `parseTinMatchingResults(text, { accountToParty })`: the results, and the
/// lines that could not be read (`(line, text)`).
pub fn parse_results(
    text: &str,
    account_to_party: impl Fn(&str) -> Option<String>,
) -> (Vec<MatchResult>, Vec<(usize, String)>) {
    let mut results = Vec::new();
    let mut unreadable = Vec::new();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    for (index, raw) in normalized.split('\n').enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let delimiter = if line.contains(';') { ';' } else { ',' };
        let fields: Vec<&str> = line.split(delimiter).map(str::trim).collect();
        let last = fields.last().copied().unwrap_or_default();
        let code = (last.len() == 1 && ('0'..='8').contains(&last.chars().next().unwrap_or('x')))
            .then(|| last.as_bytes()[0] - b'0');
        let kind = fields.first().copied().unwrap_or_default();
        let Some(code) = code.filter(|_| fields.len() >= 3 && matches!(kind, "1" | "2" | "3"))
        else {
            unreadable.push((index + 1, line.to_owned()));
            continue;
        };
        let tin: String = fields
            .get(1)
            .copied()
            .unwrap_or_default()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        let account = if fields.len() >= 5 {
            fields[3].to_owned()
        } else {
            String::new()
        };
        let status = match code {
            0 | 6..=8 => "match",
            1 | 4 => "invalid",
            2 => "not_issued",
            3 => "mismatch",
            _ => "duplicate",
        };
        results.push(MatchResult {
            party_id: (!account.is_empty())
                .then(|| account_to_party(&account).unwrap_or_else(|| account.clone())),
            account_number: account,
            status,
            code,
            tin_last4: (tin.len() >= 4).then(|| tin[tin.len() - 4..].to_owned()),
            line: index + 1,
        });
    }
    (results, unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_and_results() {
        let built = build_files(&[
            Record {
                party_id: "pty_a1".into(),
                tin_type: "ein".into(),
                tin: "12-3456789".into(),
                name: "Acmé, Inc.".into(),
            },
            Record {
                party_id: "pty_b".into(),
                tin_type: "itin".into(),
                tin: "912345678".into(),
                name: "X".into(),
            },
        ]);
        assert_eq!(built.files[0].content, "1;123456789;Acme Inc;ptya1\r\n");
        assert_eq!(
            built.skipped,
            vec![("pty_b".to_owned(), "itin_not_supported")]
        );
        let (results, unreadable) = parse_results("1;123456789;Acme Inc;ptya1;3\nnonsense", |a| {
            (a == "ptya1").then(|| "pty_a1".to_owned())
        });
        assert_eq!(results[0].status, "mismatch");
        assert_eq!(results[0].party_id.as_deref(), Some("pty_a1"));
        assert_eq!(unreadable, vec![(2, "nonsense".to_owned())]);
    }
}
