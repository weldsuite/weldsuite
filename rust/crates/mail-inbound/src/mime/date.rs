//! `new Date(string)` as V8 reads a `Date` header (`src/date/dateparser`):
//! the ES5 ISO format, else the legacy parser that takes RFC 2822 dates and
//! their many variants. A date without a zone is local time, which is UTC on
//! a worker and in the cluster.

/// What one token of the legacy parser is.
#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number { value: i64, length: usize },
    Word(String),
    Symbol(char),
    Space,
    Unknown,
    End,
}

struct Scanner {
    tokens: Vec<Token>,
    at: usize,
}

impl Scanner {
    fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut tokens = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c.is_ascii_digit() {
                let start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                let digits: String = chars[start..i].iter().collect();
                tokens.push(Token::Number {
                    value: digits.parse::<i64>().unwrap_or(i64::MAX),
                    length: i - start,
                });
            } else if c.is_alphabetic() {
                let start = i;
                while i < chars.len() && chars[i].is_alphabetic() {
                    i += 1;
                }
                tokens.push(Token::Word(
                    chars[start..i].iter().collect::<String>().to_lowercase(),
                ));
            } else if c == '(' {
                let mut depth = 0i32;
                loop {
                    match chars.get(i) {
                        Some('(') => depth += 1,
                        Some(')') => depth -= 1,
                        None => break,
                        _ => {}
                    }
                    i += 1;
                    if depth <= 0 {
                        break;
                    }
                }
                tokens.push(Token::Unknown);
            } else if super::decode::is_js_space(c) {
                while i < chars.len() && super::decode::is_js_space(chars[i]) {
                    i += 1;
                }
                tokens.push(Token::Space);
            } else {
                tokens.push(Token::Symbol(c));
                i += 1;
            }
        }
        Self { tokens, at: 0 }
    }

    fn next(&mut self) -> Token {
        let token = self.peek();
        if self.at < self.tokens.len() {
            self.at += 1;
        }
        token
    }

    fn peek(&self) -> Token {
        self.tokens.get(self.at).cloned().unwrap_or(Token::End)
    }

    fn skip_symbol(&mut self, symbol: char) -> bool {
        if self.peek() == Token::Symbol(symbol) {
            self.at += 1;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Month(i64),
    AmPm(i64),
    Zone(i64),
    TimeSeparator,
}

/// `KeywordTable::Lookup`: the first three letters decide; only month
/// names may be longer.
fn keyword(word: &str) -> Option<Keyword> {
    let prefix: String = word.chars().take(3).collect();
    let long = word.chars().count() > 3;
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    if let Some(index) = months.iter().position(|m| *m == prefix) {
        return Some(Keyword::Month(i64::try_from(index).unwrap_or(0) + 1));
    }
    if long {
        return None;
    }
    Some(match prefix.as_str() {
        "am" => Keyword::AmPm(0),
        "pm" => Keyword::AmPm(12),
        "ut" | "utc" | "z" | "gmt" => Keyword::Zone(0),
        "cdt" | "est" => Keyword::Zone(-5),
        "cst" | "mdt" => Keyword::Zone(-6),
        "edt" => Keyword::Zone(-4),
        "mst" | "pdt" => Keyword::Zone(-7),
        "pst" => Keyword::Zone(-8),
        "t" => Keyword::TimeSeparator,
        _ => return None,
    })
}

#[derive(Default)]
struct Time {
    comp: Vec<i64>,
    hour_offset: Option<i64>,
}

impl Time {
    fn is_empty(&self) -> bool {
        self.comp.is_empty()
    }

    fn is_expecting(&self, n: i64) -> bool {
        match self.comp.len() {
            1 | 2 => (0..=59).contains(&n),
            3 => (0..=999).contains(&n),
            _ => false,
        }
    }

    fn add(&mut self, n: i64) -> bool {
        if self.comp.len() < 4 {
            self.comp.push(n);
            true
        } else {
            false
        }
    }

    /// `AddFinal(n)`: the rest of the slots are 0.
    fn add_final(&mut self, n: i64) {
        self.add(n);
        while self.comp.len() < 4 {
            self.comp.push(0);
        }
    }

    fn write(&self) -> Option<i64> {
        let get = |i: usize| self.comp.get(i).copied().unwrap_or(0);
        let mut hour = get(0);
        let (minute, second, millisecond) = (get(1), get(2), get(3));
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&hour) {
                return None;
            }
            hour %= 12;
            hour += offset;
        }
        let valid = (0..=23).contains(&hour)
            && (0..=59).contains(&minute)
            && (0..=59).contains(&second)
            && (0..=999).contains(&millisecond);
        if !valid && (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
            return None;
        }
        Some(((hour * 60 + minute) * 60 + second) * 1000 + millisecond)
    }
}

