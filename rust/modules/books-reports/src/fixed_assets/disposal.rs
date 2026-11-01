//! Disposing of a fixed asset (`services/fixed-assets/disposal.ts`): the
//! ledger book's schedule rebuilt with the disposal date, the complete
//! months before it posted (catch-up), and one entry dated the disposal date
//! that closes the asset (accumulated depreciation, proceeds, cost, and the
//! gain or loss). Tax books post nothing; the result reports their gain and
//! the section 1245 / 1250 recapture.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::dates::{add_days, is_iso_date};
use weldsuite_books_domain::depreciation::{DisposalGain, gain_on_disposal};
use weldsuite_books_domain::guards::{PostingCheck, PostingLockKind, assert_posting_allowed};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{math_round, number_value};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostJournalEntryInput, PostingLine, account_for_role, load_entity_accounts,
    post_journal_entry,
};
use weldsuite_books_domain::reports_basis::periods::fiscal_config_of;

use super::assets::{
    assert_posted_match, load_asset, load_books, load_entity, load_ledger_rows,
    refresh_macrs_conventions, replace_ledger_rows, schedule_context_for,
};
use super::run::{
    LineDimension, PostedPeriod, RunArgs, depreciation_lines, load_pending_rows, run_depreciation,
    write_dimensions,
};
use super::schedules::{annual_schedule, business_use, ledger_rows};
use super::shared::{
    Fail, bad, conflict, from_cents, money, not_found, num, opt, present, text, to_cents,
};

/// `DisposeInput`.
pub(crate) struct DisposeInput {
    pub(crate) date: String,
    pub(crate) proceeds: f64,
    pub(crate) deposit_account_id: Option<String>,
    pub(crate) gain_loss_account_id: Option<String>,
}

/// `DisposeResult`.
pub(crate) struct Disposed {
    pub(crate) asset: Value,
    pub(crate) json: Value,
    pub(crate) proceeds: f64,
    pub(crate) gain_or_loss: f64,
}

