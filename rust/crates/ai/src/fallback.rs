//! Refusal detection, ported from `packages/core/ai/src/fallback.ts` and kept
//! in step with it: a 5xx, 401, 402, 403 or 429, or a message about credit,
//! billing, quota or overload, is a refusal another model may not hit. Bad
//! requests are not: they'd fail the same way on the fallback model.

/// `isProviderRefusal`.
pub fn is_provider_refusal(status: Option<u16>, message: &str) -> bool {
    if let Some(status) = status
        && (status >= 500 || [401, 402, 403, 429].contains(&status))
    {
        return true;
    }
    let lower = message.to_lowercase();
    [
        "credit balance",
        "insufficient credit",
        "insufficient funds",
        "insufficient balance",
        "insufficient quota",
        "billing",
        "quota exceeded",
        "overloaded",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// A refusal that means an own key is broken (401, 402, 403): the key is
/// marked `failing`.
pub fn is_key_failure(status: Option<u16>) -> bool {
    matches!(status, Some(401 | 402 | 403))
}
