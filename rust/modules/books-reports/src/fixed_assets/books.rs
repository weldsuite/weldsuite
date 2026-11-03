//! Depreciation books of an asset (`services/fixed-assets/books.ts`): the
//! defaults for a new asset, and the checks a requested book goes through
//! before it is stored. A US entity gets `book` (straight line, posts to the
//! ledger) and `federal` (MACRS GDS for the class, with the bonus the dates
//! give); elsewhere `book` only. State books are always explicit.

use serde_json::{Value, json};
use weldsuite_books_domain::depreciation::{bonus_depreciation_percent, bonus_eligible};
use weldsuite_books_domain::js::{math_round, to_fixed};
use weldsuite_books_domain::jurisdictions::us::is_address_state_code;

use super::shared::{Fail, bad, default_convention, is_macrs_class, is_macrs_method};

pub(crate) const DEPRECIATION_METHODS: [&str; 6] = [
    "straight_line",
    "declining_balance",
    "macrs_gds",
    "macrs_ads",
    "expensed",
    "none",
];
pub(crate) const CONVENTIONS: [&str; 4] = ["half_year", "mid_quarter", "mid_month", "full_month"];

/// `BookInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct BookInput {
    pub(crate) book: String,
    pub(crate) state_code: Option<String>,
    pub(crate) method: String,
    pub(crate) convention: Option<String>,
    pub(crate) recovery_years: f64,
    pub(crate) section_179_amount: Option<f64>,
    pub(crate) bonus_percent: Option<f64>,
    pub(crate) posts_to_ledger: Option<bool>,
}

/// `NormalizedBook`.
#[derive(Debug, Clone)]
pub(crate) struct NormalizedBook {
    pub(crate) book: String,
    pub(crate) state_code: Option<String>,
    pub(crate) method: String,
    pub(crate) convention: String,
    pub(crate) recovery_years: f64,
    pub(crate) section_179_amount: f64,
    pub(crate) bonus_percent: f64,
    pub(crate) posts_to_ledger: bool,
}

