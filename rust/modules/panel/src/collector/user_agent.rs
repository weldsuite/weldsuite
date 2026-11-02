//! `lib/user-agent.ts`: device class, browser and OS for the standard
//! columns, plus the bot check. JavaScript's look-around (`(?<!cu)bot`,
//! `Android(?!.*Mobile)`) is written out by hand: the `regex` crate has none.

use std::sync::LazyLock;

use regex::Regex;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

/// Every alternative of `BOT_USER_AGENT` but `(?<!cu)bot`, case-insensitive.
static BOT_OTHERS: LazyLock<Regex> = LazyLock::new(|| {
    re(concat!(
        "(?i-u)crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|statuscake|gtmetrix|",
        "facebookexternalhit|bingpreview|embedly|python-requests|python-urllib|aiohttp|curl/|wget/|",
        "libwww|go-http-client|java/|apache-httpclient|axios/|node-fetch|scrapy|phantomjs|selenium|",
        "puppeteer|wkhtmltopdf"
    ))
});

/// `(?<!cu)bot`, case-insensitive: `bot` anywhere except right after `cu`
/// (the Cubot phone brand).
fn has_bot_word(user_agent: &str) -> bool {
    let lower = user_agent.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(found) = lower[from..].find("bot") {
        let at = from + found;
        let after_cu = at >= 2 && &bytes[at - 2..at] == b"cu";
        if !after_cu {
            return true;
        }
        from = at + 1;
    }
    false
}

/// `isBotUserAgent(userAgent)`.
pub(crate) fn is_bot_user_agent(user_agent: &str) -> bool {
    !user_agent.is_empty() && (has_bot_word(user_agent) || BOT_OTHERS.is_match(user_agent))
}

static BROWSERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (re(r"(?-u:\b)(?:Edg|EdgA|EdgiOS|Edge)/"), "Edge"),
        (re(r"(?-u:\b)OPR/|(?-u:\b)OPiOS/|(?-u:\b)Opera(?-u:\b)"), "Opera"),
        (re(r"SamsungBrowser/"), "Samsung Internet"),
        (re(r"(?-u:\b)Vivaldi/"), "Vivaldi"),
        (re(r"YaBrowser/"), "Yandex"),
        (re(r"DuckDuckGo/"), "DuckDuckGo"),
        (re(r"UCBrowser/|UCWEB"), "UC Browser"),
        (re(r"Firefox/|FxiOS/"), "Firefox"),
        (re(r"MSIE |Trident/"), "Internet Explorer"),
        (re(r"Chrome/|CriOS/|Chromium/"), "Chrome"),
        (re(r"Safari/|AppleWebKit/"), "Safari"),
    ]
});

static SYSTEMS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (re(r"Windows Phone|IEMobile"), "Windows Phone"),
        (re(r"Windows"), "Windows"),
        (re(r"iPhone|iPad|iPod"), "iOS"),
        (re(r"Android"), "Android"),
        (re(r"CrOS"), "ChromeOS"),
        (re(r"Mac OS X|Macintosh"), "macOS"),
        (re(r"Linux|X11|Ubuntu|Fedora|Debian"), "Linux"),
    ]
});

static TV_OR_CONSOLE: LazyLock<Regex> = LazyLock::new(|| {
    re(concat!(
        "(?i-u)SmartTV|Smart-TV|HbbTV|AppleTV|Tizen|Web0S|WebOS|NetCast|Roku|CrKey|Android TV|",
        "GoogleTV|BRAVIA|PlayStation|Xbox|Nintendo"
    ))
});
/// `TABLET` without its `Android(?!.*Mobile)` alternative.
static TABLET_OTHERS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i-u)iPad|Tablet|PlayBook|Kindle|Silk/"));
static MOBILE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i-u)iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|Mobile|Mobi(?-u:\b)")
});

/// `/Android(?!.*Mobile)/i`: an `android` with no `mobile` after it on the
/// same line (`.` stops at line terminators).
fn android_tablet(user_agent: &str) -> bool {
    let lower = user_agent.to_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("android") {
        let at = from + found;
        let rest = &lower[at + "android".len()..];
        let line = rest
            .split(['\n', '\r', '\u{2028}', '\u{2029}'])
            .next()
            .unwrap_or_default();
        if !line.contains("mobile") {
            return true;
        }
        from = at + 1;
    }
    false
}

/// `parseUserAgent(userAgent)`: device type, browser and OS.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ParsedUserAgent {
    pub(crate) device_type: Option<&'static str>,
    pub(crate) browser: Option<&'static str>,
    pub(crate) os: Option<&'static str>,
}

fn first_match(table: &[(Regex, &'static str)], user_agent: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(pattern, _)| pattern.is_match(user_agent))
        .map(|(_, name)| *name)
}

pub(crate) fn parse_user_agent(user_agent: &str) -> ParsedUserAgent {
    let browser = first_match(&BROWSERS, user_agent);
    let os = first_match(&SYSTEMS, user_agent);
    let mut device_type = None;
    if !user_agent.is_empty() && !TV_OR_CONSOLE.is_match(user_agent) {
        if TABLET_OTHERS.is_match(user_agent) || android_tablet(user_agent) {
            device_type = Some("tablet");
        } else if MOBILE.is_match(user_agent) {
            device_type = Some("mobile");
        } else if browser.is_some() || os.is_some() {
            device_type = Some("desktop");
        }
    }
    ParsedUserAgent {
        device_type,
        browser,
        os,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME_WINDOWS: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    #[test]
    fn reads_the_common_browsers() {
        assert_eq!(
            parse_user_agent(CHROME_WINDOWS),
            ParsedUserAgent {
                device_type: Some("desktop"),
                browser: Some("Chrome"),
                os: Some("Windows")
            }
        );
        let tablet = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        assert_eq!(parse_user_agent(tablet).device_type, Some("tablet"));
        let phone = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
        assert_eq!(parse_user_agent(phone).device_type, Some("mobile"));
    }

    #[test]
    fn spots_bots_but_not_cubot_phones() {
        assert!(is_bot_user_agent("Mozilla/5.0 (compatible; Googlebot/2.1)"));
        assert!(is_bot_user_agent("curl/8.4.0"));
        assert!(!is_bot_user_agent(
            "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"
        ));
        assert!(!is_bot_user_agent(CHROME_WINDOWS));
        assert!(!is_bot_user_agent(""));
    }
}
