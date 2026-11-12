//! `@weldsuite/db/lib/desk-articles`: who may read a help-center article or
//! an announcement, article search, language versions and help-center links,
//! for the desk API's public help center and inbox suggestions and the
//! helpdesk widget API's self-service routes.
//!
//! A reader is anonymous or has a verified email; their CRM companies are
//! those of the live CRM people with that email (`people.email` or
//! `alternate_emails`) through current `person_companies` rows. An article
//! is readable when `public`, `logged_in` with a verified email, or `groups`
//! with one of its `audience_company_ids` among the reader's companies;
//! announcements are `public`, or `specific_groups` by `target_groups` the
//! same way. Search is Postgres full-text search with the `simple`
//! configuration: title A, excerpt B, content (tags stripped) C, ranked by
//! `ts_rank`. The SQL is the TypeScript's; where TypeScript leaves a
//! condition out (no companies, no locale) this binds a value that makes it
//! false, so both read the same rows.

use serde_json::{Value, json};
use weldsuite_db::PgPool;

use crate::table::js_date;
use crate::webchat::normalize_email;

/// `DeskReader`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reader {
    /// Lower-cased proven email; `None` for an anonymous reader.
    pub verified_email: Option<String>,
    /// The reader's CRM companies, sorted.
    pub company_ids: Vec<String>,
}

impl Reader {
    /// `DESK_ANONYMOUS_READER`.
    #[must_use]
    pub fn anonymous() -> Self {
        Self::default()
    }

    /// Whether `logged_in` articles open (a verified email).
    #[must_use]
    pub fn signed_in(&self) -> bool {
        self.verified_email.is_some()
    }
}

/// `jsonb_array_elements_text` of a jsonb column, `[]` when it holds no array.
fn text_elements(column: &str) -> String {
    format!(
        "jsonb_array_elements_text(case when jsonb_typeof({column}) = 'array' then {column} else '[]'::jsonb end)"
    )
}

/// `deskCompanyIdsForEmail(db, email)`.
pub async fn company_ids_for_email(db: &PgPool, email: &str) -> Result<Vec<String>, sqlx::Error> {
    let address = normalize_email(email);
    if address.is_empty() {
        return Ok(Vec::new());
    }
    let alternates = text_elements("p.alternate_emails");
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select distinct pc.company_id from person_companies pc
         join people p on p.id = pc.person_id
         join companies co on co.id = pc.company_id
         where p.deleted_at is null and co.deleted_at is null
           and (pc.ended_at is null or pc.ended_at > now())
           and (lower(p.email) = $1 or exists (select 1 from {alternates} as alt(v) where lower(alt.v) = $1))
         order by pc.company_id"
    )))
    .bind(&address)
    .fetch_all(db)
    .await
}

/// `deskReaderOf(db, principal)`: anonymous without a verified email.
pub async fn reader_of(db: &PgPool, verified_email: Option<&str>) -> Result<Reader, sqlx::Error> {
    let Some(email) = verified_email
        .map(normalize_email)
        .filter(|email| !email.is_empty())
    else {
        return Ok(Reader::anonymous());
    };
    let company_ids = company_ids_for_email(db, &email).await?;
    Ok(Reader {
        verified_email: Some(email),
        company_ids,
    })
}

/// `audienceMatches(column, reader)`, with the reader's companies at `$ids`.
fn audience_sql(column: &str, ids: usize) -> String {
    let elements = text_elements(column);
    format!("exists (select 1 from {elements} as aud(v) where aud.v = any(${ids}::text[]))")
}

/// `deskArticleVisibleTo(alias, reader)`: `$signed` is [`Reader::signed_in`],
/// `$ids` the reader's companies.
#[must_use]
pub fn visible_sql(alias: &str, signed: usize, ids: usize) -> String {
    let audience = audience_sql(&format!("{alias}.audience_company_ids"), ids);
    format!(
        "({alias}.visibility = 'public' or (${signed}::boolean and {alias}.visibility = 'logged_in') or ({alias}.visibility = 'groups' and {audience}))"
    )
}

/// `deskArticleLiveFor(alias, reader)`: published, not deleted, readable.
#[must_use]
pub fn live_sql(alias: &str, signed: usize, ids: usize) -> String {
    let visible = visible_sql(alias, signed, ids);
    format!("({alias}.status = 'published' and {alias}.deleted_at is null and {visible})")
}