#[derive(Default)]
struct Zone {
    sign: Option<i64>,
    hour: Option<i64>,
    minute: Option<i64>,
}

impl Zone {
    fn set(&mut self, offset_hours: i64) {
        self.sign = Some(if offset_hours < 0 { -1 } else { 1 });
        self.hour = Some(offset_hours.abs());
        self.minute = Some(0);
    }

    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }

    fn is_expecting(&self, n: i64) -> bool {
        self.hour.is_some() && self.minute.is_none() && (0..=59).contains(&n)
    }

    /// The offset in milliseconds, `None` for local time.
    fn write(&self) -> Option<i64> {
        let sign = self.sign?;
        let hour = self.hour.unwrap_or(0);
        let minute = self.minute.unwrap_or(0);
        Some(sign * (hour * 3600 + minute * 60) * 1000)
    }
}

#[derive(Default)]
struct Day {
    comp: Vec<i64>,
    named_month: Option<i64>,
}

impl Day {
    fn add(&mut self, n: i64) -> bool {
        if self.comp.len() < 3 {
            self.comp.push(n);
            true
        } else {
            false
        }
    }

    fn write(&self) -> Option<(i64, i64, i64)> {
        if self.comp.is_empty() {
            return None;
        }
        // Day and month default to 1, and V8 counts the defaults as written
        // (`new Date('Oct 29')` is in 2001).
        let mut comp = self.comp.clone();
        while comp.len() < 3 {
            comp.push(1);
        }
        let is_day = |x: i64| (1..=31).contains(&x);
        let (mut year, month, day) = match self.named_month {
            None if !is_day(comp[0]) => (comp[0], comp[1], comp[2]),
            None => (comp[2], comp[0], comp[1]),
            Some(month) if !is_day(comp[0]) => (comp[0], month, comp[1]),
            Some(month) => (comp[1], month, comp[0]),
        };
        if (0..=49).contains(&year) {
            year += 2000;
        } else if (50..=99).contains(&year) {
            year += 1900;
        }
        if !(1..=12).contains(&month) || !is_day(day) {
            return None;
        }
        Some((year, month, day))
    }
}

/// Days from 1970-01-01 to the first of `month` (1-based, may overflow
/// into the next years as `MakeDay` lets it) plus `day - 1`.
fn make_day(year: i64, month: i64, day: i64) -> i64 {
    let year = year + (month - 1).div_euclid(12);
    let month = (month - 1).rem_euclid(12) + 1;
    // Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + day - 1
}

