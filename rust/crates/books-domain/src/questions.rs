//! Questions on a bank line, answered by what the books do (ADR BOOKS-015,
//! edition feature `books-questions`): a receipt attached to the line, or a
//! document booked for it, answers the open questions asked about it ("What was
//! this payment?"). The rule and the thread's state are
//! [`weldsuite_chat_domain::questions`]; this is the books' side of it: the
//! change, and the `accounting_question.updated` events.

use serde_json::Value;
use weldsuite_catalogs::entity_events::ACCOUNTING_QUESTION_UPDATED;
use weldsuite_chat_domain::questions::{answer_open_on_record, changed_json};

use crate::http::{BooksState, Caller};

/// The open questions on a bank line become answered, and each says so as an
/// event. A failure is logged and never fails the action that caused it: the
/// receipt is attached either way.
pub async fn answer_bank_line_questions(
    caller: &Caller,
    state: &BooksState,
    bank_transaction_id: &str,
) {
    match answer_open_on_record(&caller.db, "bank_transaction", bank_transaction_id).await {
        Ok(changed) => {
            for question in changed {
                let data: Value = changed_json(&question);
                caller.publish(
                    state,
                    ACCOUNTING_QUESTION_UPDATED,
                    &question.message_id,
                    data,
                );
            }
        }
        Err(error) => tracing::error!(
            %error,
            bank_transaction_id,
            "[books] answering the questions on a bank line failed"
        ),
    }
}