/// `DeskArticleSearch`: `websearch_to_tsquery` text (none for related text)
/// and a `to_tsquery` expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Search {
    pub websearch: Option<String>,
    pub tsquery: String,
}

/// `/[\p{L}\p{N}]+/gu`: the same Unicode categories as the TypeScript.
static WORD: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}]+").expect("valid word pattern"));

/// `deskSearchWords(text)`: runs of letters and digits, lower-cased.
#[must_use]
pub fn search_words(text: &str) -> Vec<String> {
    WORD.find_iter(&text.to_lowercase())
        .map(|word| word.as_str().to_owned())
        .collect()
}

/// `deskTypedSearch(text)`: the trimmed text (200 characters at most) for
/// `websearch_to_tsquery`, OR its first eight words with the last a prefix.
/// `None` without words.
#[must_use]
pub fn typed_search(text: &str) -> Option<Search> {
    let term: String = weldsuite_kit::validation::js_trim(text)
        .chars()
        .take(200)
        .collect();
    let words: Vec<String> = search_words(&term).into_iter().take(8).collect();
    let last = words.len().checked_sub(1)?;
    let tsquery = words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            if i == last {
                format!("'{word}':*")
            } else {
                format!("'{word}'")
            }
        })
        .collect::<Vec<_>>()
        .join(" & ");
    Some(Search {
        websearch: Some(term),
        tsquery,
    })
}

/// `deskRelatedSearch(text)`: an OR of its distinct words of four
/// characters or more, at most twelve, in order. `None` without any.
#[must_use]
pub fn related_search(text: &str) -> Option<Search> {
    let mut words: Vec<String> = Vec::new();
    for word in search_words(text) {
        if word.chars().count() < 4 || words.contains(&word) {
            continue;
        }
        words.push(word);
        if words.len() == 12 {
            break;
        }
    }
    if words.is_empty() {
        return None;
    }
    let tsquery = words
        .iter()
        .map(|word| format!("'{word}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    Some(Search {
        websearch: None,
        tsquery,
    })
}

/// `deskSuggestSearch(text)`: what a customer is writing before they send a
/// request. An OR of its distinct words of four characters or more, at most
/// twelve, in order, the one still being typed (the text ends on it) as a
/// prefix; as typed when every word is short.
#[must_use]
pub fn suggest_search(text: &str) -> Option<Search> {
    let term: String = weldsuite_kit::validation::js_trim(text)
        .chars()
        .take(200)
        .collect();
    let all = search_words(&term);
    let mut words: Vec<String> = Vec::new();
    for word in &all {
        if word.chars().count() < 4 || words.contains(word) {
            continue;
        }
        words.push(word.clone());
        if words.len() == 12 {
            break;
        }
    }
    if words.is_empty() {
        return typed_search(&term);
    }
    // `/[\p{L}\p{N}]$/u`: the text ends inside a word.
    let mut end = [0u8; 4];
    let typing = term
        .chars()
        .next_back()
        .filter(|c| WORD.is_match(c.encode_utf8(&mut end)))
        .and_then(|_| all.last());
    let last = words.len() - 1;
    let tsquery = words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            if i == last && Some(word) == typing {
                format!("'{word}':*")
            } else {
                format!("'{word}'")
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");
    Some(Search {
        websearch: None,
        tsquery,
    })
}

/// `deskArticleQuery(search)`, with [`Search::websearch`] at `$w` and
/// [`Search::tsquery`] at `$q`.
#[must_use]
pub fn query_sql(w: usize, q: usize) -> String {
    format!(
        "(case when ${w}::text is null then to_tsquery('simple', ${q}::text) else (websearch_to_tsquery('simple', ${w}::text) || to_tsquery('simple', ${q}::text)) end)"
    )
}

/// `deskArticleDocument(alias)`.
#[must_use]
pub fn document_sql(alias: &str) -> String {
    format!(
        "(setweight(to_tsvector('simple', coalesce({alias}.title, '')), 'A') || setweight(to_tsvector('simple', coalesce({alias}.excerpt, '')), 'B') || setweight(to_tsvector('simple', regexp_replace(coalesce({alias}.content, ''), '<[^>]*>', ' ', 'g')), 'C'))"
    )
}

/// `deskArticleMatches(alias, search)`.
#[must_use]
pub fn matches_sql(alias: &str, w: usize, q: usize) -> String {
    format!("{} @@ {}", document_sql(alias), query_sql(w, q))
}

/// `deskArticleRank(alias, search)`.
#[must_use]
pub fn rank_sql(alias: &str, w: usize, q: usize) -> String {
    format!("ts_rank({}, {})", document_sql(alias), query_sql(w, q))
}

/// `normalizeDeskLocale(locale)`: trimmed, lower case, `None` when empty.
#[must_use]
pub fn normalize_locale(locale: Option<&str>) -> Option<String> {
    let value = weldsuite_kit::validation::js_trim(locale?).to_lowercase();
    (!value.is_empty()).then_some(value)
}

/// `deskArticleSlug(input)`: lower case, each run of anything but
/// `[a-z0-9]` one dash, none at either end, at most 500 characters.
#[must_use]
pub fn article_slug(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let out = out.strip_prefix('-').unwrap_or(&out);
    let out = out.strip_suffix('-').unwrap_or(out);
    out.chars().take(500).collect()
}

/// `deskDisplayedArticleIds(reader, locale, folderId)`: per readable
/// published original (in folder `$folder` when set), its readable published
/// version in `$locale`, else the original.
#[must_use]
pub fn displayed_ids_sql(signed: usize, ids: usize, locale: usize, folder: usize) -> String {
    let live_x = live_sql("x", signed, ids);
    let live_o = live_sql("o", signed, ids);
    format!(
        "(select coalesce((select x.id from helpdesk_articles x where x.translation_of_id = o.id and x.locale = ${locale}::text and {live_x} order by x.created_at asc, x.id asc limit 1), o.id)
          from helpdesk_articles o where o.translation_of_id is null and {live_o} and (${folder}::text is null or o.category_id = ${folder}::text))"
    )
}

