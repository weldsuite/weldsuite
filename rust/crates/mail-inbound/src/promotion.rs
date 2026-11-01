//! `promotion-filter.ts`: whether a (non-spam) inbound message is bulk
//! marketing that belongs under PROMOTIONS. Pure.

use regex::Regex;

use crate::parsed::header_value;

/// Score at or above this value is treated as a promotion.
pub const PROMOTION_SCORE_THRESHOLD: i64 = 4;

const CAMPAIGN_HEADERS: [&str; 11] = [
    "x-campaign",
    "x-campaignid",
    "x-campaign-id",
    "x-mailchimp-campaign",
    "x-mc-user",
    "x-mailin-campaign",
    "x-klaviyo-message-id",
    "x-hs-campaign-id",
    "x-marketo-id",
    "x-newsletter",
    "x-list-id",
];

const PROMOTION_SUBJECT_LEXICON: [&str; 22] = [
    "% off",
    "sale",
    "discount",
    "coupon",
    "promo code",
    "deal",
    "deals",
    "limited time",
    "last chance",
    "free shipping",
    "black friday",
    "cyber monday",
    "shop now",
    "new arrivals",
    "newsletter",
    "exclusive offer",
    "korting",
    "aanbieding",
    "uitverkoop",
    "gratis verzending",
    "nieuwsbrief",
    "laatste kans",
];

const UNSUBSCRIBE_LEXICON: [&str; 5] = [
    "unsubscribe",
    "afmelden",
    "uitschrijven",
    "opt out",
    "opt-out",
];

const TRANSACTIONAL_LEXICON: [&str; 17] = [
    "receipt",
    "invoice",
    "order confirmation",
    "your order",
    "has shipped",
    "password",
    "verification code",
    "verify your",
    "security alert",
    "sign-in",
    "login code",
    "factuur",
    "bestelling",
    "orderbevestiging",
    "wachtwoord",
    "verificatiecode",
    "beveiligingsmelding",
];

/// `PromotionClassifyEmail`.
#[derive(Debug, Clone, Default)]
pub struct PromotionInput<'a> {
    pub subject: Option<&'a str>,
    pub text_body: Option<&'a str>,
    pub html_body: Option<&'a str>,
    pub headers: &'a [(String, String)],
}

/// `PromotionClassifyResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Promotion {
    pub is_promotion: bool,
    pub score: i64,
    pub reasons: Vec<String>,
}

/// `containsPhrase(text, phrase)`: a whole-word match (letters and digits
/// in any script count as word characters), or a plain one for a phrase
/// that starts with a non-word character.
fn contains_phrase(text: &str, phrase: &str) -> bool {
    let first_is_word = phrase
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    if !first_is_word {
        return text.contains(phrase);
    }
    let pattern = format!(
        r"(?:^|[^\p{{L}}\p{{N}}]){}(?:$|[^\p{{L}}\p{{N}}])",
        regex::escape(phrase)
    );
    Regex::new(&pattern).is_ok_and(|re| re.is_match(text))
}

/// `classifyPromotion(email, { isReply })`.
pub fn classify_promotion(email: &PromotionInput<'_>, is_reply: bool) -> Promotion {
    if is_reply {
        return Promotion {
            is_promotion: false,
            score: 0,
            reasons: vec!["reply".to_owned()],
        };
    }
    let mut score = 0;
    let mut reasons = Vec::new();
    let headers = email.headers;
    let has = |name: &str| header_value(headers, name).is_some();
    if has("list-unsubscribe") {
        score += 2;
        reasons.push("list_unsubscribe");
    }
    if has("list-unsubscribe-post") {
        score += 1;
        reasons.push("list_unsubscribe_post");
    }
    let precedence =
        header_value(headers, "precedence").map(|p| crate::mime::js_trim(p).to_lowercase());
    if matches!(precedence.as_deref(), Some("bulk" | "list")) {
        score += 1;
        reasons.push("precedence_bulk");
    }
    if CAMPAIGN_HEADERS.iter().any(|h| has(h)) {
        score += 2;
        reasons.push("campaign_header");
    }
    let subject = email.subject.unwrap_or_default().to_lowercase();
    if PROMOTION_SUBJECT_LEXICON
        .iter()
        .any(|p| contains_phrase(&subject, p))
    {
        score += 2;
        reasons.push("subject_marketing");
    }
    let body = format!(
        "{} {}",
        email.text_body.unwrap_or_default(),
        email.html_body.unwrap_or_default()
    )
    .to_lowercase();
    if UNSUBSCRIBE_LEXICON
        .iter()
        .any(|p| contains_phrase(&body, p))
    {
        score += 1;
        reasons.push("body_unsubscribe");
    }
    if TRANSACTIONAL_LEXICON
        .iter()
        .any(|p| contains_phrase(&subject, p))
    {
        score -= 4;
        reasons.push("subject_transactional");
    }
    Promotion {
        is_promotion: score >= PROMOTION_SCORE_THRESHOLD,
        score,
        reasons: reasons.into_iter().map(str::to_owned).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_words() {
        assert!(contains_phrase("big sale today", "sale"));
        assert!(!contains_phrase("wholesale pricing", "sale"));
        assert!(contains_phrase("30% off", "% off"));
        assert!(!contains_phrase("forsale", "sale"));
        assert!(contains_phrase("é sale", "sale"));
        assert!(!contains_phrase("ésale", "sale"));
    }
}