fn gain_json(gain: &DisposalGain) -> [(&'static str, Value); 6] {
    [
        ("adjustedBasis", number_value(gain.adjusted_basis)),
        ("gainOrLoss", number_value(gain.gain_or_loss)),
        ("result", json!(gain.result)),
        ("ordinaryRecapture", number_value(gain.ordinary_recapture)),
        (
            "unrecapturedSection1250",
            number_value(gain.unrecaptured_section_1250),
        ),
        ("remainingGain", number_value(gain.remaining_gain)),
    ]
}

/// `disposeFixedAsset(db, { assetId, userId, input })`.
#[allow(clippy::too_many_lines)] // the service's three steps, in order
pub(crate) async fn dispose_fixed_asset(
    db: &PgPool,
    asset_id: &str,
    user_id: Option<&str>,
    input: &DisposeInput,
) -> Result<Disposed, Fail> {
    let Some(asset) = load_asset(db, asset_id).await? else {
        return Err(not_found("Fixed asset not found"));
    };
    if text(&asset, "status") == "disposed" {
        return Err(conflict("This asset has already been disposed of"));
    }
    if !is_iso_date(&input.date) {
        return Err(bad("date must be a date (YYYY-MM-DD)"));
    }
    if input.date.as_str() < text(&asset, "placedInServiceDate") {
        return Err(bad(
            "The asset cannot be disposed of before it was placed in service",
        ));
    }
    if !input.proceeds.is_finite() || input.proceeds < 0.0 {
        return Err(bad("proceeds cannot be negative"));
    }

    let entity_id = text(&asset, "entityId").to_owned();
    let entity = load_entity(db, &entity_id).await?;
    let config = fiscal_config_of(&entity);
    let accounts = load_entity_accounts(db, &entity_id).await?;

    let proceeds_cents = to_cents(input.proceeds);
    let mut deposit_account_id: Option<String> = None;
    if proceeds_cents > 0 {
        if let Some(id) = input
            .deposit_account_id
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            if accounts.by_id(Some(id)).is_none() {
                return Err(bad(
                    "depositAccountId does not belong to this accounting entity",
                ));
            }
            deposit_account_id = Some(id.to_owned());
        } else {
            let fallback = account_for_role(&accounts, "undeposited_funds", &[])
                .or_else(|| accounts.by_subtype("bank"));
            let Some(fallback) = fallback else {
                return Err(bad(
                    "Choose the account the proceeds went to (depositAccountId)",
                ));
            };
            deposit_account_id = Some(text(fallback, "id").to_owned());
        }
    }
    if let Some(id) = input
        .gain_loss_account_id
        .as_deref()
        .filter(|id| !id.is_empty())
        && accounts.by_id(Some(id)).is_none()
    {
        return Err(bad(
            "gainLossAccountId does not belong to this accounting entity",
        ));
    }

    assert_posting_allowed(
        db,
        PostingCheck {
            entity_id: &entity_id,
            date: &input.date,
            kind: PostingLockKind::General,
            affects_tax: false,
            user_id,
        },
    )
    .await?;

    // --- 1 + 2: the ledger book's schedule up to the disposal date ---------
    let books = load_books(db, asset_id).await?;
    let ledger_book = books
        .iter()
        .find(|book| book["postsToLedger"] == json!(true))
        .cloned();
    let mut catch_up: Vec<PostedPeriod> = Vec::new();
    if let Some(book) = &ledger_book {
        let book_id = text(book, "id").to_owned();
        let before = load_ledger_rows(db, asset_id, Some(&book_id)).await?;
        let posted_before: Vec<Value> = before
            .into_iter()
            .filter(|row| present(row, "journalEntryId").is_some())
            .collect();
        let with_disposal = ledger_rows(&asset, book, &config, Some(Some(&input.date)));
        assert_posted_match(
            &posted_before,
            &with_disposal.rows,
            "Disposing of the asset on this date",
        )?;
        replace_ledger_rows(db, &asset, book, &with_disposal.rows, &posted_before).await?;
        let through = add_days(&input.date, -1).unwrap_or_default();
        let run = run_depreciation(
            db,
            &RunArgs {
                entity_id: entity_id.clone(),
                through,
                user_id: user_id.map(str::to_owned),
                asset_id: Some(asset_id.to_owned()),
                keep_active: true,
            },
        )
        .await
        .and_then(|run| match run.skipped.first() {
            Some(first) => Err(conflict(format!(
                "Depreciation up to the disposal date could not be posted ({}): {}",
                first.period_end, first.reason
            ))),
            None => Ok(run),
        });
        match run {
            Ok(run) => catch_up = run.posted,
            Err(error) => {
                // Put the schedule back as it was; whatever was posted is the same in both.
                let posted: Vec<Value> = load_ledger_rows(db, asset_id, Some(&book_id))
                    .await?
                    .into_iter()
                    .filter(|row| present(row, "journalEntryId").is_some())
                    .collect();
                let original = ledger_rows(&asset, book, &config, None);
                replace_ledger_rows(db, &asset, book, &original.rows, &posted).await?;
                return Err(error);
            }
        }
    }

    // --- 3: the disposal entry ---------------------------------------------
    let stub = if ledger_book.is_some() {
        load_pending_rows(db, &entity_id, "9999-12-31", Some(asset_id)).await?
    } else {
        Vec::new()
    };
    let stub_cents: i64 = stub.iter().map(|p| to_cents(num(&p.row, "amount"))).sum();
    let all_rows = match &ledger_book {
        Some(book) => load_ledger_rows(db, asset_id, Some(text(book, "id"))).await?,
        None => Vec::new(),
    };
    let accumulated_cents: i64 = all_rows
        .iter()
        .map(|row| to_cents(num(row, "amount")))
        .sum();
    let cost_cents = to_cents(num(&asset, "cost"));
    let net_book_cents = cost_cents - accumulated_cents;
    let diff_cents = proceeds_cents - net_book_cents;

    let mut gain_loss_account_id: Option<String> = None;
    if diff_cents != 0 {
        let account = match input
            .gain_loss_account_id
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            Some(id) => accounts.by_id(Some(id)),
            None => account_for_role(&accounts, "gain_loss_on_disposal", &[]),
        };
        let Some(account) = account else {
            return Err(bad(
                "Choose the gain or loss on disposal account (gainLossAccountId): this chart has no default for it",
            ));
        };
        gain_loss_account_id = Some(text(account, "id").to_owned());
    }

    let (mut lines, stub_dimensions) = depreciation_lines(&stub);
    let mut dimensioned: Vec<usize> = Vec::new();
    let label = match present(&asset, "assetNumber") {
        Some(number) => format!("{number} {}", text(&asset, "name")),
        None => text(&asset, "name").to_owned(),
    };
    if accumulated_cents > 0 {
        dimensioned.push(lines.len());
        lines.push(PostingLine {
            account_id: text(&asset, "accumulatedDepreciationAccountId").to_owned(),
            debit: from_cents(accumulated_cents),
            description: Some(format!("Disposal {label}: accumulated depreciation")),
            ..PostingLine::default()
        });
    }
    if proceeds_cents > 0
        && let Some(deposit) = &deposit_account_id
    {
        lines.push(PostingLine {
            account_id: deposit.clone(),
            debit: from_cents(proceeds_cents),
            description: Some(format!("Disposal {label}: proceeds")),
            ..PostingLine::default()
        });
    }
    dimensioned.push(lines.len());
    lines.push(PostingLine {
        account_id: text(&asset, "assetAccountId").to_owned(),
        credit: from_cents(cost_cents),
        description: Some(format!("Disposal {label}: cost")),
        ..PostingLine::default()
    });
    if let Some(account) = &gain_loss_account_id
        && diff_cents != 0
    {
        dimensioned.push(lines.len());
        let mut line = PostingLine {
            account_id: account.clone(),
            description: Some(format!(
                "{} on disposal of {label}",
                if diff_cents > 0 { "Gain" } else { "Loss" }
            )),
            ..PostingLine::default()
        };
        if diff_cents > 0 {
            line.credit = from_cents(diff_cents);
        } else {
            line.debit = from_cents(-diff_cents);
        }
        lines.push(line);
    }
    let mut dimensions = stub_dimensions;
    if present(&asset, "classId").is_some() || present(&asset, "locationId").is_some() {
        dimensions.extend(dimensioned.into_iter().map(|index| LineDimension {
            index,
            class_id: opt(&asset, "classId").map(str::to_owned),
            location_id: opt(&asset, "locationId").map(str::to_owned),
        }));
    }

    let stub_ids: Vec<String> = stub.iter().map(|p| text(&p.row, "id").to_owned()).collect();
    let at = now();
    let write_id = asset_id.to_owned();
    let write_date = input.date.clone();
    let write_proceeds = money(proceeds_cents);
    let also: AlsoWrite = Box::new(move |conn, entry| {
        Box::pin(async move {
            if !stub_ids.is_empty() {
                sqlx::query(
                    "update fixed_asset_depreciation set journal_entry_id = $1 where id = any($2)",
                )
                .bind(&entry.journal_entry_id)
                .bind(&stub_ids)
                .execute(&mut *conn)
                .await?;
            }
            write_dimensions(conn, &entry.journal_entry_id, &dimensions).await?;
            sqlx::query(
                "update fixed_assets set status = 'disposed', disposal_date = $1::date, \
                 disposal_proceeds = $2::numeric, disposal_journal_entry_id = $3, \
                 updated_at = $4::timestamp where id = $5",
            )
            .bind(&write_date)
            .bind(&write_proceeds)
            .bind(&entry.journal_entry_id)
            .bind(&at)
            .bind(&write_id)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    });
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.clone(),
            date: input.date.clone(),
            description: format!("Disposal of {label}"),
            source_type: "fixed_asset".to_owned(),
            source_id: Some(asset_id.to_owned()),
            posting_key: Some(format!("fixed_asset:{asset_id}:disposal")),
            lock_kind: Some(PostingLockKind::General),
            created_by: user_id.map(str::to_owned),
            is_automatic: Some(false),
            lines,
            also_write: vec![also],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    let Some(journal_entry_id) = posted.journal_entry_id else {
        return Err(bad("Nothing to post for this disposal"));
    };

    let disposed = load_asset(db, asset_id).await?.unwrap_or(Value::Null);
    refresh_macrs_conventions(db, &entity).await?;

    // --- tax books -----------------------------------------------------------
    let context = schedule_context_for(db, &entity).await?;
    let business = business_use(&asset);
    let mut tax_books = Vec::new();
    for book in &books {
        if book["postsToLedger"] == json!(true) || text(book, "book") == "book" {
            continue;
        }
        let schedule = annual_schedule(&disposed, book, &context);
        let accumulated = schedule.rows.last().map_or(0.0, |row| row.accumulated);
        let business_proceeds = math_round(input.proceeds * business) / 100.0;
        let years = num(book, "recoveryYears");
        #[allow(clippy::float_cmp)] // the classes are exact
        let section_1250 = years == 27.5 || years == 39.0;
        let gain = gain_on_disposal(
            schedule.basis.base_cost,
            accumulated,
            business_proceeds,
            section_1250,
        );
        let mut entry = json!({
            "book": book["book"],
            "stateCode": book["stateCode"],
            "method": schedule.method,
            "accumulated": number_value(accumulated),
            "proceeds": number_value(business_proceeds),
        });
        for (key, value) in gain_json(&gain) {
            entry[key] = value;
        }
        tax_books.push(entry);
    }

    let gain_or_loss = from_cents(diff_cents);
    let json = json!({
        "asset": disposed,
        "journalEntryId": journal_entry_id,
        "entryNumber": posted.entry_number,
        "proceeds": number_value(from_cents(proceeds_cents)),
        "accumulatedDepreciation": number_value(from_cents(accumulated_cents)),
        "netBookValue": number_value(from_cents(net_book_cents)),
        "gainOrLoss": number_value(gain_or_loss),
        "result": match diff_cents.cmp(&0) {
            std::cmp::Ordering::Greater => "gain",
            std::cmp::Ordering::Less => "loss",
            std::cmp::Ordering::Equal => "none",
        },
        "catchUp": catch_up.iter().map(PostedPeriod::json).collect::<Vec<_>>(),
        "disposalMonthDepreciation": number_value(from_cents(stub_cents)),
        "taxBooks": tax_books,
    });
    Ok(Disposed {
        asset: disposed,
        json,
        proceeds: from_cents(proceeds_cents),
        gain_or_loss,
    })
}