/// `deskArticleFolderId`: the folder an article row (`t`) is listed under,
/// its original's.
pub const FOLDER_ID_SQL: &str = "coalesce((select o.category_id from helpdesk_articles o where o.id = t.translation_of_id), t.category_id)";

/// `deskHelpCenterBaseUrl(db)`: `https://<host>` of the live help center,
/// custom domain first; `None` when it is off or has no domain.
pub async fn help_center_base_url(db: &PgPool) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<i32>, Option<String>, Option<String>)> = sqlx::query_as(
        "select is_enabled, default_subdomain, custom_domain from helpcenter_settings
         where deleted_at is null order by created_at asc, id asc limit 1",
    )
    .fetch_optional(db)
    .await?;
    let Some((Some(1), subdomain, custom)) = row else {
        return Ok(None);
    };
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(weldsuite_kit::validation::js_trim)
            .filter(|host| !host.is_empty())
            .map(str::to_owned)
    };
    let host = trimmed(&custom)
        .or_else(|| trimmed(&subdomain))
        .map(|host| host.to_lowercase());
    Ok(host.map(|host| format!("https://{host}")))
}

/// `deskArticleUrl(baseUrl, slug)`.
#[must_use]
pub fn article_url(base: Option<&str>, slug: &str) -> Value {
    base.map_or(Value::Null, |base| json!(format!("{base}/articles/{slug}")))
}

/// `searchDeskArticlesFor(db, reader, search, { locale, limit })`: the
/// displayed versions that match, best first, as `{ id, title, slug,
/// excerpt, url }`.
pub async fn search_for_reader(
    db: &PgPool,
    reader: &Reader,
    search: &Search,
    locale: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let displayed = displayed_ids_sql(1, 2, 3, 4);
    let matches = matches_sql("t", 5, 6);
    let rank = rank_sql("t", 5, 6);
    let rows: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select t.id, t.title, t.slug, t.excerpt from helpdesk_articles t
         where t.id in {displayed} and {matches}
         order by {rank} desc, t.updated_at desc, t.id desc limit $7"
        )))
        .bind(reader.signed_in())
        .bind(&reader.company_ids)
        .bind(locale)
        .bind(None::<String>)
        .bind(search.websearch.as_deref())
        .bind(&search.tsquery)
        .bind(limit)
        .fetch_all(db)
        .await?;
    let base = help_center_base_url(db).await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, slug, excerpt)| {
            let url = article_url(base.as_deref(), &slug);
            json!({ "id": id, "title": title, "slug": slug, "excerpt": excerpt, "url": url })
        })
        .collect())
}

fn iso(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |text| json!(js_date(text)))
}

