//! The Positive Pay issued-checks file of a bank account
//! (`services/payment-runs/positive-pay.ts`): every printed check, voided
//! ones included, for the builder to pick the ones issued or voided in the
//! range. A check is reported for what it is written for (the payment less
//! any backup withholding). The account number is decrypted for the file and
//! the reveal logged (`positive_pay`).

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_accounts::reveal_account_number;
use weldsuite_books_domain::payments::payment_net_amount;
use weldsuite_books_domain::positive_pay::{
    PositivePayCheck, PositivePayIssue, build_positive_pay_file, is_positive_pay_format,
};
use weldsuite_books_domain::tables::PAYMENTS;
use weldsuite_db::Keyring;

use super::checks::register_where;
use super::runs::{s, text};
use super::settings::{positive_pay_format_of, read_positive_pay_config};
use super::{RunError, bad, load_bank_account, run_error};

#[allow(clippy::cast_precision_loss)]
fn dollars(cents: i64) -> String {
    weldsuite_books_domain::js::to_fixed(cents as f64 / 100.0, 2)
}

fn iso_day(value: &str) -> String {
    value.chars().take(10).collect()
}

/// `generatePositivePay(db, env, args)`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_positive_pay(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    user_id: &str,
    bank_account_id: &str,
    from: Option<&str>,
    to: Option<&str>,
    format: Option<&str>,
) -> Result<Value, RunError> {
    let bank = load_bank_account(db, entity_id, bank_account_id).await?;
    if !weldsuite_books_domain::js::truthy(bank.get("accountNumberEncrypted")) {
        return Err(run_error(
            "NO_ACCOUNT_NUMBER",
            "This bank account has no account number on file: add it before making a Positive Pay file.".to_owned(),
            409,
            None,
        ));
    }
    if let Some(format) = format.filter(|f| !f.is_empty())
        && !is_positive_pay_format(format)
    {
        return Err(bad(
            "INVALID_FORMAT",
            &format!("Unknown Positive Pay format {format}."),
            None,
        ));
    }
    let format = positive_pay_format_of(&bank, format);

    // Every check that was printed, voided ones included.
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        ", p.display_name from payments t left join parties p on p.id = t.contact_id where ",
        register_where!(),
        " and t.check_printed_at is not null"
    ))
    .bind(entity_id)
    .bind(s(&bank, "id"))
    .bind(None::<String>)
    .bind(None::<String>)
    .fetch_all(db)
    .await?;
    let checks: Vec<PositivePayCheck> = rows
        .into_iter()
        .map(|(row, payee)| {
            let payment = PAYMENTS.js(row);
            let deleted = text(&payment, "deletedAt");
            let voided = deleted.is_some() || text(&payment, "checkStatus") == Some("voided");
            PositivePayCheck {
                check_number: s(&payment, "checkNumber").to_owned(),
                issue_date: iso_day(s(&payment, "date")),
                amount: payment_net_amount(&payment),
                payee: payee.unwrap_or_else(|| s(&payment, "contactId").to_owned()),
                voided,
                void_date: voided.then(|| iso_day(deleted.unwrap_or(s(&payment, "updatedAt")))),
                account_number: None,
            }
        })
        .collect();

    let account_number = reveal_account_number(db, keyring, &bank, user_id, Some("positive_pay"))
        .await?
        .account_number;
    let (_, overrides) = read_positive_pay_config(bank.get("checkSettings"));
    let file = build_positive_pay_file(
        &checks,
        &format,
        &account_number,
        from.filter(|f| !f.is_empty()),
        to.filter(|t| !t.is_empty()),
        &overrides,
    )
    .map_err(|refused| {
        run_error(
            "POSITIVE_PAY_INVALID",
            "The Positive Pay file can't be made: fix the issues listed and try again.".to_owned(),
            422,
            Some(json!({
                "errors": refused.errors.iter().map(PositivePayIssue::to_json).collect::<Vec<_>>(),
                "warnings": refused.warnings.iter().map(PositivePayIssue::to_json).collect::<Vec<_>>(),
            })),
        )
    })?;
    Ok(json!({
        "fileName": file.file_name,
        "content": file.content,
        "format": file.format,
        "counts": {
            "records": file.record_count,
            "issued": file.issue_count,
            "voided": file.void_count,
            "totalIssued": dollars(file.total_issued_cents),
            "totalVoided": dollars(file.total_voided_cents),
        },
        "warnings": file.warnings.iter().map(|w| {
            let mut out = serde_json::Map::new();
            out.insert("code".to_owned(), json!(w.code));
            out.insert("message".to_owned(), json!(w.message));
            if let Some(number) = w.check_number.as_deref().filter(|n| !n.is_empty()) {
                out.insert("checkNumber".to_owned(), json!(number));
            }
            Value::Object(out)
        }).collect::<Vec<_>>(),
    }))
}
