//! Street and house number from one address line.
//!
//! Orders keep a free-text `line1` (`Damrak 1A`, `Rue de la Loi 16 bte 3`,
//! `10 Downing Street`); PostNL and DHL want the street, the number and the
//! addition apart. Explicit `street` / `houseNumber` on the address win over
//! this; the label dialog lets a person correct what it found.

/// What [`split_street`] found. `house_number` is empty when the line has
/// none (a named house, a PO box).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StreetParts {
    pub street: String,
    pub house_number: String,
    pub suffix: Option<String>,
}

/// Countries that write the number before the street (`10 Downing Street`).
const NUMBER_FIRST: &[&str] = &["FR", "GB", "IE", "US", "CA", "AU", "NZ", "LU", "MC"];

/// Words that start an addition after the house number (`bus 3`,
/// `bte 3`, `apt 4`), not a number of their own.
const ADDITION_WORDS: &[&str] = &[
    "bus", "bte", "boite", "boîte", "box", "app", "apt", "appt", "unit", "flat", "huis", "hs",
    "etage", "et", "stiege", "tür", "top", "whg",
];

/// Split `line` (the order's address line) into street, house number and
/// addition, the way the address is written in `country`.
pub fn split_street(line: &str, country: &str) -> StreetParts {
    let cleaned: String = line
        .chars()
        .map(|c| if c == ',' { ' ' } else { c })
        .collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return StreetParts::default();
    }
    let country = country.trim().to_ascii_uppercase();
    if NUMBER_FIRST.contains(&country.as_str()) && starts_with_digit(tokens[0]) && tokens.len() > 1
    {
        let (number, suffix) = number_and_suffix(tokens[0]);
        return StreetParts {
            street: tokens[1..].join(" "),
            house_number: number,
            suffix,
        };
    }
    match number_index(&tokens) {
        Some(index) => {
            let (number, own_suffix) = number_and_suffix(tokens[index]);
            let mut suffix_parts: Vec<String> = own_suffix.into_iter().collect();
            suffix_parts.extend(tokens[index + 1..].iter().map(|t| (*t).to_owned()));
            let suffix = clean_suffix(&suffix_parts.join(" "));
            StreetParts {
                street: tokens[..index].join(" "),
                house_number: number,
                suffix,
            }
        }
        // Number first in a country that usually writes it last.
        None if starts_with_digit(tokens[0]) && tokens.len() > 1 => {
            let (number, suffix) = number_and_suffix(tokens[0]);
            StreetParts {
                street: tokens[1..].join(" "),
                house_number: number,
                suffix,
            }
        }
        None => StreetParts {
            street: tokens.join(" "),
            house_number: String::new(),
            suffix: None,
        },
    }
}

fn starts_with_digit(token: &str) -> bool {
    token.chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn is_addition_word(token: &str) -> bool {
    let lower = token.trim_end_matches('.').to_lowercase();
    ADDITION_WORDS.contains(&lower.as_str())
}

/// The house number's token: the last one after the street that starts
/// with a digit, skipping numbers that belong to an addition (`bus 3`), and
/// preferring the first of two numbers in a row (`5 3hoog`).
fn number_index(tokens: &[&str]) -> Option<usize> {
    let candidates: Vec<usize> = (1..tokens.len())
        .filter(|&i| starts_with_digit(tokens[i]))
        .collect();
    let mut chosen = None;
    for &index in candidates.iter().rev() {
        if is_addition_word(tokens[index - 1]) {
            continue;
        }
        chosen = Some(index);
        break;
    }
    let mut index = chosen?;
    // `Kerkstraat 5 3hoog`: the number is the first of the run.
    while index > 1 && starts_with_digit(tokens[index - 1]) {
        index -= 1;
    }
    Some(index)
}

/// `12A` → (`12`, `A`); `12-3` → (`12`, `3`); `7` → (`7`, none).
fn number_and_suffix(token: &str) -> (String, Option<String>) {
    let digits: String = token.chars().take_while(char::is_ascii_digit).collect();
    let rest = &token[digits.len()..];
    (digits, clean_suffix(rest))
}

/// Trim separators: `-3` → `3`, `/2` → `2`, nothing → none.
fn clean_suffix(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches(['-', '/', ' ']).trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(street: &str, number: &str, suffix: Option<&str>) -> StreetParts {
        StreetParts {
            street: street.to_owned(),
            house_number: number.to_owned(),
            suffix: suffix.map(str::to_owned),
        }
    }

    #[test]
    fn dutch_and_belgian_lines() {
        let cases = [
            ("Damrak 1", "NL", parts("Damrak", "1", None)),
            ("Damrak 1A", "NL", parts("Damrak", "1", Some("A"))),
            ("Damrak 1 A", "NL", parts("Damrak", "1", Some("A"))),
            (
                "Hoofdstraat 12-3",
                "NL",
                parts("Hoofdstraat", "12", Some("3")),
            ),
            (
                "Laan van Meerdervoort 120 bis",
                "NL",
                parts("Laan van Meerdervoort", "120", Some("bis")),
            ),
            (
                "1e Jan Steenstraat 12",
                "NL",
                parts("1e Jan Steenstraat", "12", None),
            ),
            (
                "Kerkstraat 5 3hoog",
                "NL",
                parts("Kerkstraat", "5", Some("3hoog")),
            ),
            (
                "Rue de la Loi 16 bte 3",
                "BE",
                parts("Rue de la Loi", "16", Some("bte 3")),
            ),
            ("Meir 50 bus 12", "BE", parts("Meir", "50", Some("bus 12"))),
            ("Damrak, 1", "NL", parts("Damrak", "1", None)),
            ("Plein 1944 12", "NL", parts("Plein", "1944", Some("12"))),
        ];
        for (line, country, expected) in cases {
            assert_eq!(split_street(line, country), expected, "{line}");
        }
    }

    #[test]
    fn german_lines() {
        assert_eq!(
            split_street("Hauptstraße 5a", "DE"),
            parts("Hauptstraße", "5", Some("a"))
        );
        assert_eq!(
            split_street("Unter den Linden 77", "de"),
            parts("Unter den Linden", "77", None)
        );
    }

    #[test]
    fn number_first_countries() {
        assert_eq!(
            split_street("10 Downing Street", "GB"),
            parts("Downing Street", "10", None)
        );
        assert_eq!(
            split_street("12bis rue de Rivoli", "FR"),
            parts("rue de Rivoli", "12", Some("bis"))
        );
        // A number-last line in a number-first country still splits.
        assert_eq!(
            split_street("Rue de Rivoli 12", "FR"),
            parts("Rue de Rivoli", "12", None)
        );
        // A number-first line in a number-last country too.
        assert_eq!(
            split_street("5 Avenue Louise", "BE"),
            parts("Avenue Louise", "5", None)
        );
    }

    #[test]
    fn lines_without_a_number() {
        assert_eq!(
            split_street("Rose Cottage", "GB"),
            parts("Rose Cottage", "", None)
        );
        assert_eq!(split_street("   ", "NL"), StreetParts::default());
    }
}
