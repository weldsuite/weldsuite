//! What a planning run does to a plan's review columns
//! (`review_status`, `dismissed_*`, `purchase_order_id`). A run overwrites
//! the computed columns; the review state moves only by these rules:
//!
//! | Before | After the run |
//! |---|---|
//! | no plan, `none`, `open` | `open` when there is something to order, else `none` |
//! | `dismissed` | stays dismissed until `dismissed_until` passes or the suggestion grows by more than half of `dismissed_qty`; then (or when nothing is left to order) as above, dismissal cleared |
//! | `ordered` | stays ordered while its purchase order is open; once it is received, closed, cancelled or deleted, as above, purchase order cleared |

/// The review columns of a plan before the run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Prior {
    pub(crate) status: String,
    /// `dismissed_until` as stored (`YYYY-MM-DDTHH:MM:SS.mmm`).
    pub(crate) dismissed_until: Option<String>,
    /// `dismissed_until` has passed.
    pub(crate) dismissal_over: bool,
    pub(crate) dismissed_by: Option<String>,
    pub(crate) dismissed_qty: Option<i64>,
    pub(crate) purchase_order_id: Option<String>,
}

/// The review columns the run writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Review {
    pub(crate) status: &'static str,
    pub(crate) dismissed_until: Option<String>,
    pub(crate) dismissed_by: Option<String>,
    pub(crate) dismissed_qty: Option<i64>,
    pub(crate) purchase_order_id: Option<String>,
    /// The plan now needs reordering and did not before this run.
    pub(crate) newly_open: bool,
}

/// `open` or `none`, with nothing dismissed or ordered.
fn fresh(suggested: i64, was_open: bool) -> Review {
    let status = if suggested > 0 { "open" } else { "none" };
    Review {
        status,
        dismissed_until: None,
        dismissed_by: None,
        dismissed_qty: None,
        purchase_order_id: None,
        newly_open: status == "open" && !was_open,
    }
}

/// Whether `suggested` is more than half again `dismissed`.
fn grew_by_half(suggested: i64, dismissed: Option<i64>) -> bool {
    dismissed.is_some_and(|dismissed| i128::from(suggested) * 2 > i128::from(dismissed) * 3)
}

/// The review state after a run that suggests `suggested` units.
/// `order_done`: the plan's purchase order is received, closed,
/// cancelled, deleted or gone (only read for an `ordered` plan).
pub(crate) fn next_review(prior: Option<&Prior>, suggested: i64, order_done: bool) -> Review {
    let Some(prior) = prior else {
        return fresh(suggested, false);
    };
    match prior.status.as_str() {
        "dismissed" => {
            if suggested > 0
                && !prior.dismissal_over
                && !grew_by_half(suggested, prior.dismissed_qty)
            {
                Review {
                    status: "dismissed",
                    dismissed_until: prior.dismissed_until.clone(),
                    dismissed_by: prior.dismissed_by.clone(),
                    dismissed_qty: prior.dismissed_qty,
                    purchase_order_id: None,
                    newly_open: false,
                }
            } else {
                fresh(suggested, false)
            }
        }
        "ordered" if !order_done && prior.purchase_order_id.is_some() => Review {
            status: "ordered",
            dismissed_until: None,
            dismissed_by: None,
            dismissed_qty: None,
            purchase_order_id: prior.purchase_order_id.clone(),
            newly_open: false,
        },
        "ordered" => fresh(suggested, false),
        status => fresh(suggested, status == "open"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prior(status: &str) -> Prior {
        Prior {
            status: status.to_owned(),
            ..Prior::default()
        }
    }

    fn dismissed(qty: i64, over: bool) -> Prior {
        Prior {
            status: "dismissed".to_owned(),
            dismissed_until: Some("2026-11-25T08:00:00.000".to_owned()),
            dismissal_over: over,
            dismissed_by: Some("user_1".to_owned()),
            dismissed_qty: Some(qty),
            purchase_order_id: None,
        }
    }

    #[test]
    fn a_new_plan_opens_when_there_is_something_to_order() {
        let opened = next_review(None, 12, false);
        assert_eq!(opened.status, "open");
        assert!(opened.newly_open);
        let quiet = next_review(None, 0, false);
        assert_eq!(quiet.status, "none");
        assert!(!quiet.newly_open);
    }

    #[test]
    fn open_and_none_follow_the_suggestion() {
        let still = next_review(Some(&prior("open")), 5, false);
        assert_eq!(still.status, "open");
        assert!(!still.newly_open, "already open");
        assert_eq!(next_review(Some(&prior("open")), 0, false).status, "none");
        let reopened = next_review(Some(&prior("none")), 5, false);
        assert_eq!(reopened.status, "open");
        assert!(reopened.newly_open);
    }

    #[test]
    fn a_dismissal_holds_until_it_ends_or_the_suggestion_grows_by_half() {
        let held = next_review(Some(&dismissed(100, false)), 150, false);
        assert_eq!(held.status, "dismissed");
        assert_eq!(held.dismissed_qty, Some(100));
        assert_eq!(held.dismissed_by.as_deref(), Some("user_1"));
        assert!(held.dismissed_until.is_some());

        let grown = next_review(Some(&dismissed(100, false)), 151, false);
        assert_eq!(grown.status, "open");
        assert!(grown.newly_open);
        assert_eq!(grown.dismissed_qty, None);
        assert_eq!(grown.dismissed_until, None);

        let ended = next_review(Some(&dismissed(100, true)), 80, false);
        assert_eq!(ended.status, "open");
        assert!(ended.newly_open);

        let gone = next_review(Some(&dismissed(100, false)), 0, false);
        assert_eq!(gone.status, "none");
        assert_eq!(gone.dismissed_by, None);
    }

    #[test]
    fn an_order_holds_until_its_purchase_order_is_done() {
        let ordered = Prior {
            status: "ordered".to_owned(),
            purchase_order_id: Some("po_1".to_owned()),
            ..Prior::default()
        };
        let held = next_review(Some(&ordered), 40, false);
        assert_eq!(held.status, "ordered");
        assert_eq!(held.purchase_order_id.as_deref(), Some("po_1"));
        assert!(!held.newly_open);

        let reopened = next_review(Some(&ordered), 40, true);
        assert_eq!(reopened.status, "open");
        assert_eq!(reopened.purchase_order_id, None);
        assert!(reopened.newly_open);

        assert_eq!(next_review(Some(&ordered), 0, true).status, "none");
        // An order without a purchase order can't be tracked: as fresh.
        assert_eq!(
            next_review(Some(&prior("ordered")), 3, false).status,
            "open"
        );
    }
}