/// `BookIssue`.
#[derive(Debug, Clone)]
pub(crate) struct BookIssue {
    pub(crate) book: String,
    pub(crate) state_code: Option<String>,
    pub(crate) severity: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

impl BookIssue {
    pub(crate) fn json(&self) -> Value {
        json!({
            "book": self.book,
            "stateCode": self.state_code,
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        })
    }
}

pub(crate) fn issues_json(issues: &[BookIssue]) -> Value {
    Value::Array(issues.iter().map(BookIssue::json).collect())
}

/// `BookAssetFacts`.
#[derive(Debug, Clone, Default)]
pub(crate) struct BookAssetFacts {
    pub(crate) asset_class: Option<String>,
    pub(crate) acquisition_date: String,
    pub(crate) placed_in_service_date: String,
    pub(crate) cost: f64,
    pub(crate) business_use_percent: f64,
    pub(crate) listed_property: bool,
    pub(crate) useful_life_years: Option<f64>,
    pub(crate) section_179_amount: Option<f64>,
    pub(crate) bonus_percent: Option<f64>,
    pub(crate) bonus_reduced_election: bool,
}

/// `mustUseAds(facts)`.
fn must_use_ads(facts: &BookAssetFacts) -> bool {
    facts.listed_property && facts.business_use_percent <= 50.0
}

/// `defaultBooks(entity, facts)`.
pub(crate) fn default_books(jurisdiction_code: &str, facts: &BookAssetFacts) -> Vec<BookInput> {
    let macrs_class = is_macrs_class(facts.asset_class.as_deref())
        .then(|| weldsuite_books_domain::js::js_number_value(Some(&json!(facts.asset_class))));
    let life = facts.useful_life_years.or(macrs_class).unwrap_or(5.0);
    let mut books = vec![BookInput {
        book: "book".to_owned(),
        method: "straight_line".to_owned(),
        convention: Some("full_month".to_owned()),
        recovery_years: life,
        posts_to_ledger: Some(true),
        ..BookInput::default()
    }];
    if jurisdiction_code.to_uppercase() == "US"
        && let Some(class) = macrs_class
    {
        books.push(BookInput {
            book: "federal".to_owned(),
            method: "macrs_gds".to_owned(),
            recovery_years: class,
            section_179_amount: Some(facts.section_179_amount.unwrap_or(0.0)),
            bonus_percent: facts.bonus_percent,
            ..BookInput::default()
        });
    }
    books
}

/// `defaultBonusPercent(facts, recoveryYears)`.
fn default_bonus_percent(facts: &BookAssetFacts, recovery_years: f64) -> f64 {
    if !bonus_eligible(recovery_years) {
        return 0.0;
    }
    bonus_depreciation_percent(
        &facts.acquisition_date,
        &facts.placed_in_service_date,
        facts.bonus_reduced_election,
    )
    .percent
}

/// `normalizeBooks(inputs, facts)`: the books to store and the changes made
/// on the way; a request that can't be stored is a 400.
#[allow(clippy::too_many_lines)] // the rules, in the order TypeScript applies them
pub(crate) fn normalize_books(
    inputs: &[BookInput],
    facts: &BookAssetFacts,
) -> Result<(Vec<NormalizedBook>, Vec<BookIssue>), Fail> {
    let mut issues = Vec::new();
    let mut books: Vec<NormalizedBook> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let base_cost = math_round(facts.cost * facts.business_use_percent) / 100.0;

    for input in inputs {
        let state_code = if input.book == "state" {
            input.state_code.clone().unwrap_or_default().to_uppercase()
        } else {
            String::new()
        };
        if input.book == "state" && !is_address_state_code(&state_code) {
            return Err(bad("A state book needs a stateCode (two letters, e.g. CA)"));
        }
        let key = format!("{}:{state_code}", input.book);
        if seen.contains(&key) {
            return Err(bad(if input.book == "state" {
                format!("There is already a {state_code} state book")
            } else {
                format!("There is already a {} book", input.book)
            }));
        }
        seen.push(key);

        let posts_to_ledger = input.posts_to_ledger.unwrap_or(input.book == "book");
        if posts_to_ledger && input.book != "book" {
            return Err(bad(
                "Only the book (GAAP) depreciation book can post to the ledger",
            ));
        }

        let mut method = input.method.clone();
        let mut section179 = input.section_179_amount.unwrap_or(0.0);
        let mut bonus_percent = input.bonus_percent;
        let state = (!state_code.is_empty()).then(|| state_code.clone());
        let mut warn = |code: &str, message: &str| {
            issues.push(BookIssue {
                book: input.book.clone(),
                state_code: state.clone(),
                severity: "warning".to_owned(),
                code: code.to_owned(),
                message: message.to_owned(),
            });
        };

        let macrs = is_macrs_method(&method);
        if !macrs && (section179 > 0.0 || bonus_percent.unwrap_or(0.0) > 0.0) {
            return Err(bad(
                "Section 179 and bonus depreciation only apply to MACRS books",
            ));
        }
        if macrs && input.book == "book" {
            return Err(bad(
                "The book (GAAP) depreciation book uses a book method (straight line, declining balance, expensed or none)",
            ));
        }
        if !macrs && input.book != "book" && method != "expensed" && method != "none" {
            warn(
                "non_macrs_tax_book",
                "A tax book normally uses MACRS; this one uses a book method",
            );
        }

        if macrs && must_use_ads(facts) {
            if method == "macrs_gds" {
                "macrs_ads".clone_into(&mut method);
                warn(
                    "ads_required",
                    "Listed property used 50% or less for business must use ADS; the book was converted to ADS",
                );
            }
            if section179 > 0.0 {
                section179 = 0.0;
                warn(
                    "section_179_not_allowed",
                    "Section 179 is not allowed on property used 50% or less for business",
                );
            }
            if bonus_percent.unwrap_or(0.0) > 0.0 {
                warn(
                    "bonus_not_allowed",
                    "Bonus depreciation is not allowed on property that must use ADS",
                );
            }
            bonus_percent = Some(0.0);
        }
        if section179 > base_cost + 0.005 {
            return Err(bad(format!(
                "Section 179 ({}) cannot exceed the business cost of the asset ({})",
                to_fixed(section179, 2),
                to_fixed(base_cost, 2)
            )));
        }
        if bonus_percent.is_some_and(|b| !(0.0..=100.0).contains(&b)) {
            return Err(bad("bonusPercent is 0 to 100"));
        }

        let recovery_years = input.recovery_years;
        if method != "expensed"
            && method != "none"
            && recovery_years.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        {
            return Err(bad("recoveryYears must be greater than zero"));
        }
        if macrs && input.book == "federal" && bonus_percent.is_none() {
            bonus_percent = Some(if method == "macrs_gds" {
                default_bonus_percent(facts, recovery_years)
            } else {
                0.0
            });
        }

        let convention = input
            .convention
            .clone()
            .unwrap_or_else(|| default_convention(&method, recovery_years).to_owned());
        books.push(NormalizedBook {
            book: input.book.clone(),
            state_code: state,
            method,
            convention,
            recovery_years: if recovery_years > 0.0 {
                recovery_years
            } else {
                1.0
            },
            section_179_amount: section179,
            bonus_percent: bonus_percent.unwrap_or(0.0),
            posts_to_ledger,
        });
    }

    if books.iter().filter(|b| b.posts_to_ledger).count() > 1 {
        return Err(bad("Only one book can post to the ledger"));
    }
    Ok((books, issues))
}