/// The ES5 format: `YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:mm]]`.
fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (year, mut at) = match b.first()? {
        b'+' | b'-' => {
            let y = num(1, 6)?;
            (if b[0] == b'-' { -y } else { y }, 7)
        }
        _ => (num(0, 4)?, 4),
    };
    let mut month = 1;
    let mut day = 1;
    if b.get(at) == Some(&b'-') {
        month = num(at + 1, 2)?;
        at += 3;
        if b.get(at) == Some(&b'-') {
            day = num(at + 1, 2)?;
            at += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let date = make_day(year, month, day) * 86_400_000;
    if at == b.len() {
        return Some(date);
    }
    if b.get(at) != Some(&b'T') {
        return None;
    }
    let hour = num(at + 1, 2)?;
    if b.get(at + 3) != Some(&b':') {
        return None;
    }
    let minute = num(at + 4, 2)?;
    at += 6;
    let mut second = 0;
    let mut ms = 0;
    if b.get(at) == Some(&b':') {
        second = num(at + 1, 2)?;
        at += 3;
        if b.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let digits = &text[start..end.min(start + 3)];
            ms = digits.parse::<i64>().ok()? * 10_i64.pow(3 - u32::try_from(digits.len()).ok()?);
            at = end;
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute | second | ms) != 0) {
        return None;
    }
    let time = ((hour * 60 + minute) * 60 + second) * 1000 + ms;
    let offset = match b.get(at) {
        None => 0,
        Some(b'Z') if at + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if at + 6 == b.len() && b[at + 3] == b':' => {
            let h = num(at + 1, 2)?;
            let m = num(at + 4, 2)?;
            let total = (h * 60 + m) * 60_000;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    Some(date + time - offset)
}

/// `Date.parse(text)` in milliseconds since the epoch, `None` for an
/// invalid date.
#[allow(clippy::too_many_lines)] // V8's loop, token by token
pub(crate) fn parse_date(text: &str) -> Option<i64> {
    let text = super::decode::js_trim(text);
    let ms = if let Some(ms) = parse_iso(text) {
        ms
    } else {
        let mut scanner = Scanner::new(text);
        let mut day = Day::default();
        let mut time = Time::default();
        let mut zone = Zone::default();
        let mut has_read_number = false;
        loop {
            let token = scanner.next();
            match token {
                Token::End => break,
                Token::Number { value: n, .. } => {
                    has_read_number = true;
                    if scanner.skip_symbol(':') {
                        if scanner.skip_symbol(':') {
                            if !time.is_empty() {
                                return None;
                            }
                            time.add(n);
                            time.add(0);
                        } else {
                            if !time.add(n) {
                                return None;
                            }
                            if scanner.peek() == Token::Symbol('.') {
                                scanner.next();
                            }
                        }
                    } else if scanner.peek() == Token::Symbol('.') && time.is_expecting(n) {
                        scanner.next();
                        time.add(n);
                        let Token::Number { value, length } = scanner.next() else {
                            return None;
                        };
                        // `ReadMilliseconds`: the first three digits.
                        let ms = match length {
                            1 => value * 100,
                            2 => value * 10,
                            3 => value,
                            _ => value
                                .to_string()
                                .get(..3)
                                .and_then(|d| d.parse().ok())
                                .unwrap_or(0),
                        };
                        time.add_final(ms);
                    } else if zone.is_expecting(n) {
                        zone.minute = Some(n);
                    } else if time.is_expecting(n) {
                        time.add_final(n);
                        match scanner.peek() {
                            Token::End | Token::Space | Token::Symbol('+' | '-') => {}
                            Token::Word(w) if w == "z" => {}
                            _ => return None,
                        }
                    } else {
                        if !day.add(n) {
                            return None;
                        }
                        scanner.skip_symbol('-');
                    }
                }
                Token::Word(word) => match keyword(&word) {
                    Some(Keyword::AmPm(offset)) if !time.is_empty() => {
                        time.hour_offset = Some(offset);
                    }
                    Some(Keyword::Month(month)) => {
                        day.named_month = Some(month);
                        scanner.skip_symbol('-');
                    }
                    Some(Keyword::Zone(hours)) if has_read_number => zone.set(hours),
                    _ => {
                        if has_read_number {
                            return None;
                        }
                        if matches!(scanner.peek(), Token::Number { .. }) {
                            return None;
                        }
                    }
                },
                Token::Symbol(sign @ ('+' | '-')) if zone.is_utc() || !time.is_empty() => {
                    zone.sign = Some(if sign == '-' { -1 } else { 1 });
                    let (n, length) = match scanner.peek() {
                        Token::Number { value, length } => {
                            scanner.next();
                            (value, length)
                        }
                        _ => (0, 0),
                    };
                    has_read_number = true;
                    if scanner.peek() == Token::Symbol(':') {
                        zone.hour = Some(n);
                        zone.minute = None;
                    } else if length == 1 || length == 2 {
                        zone.hour = Some(n);
                        zone.minute = Some(0);
                    } else if length == 3 || length == 4 {
                        zone.hour = Some(n / 100);
                        zone.minute = Some(n % 100);
                    } else {
                        return None;
                    }
                }
                Token::Symbol('+' | '-' | ')') if has_read_number => return None,
                _ => {}
            }
        }
        let (year, month, d) = day.write()?;
        let time = time.write()?;
        let offset = zone.write().unwrap_or(0);
        make_day(year, month, d) * 86_400_000 + time - offset
    };
    (ms.abs() <= 8_640_000_000_000_000).then_some(ms)
}

/// `Date.prototype.toISOString()`.
pub(crate) fn to_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(text: &str) -> Option<String> {
        parse_date(text).map(to_iso)
    }

    #[test]
    fn rfc2822_dates() {
        assert_eq!(
            iso("Tue, 29 Oct 2026 12:00:00 +0100").as_deref(),
            Some("2026-10-29T11:00:00.000Z")
        );
        assert_eq!(
            iso("29 Oct 2026 12:00:00 -0700 (PDT)").as_deref(),
            Some("2026-10-29T19:00:00.000Z")
        );
        assert_eq!(
            iso("Thu, 1 Jan 2026 00:00 GMT").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("Mon, 2 Feb 26 09:30:15 EST").as_deref(),
            Some("2026-02-02T14:30:15.000Z")
        );
        assert_eq!(iso("Mon, 29 Oct 2026 12:00:00 CEST"), None);
        assert_eq!(iso("not a date"), None);
    }

    #[test]
    fn iso_dates() {
        assert_eq!(
            iso("2026-10-29T12:00:00.000Z").as_deref(),
            Some("2026-10-29T12:00:00.000Z")
        );
        assert_eq!(
            iso("2026-10-29T12:00:00+02:00").as_deref(),
            Some("2026-10-29T10:00:00.000Z")
        );
    }
}