/// `listDeskAnnouncementsFor(db, reader)`: published, started, unexpired
/// announcements the reader may see, pinned first, newest first, at most 20.
pub async fn announcements_for(db: &PgPool, reader: &Reader) -> Result<Vec<Value>, sqlx::Error> {
    let audience = audience_sql("a.target_groups", 1);
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(a) from helpdesk_announcements a
         where a.deleted_at is null and a.status = 'published'
           and (a.published_at is null or a.published_at <= now())
           and (a.expires_at is null or a.expires_at > now())
           and (a.visibility = 'public' or (a.visibility = 'specific_groups' and {audience}))
         order by coalesce(a.is_pinned, false) desc, a.published_at desc nulls last, a.created_at desc, a.id desc
         limit 20"
    )))
    .bind(&reader.company_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|a| {
            json!({
                "id": a["id"], "title": a["title"], "content": a["content"], "excerpt": a["excerpt"],
                "type": a["type"], "isPinned": a["is_pinned"] == Value::Bool(true),
                "publishedAt": iso(&a["published_at"]), "expiresAt": iso(&a["expires_at"]),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_runs_of_letters_and_digits() {
        assert_eq!(
            search_words("Can't log-in? Café №5 日本語"),
            ["can", "t", "log", "in", "café", "5", "日本語"]
        );
    }

    #[test]
    fn a_typed_query_ors_its_words_with_a_prefix() {
        assert_eq!(
            typed_search("  Reset pass "),
            Some(Search {
                websearch: Some("Reset pass".to_owned()),
                tsquery: "'reset' & 'pass':*".to_owned()
            })
        );
        assert_eq!(
            typed_search("a b c d e f g h i j").map(|s| s.tsquery),
            Some("'a' & 'b' & 'c' & 'd' & 'e' & 'f' & 'g' & 'h':*".to_owned())
        );
        assert_eq!(typed_search(""), None);
        assert_eq!(typed_search(" ?! "), None);
    }

    #[test]
    fn related_text_ors_its_longer_words() {
        assert_eq!(
            related_search("How do I reset my PASSWORD? Reset it please").map(|s| s.tsquery),
            Some("'reset' | 'password' | 'please'".to_owned())
        );
        let many: Vec<String> = (0..20).map(|i| format!("word{i}")).collect();
        assert_eq!(
            related_search(&many.join(" ")).map(|s| s.tsquery.split(" | ").count()),
            Some(12)
        );
        assert_eq!(related_search("hi to me"), None);
    }

    #[test]
    fn a_question_suggests_on_any_of_its_longer_words() {
        assert_eq!(
            suggest_search("How do I reset my password"),
            Some(Search {
                websearch: None,
                tsquery: "'reset' | 'password':*".to_owned()
            })
        );
        let tsquery = |text: &str| suggest_search(text).map(|s| s.tsquery);
        assert_eq!(
            tsquery("How do I reset my password? "),
            Some("'reset' | 'password'".to_owned())
        );
        assert_eq!(
            tsquery("reset password for my vpn"),
            Some("'reset' | 'password'".to_owned())
        );
        assert_eq!(
            tsquery("password reset password"),
            Some("'password' | 'reset'".to_owned())
        );
        let many: Vec<String> = (0..20).map(|i| format!("word{i}")).collect();
        let capped = tsquery(&many.join(" ")).unwrap_or_default();
        assert_eq!(capped.split(" | ").count(), 12);
        assert!(!capped.contains(":*"));
    }

    #[test]
    fn short_words_suggest_as_typed() {
        assert_eq!(
            suggest_search("vpn 2fa"),
            Some(Search {
                websearch: Some("vpn 2fa".to_owned()),
                tsquery: "'vpn' & '2fa':*".to_owned()
            })
        );
        assert_eq!(suggest_search(" ?! "), None);
    }

    #[test]
    fn slugs_locales_and_links() {
        assert_eq!(article_slug("  Hello, World! Ça va?  "), "hello-world-a-va");
        assert_eq!(normalize_locale(Some(" PT-BR ")), Some("pt-br".to_owned()));
        assert_eq!(normalize_locale(Some("")), None);
        assert_eq!(
            article_url(Some("https://help.acme.test"), "reset"),
            json!("https://help.acme.test/articles/reset")
        );
        assert_eq!(article_url(None, "reset"), Value::Null);
    }
}
